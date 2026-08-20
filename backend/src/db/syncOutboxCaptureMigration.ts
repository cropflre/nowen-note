import type { Migration } from "./migrations.impl.js";

/**
 * v87: 本地变更捕获进 Outbox（上行链路）。
 *
 * ## 修复的问题
 *
 * v81 建了 sync_outbox，v82 建了服务端 Change Feed，Phase 4 实现了 Push 引擎，
 * 但**没有任何路径把本地业务变更写入 sync_outbox**：
 *
 *   grep enqueueMutation/withMutation（排除 src/sync/）→ 0 处调用
 *   grep "INSERT INTO sync_outbox" in src/db/          → 0 个触发器
 *
 * 结果是链路只有下行：
 *
 *   Server 变更 → sync_changes_v2 → 本机 Pull → Apply   ✅ 通
 *   本机变更   → sync_outbox（空）→ Push               ❌ 断
 *
 * Push 引擎永远取不到条目，本机修改无法到达其他设备。
 * Phase 4 的引擎测试全部用 enqueueMutation 手工造数据，所以测试全绿掩盖了断点。
 *
 * ## 为什么用触发器而不是在 REST 路由里埋点
 *
 * 与 v66 / v82 / v84 同一理由，且此处更严重：笔记会被 REST、导入、
 * Yjs 落盘、模板、副本、文件夹同步、Clipper、维护脚本改写。
 * 逐个路由调 withMutation() 必然漏，漏掉的表现是"某个入口的修改永不同步"，
 * 而本地显示一切正常，用户完全无法察觉。由数据库保证是唯一可靠的做法。
 *
 * ## 写入条件（对应阶段 C 的要求）
 *
 * 四个条件同时满足才写 Outbox：
 *
 * 1. 抑制开关关闭 —— 复用 v82 的 sync_v2_should_log。
 *    Apply 远端变更时开关为开，否则 Pull → Apply → Outbox → Push 无限回环。
 * 2. **存在启用的 SyncProfile** —— 这正是"仅此设备绝不写 Outbox"的落地点。
 *    Feature Flag 关闭时不会有 active profile（引擎不 reconcile），因此
 *    flag off 也天然不写。
 * 3. **Profile 的 bootstrap 已完成**（bootstrapStatus = 'ready'）。
 *    首次开启同步不能 replay 历史，必须先由 Bootstrap/Reconcile 建立基线；
 *    基线建立前的写入由 Bootstrap 自己处理，不能进 Outbox。
 *    该列由后续 Bootstrap 迁移添加，此处用 COALESCE 兼容尚未添加的情况。
 * 4. 仅个人空间（workspaceId IS NULL）—— Sync V2 第一版范围。
 *
 * ## deviceId 来源
 *
 * 触发器读 sync_v2_local_device 视图。安装级设备身份表由阶段 B 建立，
 * 在此之前回退到 sync_devices 里最早创建的一条 —— 这与阶段 B
 * "优先取最早创建的 deviceId 作为安装身份"的选择一致，因此阶段 B
 * 迁移后 deviceId 不会发生变化。
 *
 * ## baseVersion 语义
 *
 * note 的 upsert 必须带 baseVersion（服务端据此判冲突）。
 * 触发器在 AFTER UPDATE 中拿到的 OLD.version 正是"本次修改所基于的版本"，
 * 这恰好是 Push 需要的值。
 * 注意 Coalescing 会保留最早那条的 baseVersion，因此连续编辑不会自我比对。
 *
 * INSERT 时没有"上一版本"，baseVersion 留 NULL —— 服务端对不存在的实体
 * 不做版本检查；若实体已存在于服务端则会判冲突，这是正确的（两端各自创建了同 ID）。
 */
export const syncOutboxCaptureMigration: Migration = {
  version: 87,
  name: "sync-v2-outbox-capture",
  up: (db) => {
    // 当前启用的 Profile，且必须已完成 bootstrap。
    // bootstrapStatus 列可能尚未存在（阶段 D 才添加），用 pragma 探测后决定视图定义，
    // 避免在旧库上创建引用不存在列的视图。
    const profileCols = db.prepare("PRAGMA table_info(sync_profiles)").all() as Array<{ name: string }>;
    const hasBootstrapStatus = profileCols.some((c) => c.name === "bootstrapStatus");

    const readyCondition = hasBootstrapStatus
      ? "AND COALESCE(bootstrapStatus, 'ready') = 'ready'"
      : "";

    db.exec(`
      DROP VIEW IF EXISTS sync_v2_outbox_target;
      CREATE VIEW sync_v2_outbox_target AS
        SELECT id AS profileId FROM sync_profiles
        WHERE enabled = 1 ${readyCondition}
        ORDER BY updatedAt DESC
        LIMIT 1;
    `);

    // 本机安装级设备身份。
    // 阶段 B 会用 sync_device_identity 替换这个视图的实现，届时语义不变。
    db.exec(`
      DROP VIEW IF EXISTS sync_v2_local_device;
      CREATE VIEW sync_v2_local_device AS
        SELECT id AS deviceId FROM sync_devices
        ORDER BY createdAt ASC, rowid ASC
        LIMIT 1;
    `);

    // 统一的写入闸门：四个条件全满足才为 1。
    // 用视图承载，避免在 18 个触发器里重复同一段 WHEN 条件。
    db.exec(`
      DROP VIEW IF EXISTS sync_v2_should_enqueue;
      CREATE VIEW sync_v2_should_enqueue AS
        SELECT CASE
          WHEN (SELECT enabled FROM sync_v2_should_log) = 1
            AND (SELECT profileId FROM sync_v2_outbox_target) IS NOT NULL
            AND (SELECT deviceId FROM sync_v2_local_device) IS NOT NULL
          THEN 1 ELSE 0
        END AS enabled;
    `);

    // mutationId 必须唯一。SQLite 触发器里没有 randomUUID()，
    // 用 randomblob(16) 转 hex 生成 —— 128 位随机量，碰撞概率可忽略，
    // 且与 UUID 一样是不透明标识符，服务端只做等值比较不解析格式。
    const mutationId = `lower(hex(randomblob(16)))`;
    const profileId = `(SELECT profileId FROM sync_v2_outbox_target)`;
    const deviceId = `(SELECT deviceId FROM sync_v2_local_device)`;
    const gate = `(SELECT enabled FROM sync_v2_should_enqueue) = 1`;

    // --- notebook ---
    // payload 字段与 backend/src/sync/apply.ts applyNotebook 期望的一致。
    const notebookPayload = (ref: string) => `json_object(
      'id', ${ref}.id,
      'parentId', ${ref}.parentId,
      'name', ${ref}.name,
      'description', ${ref}.description,
      'icon', ${ref}.icon,
      'color', ${ref}.color,
      'sortOrder', ${ref}.sortOrder,
      'isExpanded', ${ref}.isExpanded,
      'isDeleted', ${ref}.isDeleted,
      'deletedAt', ${ref}.deletedAt,
      'createdAt', ${ref}.createdAt
    )`;

    db.exec(`
      DROP TRIGGER IF EXISTS sync_outbox_notebooks_insert;
      CREATE TRIGGER sync_outbox_notebooks_insert
      AFTER INSERT ON notebooks
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'notebook', NEW.id, 'upsert', NULL, ${notebookPayload("NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_notebooks_update;
      CREATE TRIGGER sync_outbox_notebooks_update
      AFTER UPDATE ON notebooks
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'notebook', NEW.id, 'upsert', NULL, ${notebookPayload("NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_notebooks_delete;
      CREATE TRIGGER sync_outbox_notebooks_delete
      BEFORE DELETE ON notebooks
      WHEN OLD.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'notebook', OLD.id, 'delete', NULL, NULL,
          'pending', 0, datetime('now')
        );
      END;
    `);

    // --- note ---
    // 唯一带 baseVersion 的实体：正文冲突必须能被检测。
    const notePayload = (ref: string) => `json_object(
      'id', ${ref}.id,
      'notebookId', ${ref}.notebookId,
      'title', ${ref}.title,
      'content', ${ref}.content,
      'contentText', ${ref}.contentText,
      'contentFormat', ${ref}.contentFormat,
      'isPinned', ${ref}.isPinned,
      'isFavorite', ${ref}.isFavorite,
      'isLocked', ${ref}.isLocked,
      'isArchived', ${ref}.isArchived,
      'isTrashed', ${ref}.isTrashed,
      'trashedAt', ${ref}.trashedAt,
      'sortOrder', ${ref}.sortOrder,
      'version', ${ref}.version,
      'createdAt', ${ref}.createdAt
    )`;

    db.exec(`
      DROP TRIGGER IF EXISTS sync_outbox_notes_insert;
      CREATE TRIGGER sync_outbox_notes_insert
      AFTER INSERT ON notes
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'note', NEW.id, 'upsert', NULL, ${notePayload("NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_notes_update;
      CREATE TRIGGER sync_outbox_notes_update
      AFTER UPDATE ON notes
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'note', NEW.id, 'upsert', OLD.version, ${notePayload("NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_notes_delete;
      CREATE TRIGGER sync_outbox_notes_delete
      BEFORE DELETE ON notes
      WHEN OLD.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'note', OLD.id, 'delete', OLD.version, NULL,
          'pending', 0, datetime('now')
        );
      END;
    `);

    // --- tag ---
    const tagPayload = (ref: string) => `json_object(
      'id', ${ref}.id,
      'name', ${ref}.name,
      'color', ${ref}.color,
      'createdAt', ${ref}.createdAt
    )`;

    db.exec(`
      DROP TRIGGER IF EXISTS sync_outbox_tags_insert;
      CREATE TRIGGER sync_outbox_tags_insert
      AFTER INSERT ON tags
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'tag', NEW.id, 'upsert', NULL, ${tagPayload("NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_tags_update;
      CREATE TRIGGER sync_outbox_tags_update
      AFTER UPDATE ON tags
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'tag', NEW.id, 'upsert', NULL, ${tagPayload("NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_tags_delete;
      CREATE TRIGGER sync_outbox_tags_delete
      BEFORE DELETE ON tags
      WHEN OLD.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'tag', OLD.id, 'delete', NULL, NULL,
          'pending', 0, datetime('now')
        );
      END;
    `);

    // --- note_tag（关系型）---
    //
    // 复合 entityId "noteId:tagId"，与 apply.ts applyNoteTag 的解析一致。
    // 关系没有独立版本，因此是确定性 upsert / delete，不参与冲突检测：
    // 同一条关系在两端各自建立时结果相同，不存在"谁覆盖谁"。
    //
    // note_tags 表本身没有 workspaceId 列，作用域由所属 note 决定。
    const noteTagScope = (ref: string) =>
      `(SELECT 1 FROM notes n WHERE n.id = ${ref}.noteId AND n.workspaceId IS NULL)`;

    db.exec(`
      DROP TRIGGER IF EXISTS sync_outbox_note_tags_insert;
      CREATE TRIGGER sync_outbox_note_tags_insert
      AFTER INSERT ON note_tags
      WHEN ${gate} AND ${noteTagScope("NEW")} IS NOT NULL
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'note_tag', NEW.noteId || ':' || NEW.tagId, 'upsert', NULL,
          json_object('noteId', NEW.noteId, 'tagId', NEW.tagId),
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_note_tags_delete;
      CREATE TRIGGER sync_outbox_note_tags_delete
      BEFORE DELETE ON note_tags
      WHEN ${gate} AND ${noteTagScope("OLD")} IS NOT NULL
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'note_tag', OLD.noteId || ':' || OLD.tagId, 'delete', NULL, NULL,
          'pending', 0, datetime('now')
        );
      END;
    `);

    // --- favorite（集合型）---
    // 与 note_tag 同理：确定性 ID，无版本冲突。
    db.exec(`
      DROP TRIGGER IF EXISTS sync_outbox_favorites_insert;
      CREATE TRIGGER sync_outbox_favorites_insert
      AFTER INSERT ON favorites
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'favorite', NEW.userId || ':' || NEW.noteId, 'upsert', NULL,
          json_object('noteId', NEW.noteId),
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_favorites_delete;
      CREATE TRIGGER sync_outbox_favorites_delete
      BEFORE DELETE ON favorites
      WHEN OLD.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'favorite', OLD.userId || ':' || OLD.noteId, 'delete', NULL, NULL,
          'pending', 0, datetime('now')
        );
      END;
    `);

    // --- attachment（仅元数据）---
    //
    // 二进制走独立上传通道（Phase 9 的 attachment_sync_state）。
    // 这里只同步元数据，且**绝不回传 path** —— 那是服务器本机文件系统路径，
    // 对其他设备没有意义，泄漏出去还会暴露服务器目录结构。
    const attachmentPayload = (ref: string) => `json_object(
      'id', ${ref}.id,
      'noteId', ${ref}.noteId,
      'filename', ${ref}.filename,
      'mimeType', ${ref}.mimeType,
      'size', ${ref}.size,
      'hash', ${ref}.hash
    )`;

    db.exec(`
      DROP TRIGGER IF EXISTS sync_outbox_attachments_insert;
      CREATE TRIGGER sync_outbox_attachments_insert
      AFTER INSERT ON attachments
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'attachment', NEW.id, 'upsert', NULL, ${attachmentPayload("NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_attachments_update;
      CREATE TRIGGER sync_outbox_attachments_update
      AFTER UPDATE ON attachments
      WHEN NEW.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'attachment', NEW.id, 'upsert', NULL, ${attachmentPayload("NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_attachments_delete;
      CREATE TRIGGER sync_outbox_attachments_delete
      BEFORE DELETE ON attachments
      WHEN OLD.workspaceId IS NULL AND ${gate}
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          ${mutationId}, ${mutationId}, ${profileId}, ${deviceId},
          'attachment', OLD.id, 'delete', NULL, NULL,
          'pending', 0, datetime('now')
        );
      END;
    `);
  },
};
