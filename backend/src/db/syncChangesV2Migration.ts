import type { Migration } from "./migrations.impl.js";

/**
 * v82: Sync V2 通用 Change Feed。
 *
 * 与 v66 的 offline_sync_changes 并存，互不干扰：
 * - offline_sync_changes 仍服务已发布客户端的 Offline Sync V1，一个字都不改；
 * - sync_changes_v2 覆盖第一版全部六类实体，未来可继续扩展
 *   task / diary / mindmap / workspace。
 *
 * 为什么继续用 DB Trigger 而不是在 REST 路由里手动 enqueue：
 * 笔记会被 REST、导入任务、Yjs 落盘、维护脚本、未来的 repository 改写，
 * 逐个路由埋点必然漏。触发器保证每一次已提交的写入都出现在 feed 里。
 * v66 已经验证了这条路可行，这里沿用同一思路。
 *
 * 与 v66 的关键差别：
 * - v66 把 favorite / note_tag 折算成 note 的 upsert（因为它只需要让客户端
 *   重新拉整篇笔记）；V2 需要精确的实体粒度来做双向同步与冲突定位，
 *   因此各实体独立记录；
 * - 增加 suppressed 判定：应用远端变更时不产生新的本地记录，避免同步回环。
 *   SQLite 触发器无法读进程状态，所以用一张开关表让 apply 路径临时置位。
 */
export const syncChangesV2Migration: Migration = {
  version: 82,
  name: "sync-v2-change-feed",
  up: (db) => {
    db.exec(`
      -- 变更事实来源。sequence 单调递增，客户端仅凭它即可增量对账。
      CREATE TABLE IF NOT EXISTS sync_changes_v2 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        entityType TEXT NOT NULL CHECK (
          entityType IN ('notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment')
        ),
        entityId TEXT NOT NULL,
        -- 关系型实体（note_tag / favorite / attachment）挂靠的笔记，
        -- 便于客户端按笔记聚合应用。
        noteId TEXT,
        userId TEXT NOT NULL,
        -- 第一版只同步个人空间（workspaceId IS NULL）；
        -- 保留该列使 Workspace 接入时无需再改表。
        workspaceId TEXT,
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        version INTEGER,
        changedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sync_changes_v2_user_sequence
        ON sync_changes_v2(userId, sequence);
      CREATE INDEX IF NOT EXISTS idx_sync_changes_v2_scope_sequence
        ON sync_changes_v2(workspaceId, sequence);
      CREATE INDEX IF NOT EXISTS idx_sync_changes_v2_entity
        ON sync_changes_v2(entityType, entityId, sequence);
      CREATE INDEX IF NOT EXISTS idx_sync_changes_v2_time
        ON sync_changes_v2(changedAt);

      -- 服务端的幂等台账：Push 请求超时后客户端会重发同一个 mutationId，
      -- 必须只生效一次。resultVersion 让重发能返回与首次一致的语义。
      CREATE TABLE IF NOT EXISTS sync_v2_applied_mutations (
        mutationId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        entityType TEXT NOT NULL,
        entityId TEXT NOT NULL,
        operation TEXT NOT NULL,
        resultVersion INTEGER,
        appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sync_v2_applied_user_device
        ON sync_v2_applied_mutations(userId, deviceId, appliedAt);

      -- 客户端游标（服务端侧记录，用于 ACK 与陈旧客户端清理）。
      CREATE TABLE IF NOT EXISTS sync_v2_clients (
        deviceId TEXT NOT NULL,
        userId TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        lastSequence INTEGER NOT NULL DEFAULT 0,
        lastSeenAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (deviceId, userId, scopeKey)
      );

      CREATE INDEX IF NOT EXISTS idx_sync_v2_clients_seen
        ON sync_v2_clients(lastSeenAt);

      -- 抑制开关。
      --
      -- 触发器跑在 SQLite 内部，读不到 Node 进程里的 AsyncLocalStorage，
      -- 因此 apply 远端变更时需要在同一事务里把这张表置为 1，
      -- 让触发器跳过记录，提交后复位。单行表（id 恒为 1）便于原子读写。
      CREATE TABLE IF NOT EXISTS sync_v2_suppression (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        suppressed INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO sync_v2_suppression (id, suppressed) VALUES (1, 0);
    `);

    // 触发器统一通过 sync_v2_should_log 判定是否记录：
    // 1) 抑制开关关闭；2) 仅个人空间（workspaceId IS NULL）。
    // 用视图承载判定，避免在 12 个触发器里重复同一段 WHEN 条件。
    db.exec(`
      DROP VIEW IF EXISTS sync_v2_should_log;
      CREATE VIEW sync_v2_should_log AS
        SELECT CASE WHEN suppressed = 0 THEN 1 ELSE 0 END AS enabled
        FROM sync_v2_suppression WHERE id = 1;
    `);

    // 触发器安装委托给 installSyncChangesV2Triggers()，
    // 供 v90 重建 sync_changes_v2 后装回（DROP TABLE 会让触发器悬空）。
    installSyncChangesV2Triggers(db);
  },
};


/**
 * 安装（或重建）Change Feed 的核心实体触发器。
 *
 * 抽成独立函数供 v90 复用：v90 需要重建 sync_changes_v2 以扩展
 * entityType 的 CHECK 约束，而 DROP TABLE 会让这些触发器变成悬空引用
 * （之后任何笔记写入都报 "no such table: main.sync_changes_v2"）。
 *
 * 幂等：全部 DDL 带 DROP IF EXISTS，可反复执行。
 */
export function installSyncChangesV2Triggers(
  db: Parameters<Migration["up"]>[0],
): void {
    // --- notebook ---
    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_notebooks_insert;
      CREATE TRIGGER sync_v2_notebooks_insert
      AFTER INSERT ON notebooks
      WHEN NEW.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('notebook', NEW.id, NULL, NEW.userId, NEW.workspaceId, 'upsert', NULL);
      END;

      DROP TRIGGER IF EXISTS sync_v2_notebooks_update;
      CREATE TRIGGER sync_v2_notebooks_update
      AFTER UPDATE ON notebooks
      WHEN NEW.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('notebook', NEW.id, NULL, NEW.userId, NEW.workspaceId, 'upsert', NULL);
      END;

      DROP TRIGGER IF EXISTS sync_v2_notebooks_delete;
      CREATE TRIGGER sync_v2_notebooks_delete
      BEFORE DELETE ON notebooks
      WHEN OLD.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('notebook', OLD.id, NULL, OLD.userId, OLD.workspaceId, 'delete', NULL);
      END;
    `);

    // --- note ---
    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_notes_insert;
      CREATE TRIGGER sync_v2_notes_insert
      AFTER INSERT ON notes
      WHEN NEW.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('note', NEW.id, NEW.id, NEW.userId, NEW.workspaceId, 'upsert', NEW.version);
      END;

      DROP TRIGGER IF EXISTS sync_v2_notes_update;
      CREATE TRIGGER sync_v2_notes_update
      AFTER UPDATE ON notes
      WHEN NEW.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('note', NEW.id, NEW.id, NEW.userId, NEW.workspaceId, 'upsert', NEW.version);
      END;

      -- 笔记被移出个人空间（转入 workspace 或换 owner）时，
      -- 必须在原作用域留下 tombstone，否则订阅原作用域的客户端会永久保留
      -- 一份已无权访问的副本。
      DROP TRIGGER IF EXISTS sync_v2_notes_scope_move;
      CREATE TRIGGER sync_v2_notes_scope_move
      AFTER UPDATE OF userId, workspaceId ON notes
      WHEN OLD.workspaceId IS NULL
        AND (OLD.userId != NEW.userId OR NEW.workspaceId IS NOT NULL)
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('note', OLD.id, OLD.id, OLD.userId, OLD.workspaceId, 'delete', OLD.version);
      END;

      DROP TRIGGER IF EXISTS sync_v2_notes_delete;
      CREATE TRIGGER sync_v2_notes_delete
      BEFORE DELETE ON notes
      WHEN OLD.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('note', OLD.id, OLD.id, OLD.userId, OLD.workspaceId, 'delete', OLD.version);
      END;
    `);

    // --- tag ---
    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_tags_insert;
      CREATE TRIGGER sync_v2_tags_insert
      AFTER INSERT ON tags
      WHEN NEW.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('tag', NEW.id, NULL, NEW.userId, NEW.workspaceId, 'upsert', NULL);
      END;

      DROP TRIGGER IF EXISTS sync_v2_tags_update;
      CREATE TRIGGER sync_v2_tags_update
      AFTER UPDATE ON tags
      WHEN NEW.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('tag', NEW.id, NULL, NEW.userId, NEW.workspaceId, 'upsert', NULL);
      END;

      DROP TRIGGER IF EXISTS sync_v2_tags_delete;
      CREATE TRIGGER sync_v2_tags_delete
      BEFORE DELETE ON tags
      WHEN OLD.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('tag', OLD.id, NULL, OLD.userId, OLD.workspaceId, 'delete', NULL);
      END;
    `);

    // --- note_tag ---
    // 关系表没有自己的 id，用 "noteId:tagId" 作为 entityId，
    // 这样客户端能精确知道是哪一条关联被加/删，而不是整篇笔记失效。
    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_note_tags_insert;
      CREATE TRIGGER sync_v2_note_tags_insert
      AFTER INSERT ON note_tags
      WHEN (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        SELECT 'note_tag', NEW.noteId || ':' || NEW.tagId, NEW.noteId,
               n.userId, n.workspaceId, 'upsert', NULL
        FROM notes n WHERE n.id = NEW.noteId AND n.workspaceId IS NULL;
      END;

      DROP TRIGGER IF EXISTS sync_v2_note_tags_delete;
      CREATE TRIGGER sync_v2_note_tags_delete
      AFTER DELETE ON note_tags
      WHEN (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        SELECT 'note_tag', OLD.noteId || ':' || OLD.tagId, OLD.noteId,
               n.userId, n.workspaceId, 'delete', NULL
        FROM notes n WHERE n.id = OLD.noteId AND n.workspaceId IS NULL;
      END;
    `);

    // --- favorite ---
    // 收藏是「用户 × 笔记」维度的，entityId 用 "userId:noteId"。
    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_favorites_insert;
      CREATE TRIGGER sync_v2_favorites_insert
      AFTER INSERT ON favorites
      WHEN NEW.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('favorite', NEW.userId || ':' || NEW.noteId, NEW.noteId,
                NEW.userId, NEW.workspaceId, 'upsert', NULL);
      END;

      DROP TRIGGER IF EXISTS sync_v2_favorites_delete;
      CREATE TRIGGER sync_v2_favorites_delete
      AFTER DELETE ON favorites
      WHEN OLD.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        VALUES ('favorite', OLD.userId || ':' || OLD.noteId, OLD.noteId,
                OLD.userId, OLD.workspaceId, 'delete', NULL);
      END;
    `);

    // --- attachment ---
    // 只同步元数据；二进制走独立的 upload / download 通道。
    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_attachments_insert;
      CREATE TRIGGER sync_v2_attachments_insert
      AFTER INSERT ON attachments
      WHEN (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        SELECT 'attachment', NEW.id, NEW.noteId, NEW.userId, n.workspaceId, 'upsert', NULL
        FROM notes n WHERE n.id = NEW.noteId AND n.workspaceId IS NULL;
      END;

      DROP TRIGGER IF EXISTS sync_v2_attachments_update;
      CREATE TRIGGER sync_v2_attachments_update
      AFTER UPDATE ON attachments
      WHEN (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        SELECT 'attachment', NEW.id, NEW.noteId, NEW.userId, n.workspaceId, 'upsert', NULL
        FROM notes n WHERE n.id = NEW.noteId AND n.workspaceId IS NULL;
      END;

      DROP TRIGGER IF EXISTS sync_v2_attachments_delete;
      CREATE TRIGGER sync_v2_attachments_delete
      BEFORE DELETE ON attachments
      WHEN (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (entityType, entityId, noteId, userId, workspaceId, operation, version)
        SELECT 'attachment', OLD.id, OLD.noteId, OLD.userId, n.workspaceId, 'delete', NULL
        FROM notes n WHERE n.id = OLD.noteId AND n.workspaceId IS NULL;
      END;
    `);
}