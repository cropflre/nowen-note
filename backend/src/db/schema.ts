import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { runMigrations, getCurrentSchemaVersion, CURRENT_SCHEMA_VERSION } from "./migrations.js";
import { enableIncrementalAutoVacuum } from "../lib/reclaimSpace.js";

const DB_PATH = process.env.DB_PATH || path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "nowen-note.db");

let db: Database.Database;

/**
 * 返回当前 SQLite 数据库文件的绝对路径。
 * 用途：
 *   - 数据管理模块导出/导入 .data 整库文件
 *   - 占用空间统计（fs.statSync）
 * 注意：返回的是**主数据库文件**路径，不含 -wal / -shm 旁路文件。
 */
export function getDbPath(): string {
  return DB_PATH;
}

/**
 * 关闭当前数据库连接。
 *
 * 用于：
 *   1. 数据库导入替换文件前必须先关闭——Windows 上文件被占用无法重命名；
 *   2. 进程优雅关停时主动 checkpoint WAL，确保 .db 主文件包含所有事务，
 *      避免"用户拿 cp .db 做冷备结果丢最近事务"的隐藏故障。
 *
 * 调用后下次 getDb() 会重新打开。
 */
export function closeDb(): void {
  if (db) {
    try {
      // TRUNCATE 模式：把 -wal 内的事务全部 checkpoint 进 .db，并把 -wal 截断到 0；
      // 之后冷拷贝 .db 单文件就是完整的一致性快照。
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch { /* ignore：实例已损坏或只读时不阻塞关停 */ }
    try { db.close(); } catch { /* ignore */ }
    // @ts-expect-error: 允许重新打开
    db = undefined;
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // ---- P1 加固 PRAGMA ----
    // busy_timeout：极短时间窗口内允许 SQLite 内部重试，避免多连接 / 多进程
    // 同时写时直接抛 SQLITE_BUSY。better-sqlite3 单例本身已串行化所有 SQL，
    // 但当出现"主进程 + 备份子进程""主进程 + CLI 工具""Electron 主 + 子"
    // 这类多连接场景时，没有 busy_timeout 会立刻报错；5s 是一个安全窗口。
    db.pragma("busy_timeout = 5000");
    // synchronous = NORMAL：WAL 模式下 NORMAL 已经能在断电时保证持久化，
    // 性能比 FULL 好得多；这是 SQLite 官方对 WAL 的推荐值。
    db.pragma("synchronous = NORMAL");
    // auto_vacuum = INCREMENTAL：让 DELETE 产生的 free page 可以通过
    //   PRAGMA incremental_vacuum(...) 真正归还给操作系统，用户看到的
    //   .db 文件大小会随删除动作缩小。
    // 老库首次迁移会做一次 VACUUM 以切换模式（一次性代价），之后每次
    //   reclaimSpace() 的 incremental_vacuum 都是廉价的文件尾截断。
    // 失败不致命：失败时退回到历史"占用只增不减"的行为，不影响数据正确性。
    enableIncrementalAutoVacuum(db);
    // 完整性快速自检：5~50ms 量级，能发现绝大多数 page-level 损坏。
    // 损坏时直接抛错让进程拒绝启动——比"看似能跑、读到一半才报错"安全得多。
    try {
      const r = db.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
      const result = r?.quick_check;
      if (result && result !== "ok") {
        throw new Error(
          `[db] SQLite quick_check failed: ${result}\n` +
          `数据库文件可能已损坏：${DB_PATH}\n` +
          `修复指引：\n` +
          `  1) 立即停止服务，避免进一步写入；\n` +
          `  2) 备份当前文件（含 -wal/-shm）到只读介质；\n` +
          `  3) 优先使用 nowen-note 的备份恢复功能（POST /api/backups/<file>/restore?dryRun=1 预览）；\n` +
          `  4) 若无可用备份，可尝试：\n` +
          `       sqlite3 ${path.basename(DB_PATH)} ".recover" | sqlite3 recovered.db\n` +
          `     再用 recovered.db 替换原文件。`
        );
      }
    } catch (e) {
      // quick_check 自身抛错（极端损坏）也让启动失败。
      if (e instanceof Error && e.message.startsWith("[db]")) throw e;
      throw new Error(
        `[db] SQLite quick_check 执行异常: ${e instanceof Error ? e.message : String(e)}\n` +
        `数据库文件可能已损坏：${DB_PATH}`
      );
    }
    initSchema(db);
    // ---- D3：版本化迁移 ----
    // initSchema 内部用 IF NOT EXISTS / ALTER 兜底负责"基线 + 历史增量"，
    // 之后所有新 schema 演化通过 migrations.ts 的 MIGRATIONS 数组登记，
    // 由 runMigrations 在事务里串行执行并把版本写进 schema_migrations。
    // 拒绝降级：发现 DB 版本高于程序支持版本时直接抛错，避免旧程序写坏新库。
    try {
      runMigrations(db);
    } catch (e) {
      // 让进程启动失败：迁移失败比"看似能跑"安全得多。
      try { db.close(); } catch { /* ignore */ }
      // @ts-expect-error: 允许重新打开
      db = undefined;
      throw e;
    }
  }
  return db;
}

/**
 * 返回当前数据库文件实际应用到的 schema 版本号。
 * 备份系统用它写入 meta.json，恢复时校验"备份的 schema 是否与当前程序兼容"。
 */
export function getDbSchemaVersion(): number {
  return getCurrentSchemaVersion(getDb());
}

/** 当前程序代码已知的最高 schema 版本号（== max(MIGRATIONS.version)）。 */
export function getCodeSchemaVersion(): number {
  return CURRENT_SCHEMA_VERSION;
}

function initSchema(db: Database.Database) {
  db.exec(`
    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      passwordHash TEXT NOT NULL,
      avatarUrl TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 笔记本表 (支持无限层级)
    --
    -- 软删除字段（v14 起新增）：
    --   isDeleted = 1  → 笔记本本身被"放入回收站"。该笔记本及其所有子孙笔记
    --                    本会被一并标 isDeleted=1；这些笔记本下的笔记会被
    --                    isTrashed=1 移入回收站。
    --   deletedAt      → 软删时间，用于"30 天后自动彻底清理"等策略（暂未启用）。
    --
    -- 为什么不直接 DELETE FROM notebooks？
    --   notes.notebookId FK 是 ON DELETE CASCADE，物理删笔记本会把回收站里
    --   还在等待用户"反悔恢复"的笔记一起带走，违反"删除笔记本前先把笔记移入
    --   回收站"的产品语义（参考 macOS Notes / 印象笔记）。改成软删后：
    --     * 笔记本只是被隐藏，FK 关系完整；
    --     * 用户清空回收站 / 永久删除单条笔记时，notes 行才被物理删。
    --     * 用户从回收站恢复笔记 → 校验父笔记本 isDeleted=0；若父已软删，
    --       前端引导用户选择新笔记本。
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      parentId TEXT,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT DEFAULT '📒',
      color TEXT,
      sortOrder INTEGER DEFAULT 0,
      isExpanded INTEGER DEFAULT 1,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      deletedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parentId) REFERENCES notebooks(id) ON DELETE CASCADE
    );

    -- 软删笔记本的过滤索引（idx_notebooks_isDeleted）由 migrations.ts v14
    -- 单独负责建立。原因与 idx_ai_chat_msg_conv / idx_note_embeddings_user_ws
    -- 同构：对 v13 及以前的老库，notebooks 表里没有 isDeleted 列，CREATE TABLE
    -- IF NOT EXISTS 不会补列，紧接着在这里建索引会抛 "no such column: isDeleted"，
    -- 早于 runMigrations，v14 的 ALTER TABLE 根本来不及跑 —— 死锁。
    -- v14 迁移会先 ALTER 补列再建索引，对全新库（首次启动也跑 v14）幂等。

    -- 笔记表
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      notebookId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '无标题笔记',
      content TEXT DEFAULT '{}',
      contentText TEXT DEFAULT '',
      isPinned INTEGER DEFAULT 0,
      isFavorite INTEGER DEFAULT 0,
      isLocked INTEGER DEFAULT 0,
      isArchived INTEGER DEFAULT 0,
      isTrashed INTEGER DEFAULT 0,
      trashedAt TEXT,
      version INTEGER DEFAULT 1,
      sortOrder INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE
    );

    -- 标签表
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#58a6ff',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(userId, name)
    );

    -- 笔记-标签 多对多关联表
    CREATE TABLE IF NOT EXISTS note_tags (
      noteId TEXT NOT NULL,
      tagId TEXT NOT NULL,
      PRIMARY KEY (noteId, tagId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
    );

    -- 附件表
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      noteId TEXT NOT NULL,
      userId TEXT NOT NULL,
      filename TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 系统设置表（键值对）
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 待办任务表
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      isCompleted INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 2,
      dueDate TEXT,
      noteId TEXT,
      parentId TEXT,
      sortOrder INTEGER DEFAULT 0,
      repeatEndCount INTEGER,
      repeatSequenceIndex INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE SET NULL,
      FOREIGN KEY (parentId) REFERENCES tasks(id) ON DELETE CASCADE
    );

    -- 自定义字体表
    CREATE TABLE IF NOT EXISTS custom_fonts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fileName TEXT NOT NULL UNIQUE,
      format TEXT NOT NULL,
      fileSize INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 说说/动态表
    CREATE TABLE IF NOT EXISTS diaries (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      contentText TEXT DEFAULT '',
      mood TEXT DEFAULT '',
      -- 图片：JSON 数组字符串，元素是 diary_attachments.id（uuid）。
      -- 默认 '[]' 而不是 NULL，方便 SQL/前端无脑 JSON.parse。
      images TEXT NOT NULL DEFAULT '[]',
      -- 媒体：JSON 数组字符串，元素形如 { id, type: 'image' | 'video' }。
      media TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_diaries_user_created ON diaries(userId, createdAt DESC);

    -- 说说图片附件表（与 notes 的 attachments 表平行，避免 noteId NOT NULL 限制）
    --   diaryId 可空：发布前先上传（拿到 id 后再 attach 到 diary），
    --                 配合 createdAt 做"超时未绑定 → 视为孤儿清理"
    --   path 与 attachments 表语义一致：相对 ATTACHMENTS_DIR 的文件名
    CREATE TABLE IF NOT EXISTS diary_attachments (
      id TEXT PRIMARY KEY,
      diaryId TEXT,
      userId TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (diaryId) REFERENCES diaries(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_diary_attachments_diary ON diary_attachments(diaryId);
    CREATE INDEX IF NOT EXISTS idx_diary_attachments_user_created ON diary_attachments(userId, createdAt);

    -- 分享记录表
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      noteId TEXT NOT NULL,
      ownerId TEXT NOT NULL,
      shareToken TEXT NOT NULL UNIQUE,
      shareType TEXT NOT NULL DEFAULT 'link',
      permission TEXT NOT NULL DEFAULT 'view',
      password TEXT,
      expiresAt TEXT,
      maxViews INTEGER,
      viewCount INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_shares_note ON shares(noteId);
    CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(ownerId);
    CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(shareToken);

    -- 笔记版本历史表
    CREATE TABLE IF NOT EXISTS note_versions (
      id TEXT PRIMARY KEY,
      noteId TEXT NOT NULL,
      userId TEXT NOT NULL,
      title TEXT,
      content TEXT,
      contentText TEXT,
      contentFormat TEXT NOT NULL DEFAULT 'tiptap-json',
      version INTEGER NOT NULL,
      changeType TEXT DEFAULT 'edit',
      changeSummary TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(noteId, version DESC);

    -- 评论批注表
    --
    -- userId 的语义（v13 起放松为可空）：
    --   - 非 NULL：登录用户评论，可 JOIN users 拿用户名/头像；
    --   - NULL  ：未登录访客评论（公开分享 + comment 权限），用 guestName 显示。
    --
    -- 用户被删除时：原先 ON DELETE CASCADE 会把该用户写过的所有评论一起清掉，
    --   但分享场景下"用户注销"不应该让公开分享下的对话历史消失（笔记主和其他
    --   访客已经看过的留言不应该突然蒸发）。改为 ON DELETE SET NULL：用户被删
    --   后该评论变成"匿名访客"，guestName 字段（若有）作为兜底显示名。
    --
    -- guestIpHash 仅用于反垃圾（频次限制 / 屏蔽），不暴露给前端；存 SHA-256 hex
    --   而非明文 IP，符合最小化数据收集原则。
    CREATE TABLE IF NOT EXISTS share_comments (
      id TEXT PRIMARY KEY,
      noteId TEXT NOT NULL,
      userId TEXT,
      guestName TEXT,
      guestIpHash TEXT,
      parentId TEXT,
      content TEXT NOT NULL,
      anchorData TEXT,
      isResolved INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (parentId) REFERENCES share_comments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_share_comments_note ON share_comments(noteId);
    -- 注意：idx_share_comments_guest_ip 不在这里建。
    -- 原因：老库（v12 之前）已经有 share_comments 表但没有 guestIpHash 列，
    --       CREATE TABLE IF NOT EXISTS 会跳过重建，紧接着对不存在的列建索引会让
    --       整个 db.exec() 段失败，连带 v13 迁移都没机会跑。
    -- 索引由 migrations.ts v13 在表重建/列补齐之后再建（且对新装库幂等）。

    -- 全文搜索虚拟表
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title,
      contentText,
      content='notes',
      content_rowid='rowid'
    );

    -- 索引优化
    CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebookId);
    CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(userId);
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_notes_trashed ON notes(isTrashed);
    CREATE INDEX IF NOT EXISTS idx_notebooks_parent ON notebooks(parentId);
    CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks(userId);
    CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(noteId);
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tagId);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(userId);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(dueDate);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentId);
    CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(isCompleted);

    -- FTS 同步触发器
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, contentText) VALUES (new.rowid, new.title, new.contentText);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, contentText) VALUES('delete', old.rowid, old.title, old.contentText);
    END;

    -- 升级触发器：老库可能存在无条件重写 FTS 的旧版本，直接 DROP 后重建为带 WHEN 的条件版本。
    -- 条件：只有 title 或 contentText 真正发生变化时，才重写 FTS 行。
    -- 收益：每次保存都会 bump version/updatedAt，但正文经常没动；避免无用的 FTS 索引维护 I/O。
    -- NULL 安全比较：用 IS NOT 而非 !=，避免任一侧为 NULL 时判断结果是 NULL（假）。
    DROP TRIGGER IF EXISTS notes_au;
    CREATE TRIGGER notes_au AFTER UPDATE ON notes
    WHEN old.title IS NOT new.title OR old.contentText IS NOT new.contentText
    BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, contentText) VALUES('delete', old.rowid, old.title, old.contentText);
      INSERT INTO notes_fts(rowid, title, contentText) VALUES (new.rowid, new.title, new.contentText);
    END;
  `);

  // ==============================================================
  // Collaboration Phase 1: 多用户协作基础表
  // ==============================================================
  db.exec(`
    -- 工作区（团队空间）
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      icon TEXT DEFAULT '🏢',
      ownerId TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 工作区成员（role: owner|admin|editor|commenter|viewer）
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspaceId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      joinedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspaceId, userId),
      FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 工作区邀请码
    CREATE TABLE IF NOT EXISTS workspace_invites (
      id TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'editor',
      maxUses INTEGER DEFAULT 10,
      useCount INTEGER DEFAULT 0,
      expiresAt TEXT,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 笔记级 ACL 覆写（默认继承笔记本 workspace 权限；此表用于个别授权）
    CREATE TABLE IF NOT EXISTS note_acl (
      noteId TEXT NOT NULL,
      userId TEXT NOT NULL,
      permission TEXT NOT NULL, -- 'read'|'comment'|'write'|'manage'
      grantedBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (noteId, userId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 笔记本成员：Notebook 作为用户感知的协作空间，Workspace 仍保留为底层容器
    CREATE TABLE IF NOT EXISTS notebook_members (
      id TEXT PRIMARY KEY,
      notebookId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      status TEXT NOT NULL DEFAULT 'active',
      invitedBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (invitedBy) REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(notebookId, userId)
    );

    CREATE TABLE IF NOT EXISTS notebook_share_links (
      id TEXT PRIMARY KEY,
      notebookId TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'viewer',
      enabled INTEGER NOT NULL DEFAULT 1,
      expiresAt TEXT,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE,
      FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ws_owner ON workspaces(ownerId);
    CREATE INDEX IF NOT EXISTS idx_ws_members_user ON workspace_members(userId);
    CREATE INDEX IF NOT EXISTS idx_ws_members_ws ON workspace_members(workspaceId);
    CREATE INDEX IF NOT EXISTS idx_ws_invites_code ON workspace_invites(code);
    CREATE INDEX IF NOT EXISTS idx_ws_invites_ws ON workspace_invites(workspaceId);
    CREATE INDEX IF NOT EXISTS idx_note_acl_user ON note_acl(userId);
    CREATE INDEX IF NOT EXISTS idx_note_acl_note ON note_acl(noteId);
    CREATE INDEX IF NOT EXISTS idx_notebook_members_notebook ON notebook_members(notebookId);
    CREATE INDEX IF NOT EXISTS idx_notebook_members_user ON notebook_members(userId);
    CREATE INDEX IF NOT EXISTS idx_notebook_share_links_notebook ON notebook_share_links(notebookId);
    CREATE INDEX IF NOT EXISTS idx_notebook_share_links_token ON notebook_share_links(token);
  `);

  // ==============================================================
  // Collaboration Phase 3: Y.js CRDT 持久化
  // ==============================================================
  db.exec(`
    -- 增量 Y update（每次客户端 update 追加一条；服务重启时按序回放）
    CREATE TABLE IF NOT EXISTS note_yupdates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId TEXT NOT NULL,
      userId TEXT,
      update_blob BLOB NOT NULL,
      clock INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    -- Y 文档快照（每 N 条 update 或定时生成一次；合并后可清理旧 updates）
    CREATE TABLE IF NOT EXISTS note_ysnapshots (
      noteId TEXT PRIMARY KEY,
      snapshot_blob BLOB NOT NULL,
      updatesMergedTo INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_note_yupdates_note ON note_yupdates(noteId, id);
  `);

  // notebooks 表增加 workspaceId 字段（NULL 表示归属于用户的个人空间）
  try {
    db.prepare("SELECT workspaceId FROM notebooks LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE notebooks ADD COLUMN workspaceId TEXT").run();
    db.exec("CREATE INDEX IF NOT EXISTS idx_notebooks_workspace ON notebooks(workspaceId);");
  }

  // users 表补充多用户相关字段：role / isDisabled / displayName / lastLoginAt
  try {
    db.prepare("SELECT role FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'").run();
    // 把存量首个用户升级为 admin（兼容单机旧库）
    const first = db.prepare("SELECT id FROM users ORDER BY createdAt ASC LIMIT 1").get() as { id: string } | undefined;
    if (first) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(first.id);
  }
  try {
    db.prepare("SELECT isDisabled FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN isDisabled INTEGER NOT NULL DEFAULT 0").run();
  }
  try {
    db.prepare("SELECT displayName FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN displayName TEXT").run();
  }
  try {
    db.prepare("SELECT lastLoginAt FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN lastLoginAt TEXT").run();
  }

  // Phase 5 安全加固：
  //   tokenVersion          — 每次密码重置 / 账号禁用时自增，使所有旧 JWT 立即失效
  //   mustChangePassword    — factory-reset 后强制下次登录修改密码
  //   failedLoginAttempts   — 累计失败次数（用于账号锁定）
  //   lastFailedLoginAt     — 最近一次失败时间（滑动窗口清零判断用）
  //   lockedUntil           — 账号锁定到期时间（ISO），当前时间 < lockedUntil 禁止登录
  try {
    db.prepare("SELECT tokenVersion FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0").run();
  }
  try {
    db.prepare("SELECT mustChangePassword FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN mustChangePassword INTEGER NOT NULL DEFAULT 0").run();
  }
  try {
    db.prepare("SELECT failedLoginAttempts FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN failedLoginAttempts INTEGER NOT NULL DEFAULT 0").run();
  }
  try {
    db.prepare("SELECT lastFailedLoginAt FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN lastFailedLoginAt TEXT").run();
  }
  try {
    db.prepare("SELECT lockedUntil FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN lockedUntil TEXT").run();
  }

  // notes 表冗余一个 workspaceId 便于高性能过滤（通过 notebook 同步维护）
  try {
    db.prepare("SELECT workspaceId FROM notes LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE notes ADD COLUMN workspaceId TEXT").run();
    db.exec("CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes(workspaceId);");
  }

  // tags 表增加 workspaceId 字段（NULL 表示归属于用户的个人空间）
  // -----------------------------------------------------------------
  // 设计要点：
  //   - 与 notebooks / notes 同款：workspaceId 是 TEXT，NULL 视为个人空间。
  //   - 不加 FOREIGN KEY：SQLite 的 ALTER TABLE ADD COLUMN 不支持带 FK 的列；
  //     业务层维护引用完整性即可（删除 workspace 时同步清理 / 转个人）。
  //   - 不动 UNIQUE(userId, name)：保留"同用户标签名全局唯一"的现有约束，
  //     避免重建表。语义上：标签是用户自己的分类体系，而 workspaceId
  //     仅决定它在哪个空间里可见。
  //   - 已存在的标签 ALTER 后 workspaceId 自动为 NULL → 全部归到个人空间，
  //     符合"标签隔离迁移到个人空间"的策略，零数据丢失。
  try {
    db.prepare("SELECT workspaceId FROM tags LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE tags ADD COLUMN workspaceId TEXT").run();
    db.exec("CREATE INDEX IF NOT EXISTS idx_tags_workspace ON tags(workspaceId);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tags_user_workspace ON tags(userId, workspaceId);");
  }

  // 数据库迁移：为已有表添加新字段
  try {
    db.prepare("SELECT isLocked FROM notes LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE notes ADD COLUMN isLocked INTEGER DEFAULT 0").run();
  }

  // 迁移：如果旧版 diaries 表有 date 列，删掉重建
  try {
    db.prepare("SELECT date FROM diaries LIMIT 1").get();
    // 旧表存在 date 列 → 重建
    db.exec("DROP TABLE IF EXISTS diaries");
    db.exec(`
      CREATE TABLE IF NOT EXISTS diaries (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        contentText TEXT DEFAULT '',
        mood TEXT DEFAULT '',
        images TEXT NOT NULL DEFAULT '[]',
        media TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_diaries_user_created ON diaries(userId, createdAt DESC);
    `);
  } catch {
    // 新表或表不存在，跳过
  }

  // 迁移：旧版 diaries 表（date 已清理但还没有 images 列）补加 images 列。
  // 与 notes.isLocked / users.lockedUntil 等迁移同款 ALTER TABLE 模式。
  try {
    db.prepare("SELECT images FROM diaries LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE diaries ADD COLUMN images TEXT NOT NULL DEFAULT '[]'").run();
  }
  try {
    db.prepare("SELECT media FROM diaries LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE diaries ADD COLUMN media TEXT NOT NULL DEFAULT '[]'").run();
  }

  // 迁移：补建 diary_attachments 表（旧库初始化时这张表还不存在）。
  // CREATE TABLE IF NOT EXISTS 是幂等的，直接 exec 即可。
  db.exec(`
    CREATE TABLE IF NOT EXISTS diary_attachments (
      id TEXT PRIMARY KEY,
      diaryId TEXT,
      userId TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (diaryId) REFERENCES diaries(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_diary_attachments_diary ON diary_attachments(diaryId);
    CREATE INDEX IF NOT EXISTS idx_diary_attachments_user_created ON diary_attachments(userId, createdAt);
  `);

  // 任务附件表（待办事项模块支持插入图片）
  // ----------------------------------------------------------------------
  // 设计要点：
  //   - 与 attachments / diary_attachments 同款：文件落盘到 ATTACHMENTS_DIR，
  //     行里只存元数据。
  //   - taskId 可空：允许"先上传图片、再随新任务一起提交"的链路（典型场景：
  //     用户在新建任务输入框里粘贴图片，那一刻 task 行还没创建）。前端创建
  //     任务后再把附件 id 关联回 task。未关联的附件由定期清理脚本处理。
  //   - userId NOT NULL：用于上传 ACL（自己上传的自己能删）+ 孤儿清理审计。
  //   - 不与 attachments 表合并：attachments 强外键到 notes，语义耦合度太高
  //     （ACL、CASCADE、迁移工具）。新表保持解耦更简单。
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id TEXT PRIMARY KEY,
      taskId TEXT,
      userId TEXT NOT NULL,
      filename TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(taskId);
    CREATE INDEX IF NOT EXISTS idx_task_attachments_user_created ON task_attachments(userId, createdAt);
  `);

  // ==============================================================
  // 安全加固 Phase 6：2FA（TOTP）+ 会话管理
  // ==============================================================
  //
  // users 表新增 2FA 字段：
  //   twoFactorSecret       — base32 编码的 TOTP secret（仅在 enabled 时有值；disable 后 NULL）
  //   twoFactorEnabledAt    — 启用时间，用于前端展示；NULL 即未启用
  //   twoFactorBackupCodes  — JSON 数组，元素是 sha256 过的一次性恢复码；匹配并消费后移除
  try {
    db.prepare("SELECT twoFactorSecret FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN twoFactorSecret TEXT").run();
  }
  try {
    db.prepare("SELECT twoFactorEnabledAt FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN twoFactorEnabledAt TEXT").run();
  }
  try {
    db.prepare("SELECT twoFactorBackupCodes FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN twoFactorBackupCodes TEXT").run();
  }

  // sessions 表：每次签发登录 JWT 都落一条记录，服务端可列出用户的活跃 session，
  // 并通过 revokedAt 做"吊销"而不必 bump tokenVersion（避免误伤所有端）。
  //
  //   id          会话 ID，同时作为 JWT 的 jti claim
  //   userId      所属用户
  //   createdAt   登录时间
  //   lastSeenAt  最近一次带该 jti 的请求到达时间（JWT 中间件会异步更新）
  //   expiresAt   与 JWT exp 对齐，仅用于过期清理
  //   ip          首次登录的 IP
  //   userAgent   首次登录的 UA，前端做"显示设备名"
  //   deviceLabel 用户自己起的名字，可选
  //   revokedAt   被管理员或用户吊销；非 NULL 后该 jti 的 token 一律失效
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastSeenAt TEXT NOT NULL DEFAULT (datetime('now')),
      expiresAt TEXT,
      ip TEXT DEFAULT '',
      userAgent TEXT DEFAULT '',
      deviceLabel TEXT,
      revokedAt TEXT,
      revokedReason TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(userId, revokedAt, lastSeenAt DESC);
  `);

  // ==============================================================
  // AI 知识问答聊天记录（跨会话持久化）
  // ==============================================================
  //
  // v10 起支持"多会话"：每条消息挂到 ai_chat_conversations 的一条会话下。
  // 新装库这里就建带 conversationId 列的最终形态；老库由 migrations v10 补列 + 回填。
  //
  // 每条消息一行：user 的提问和 assistant 的回复各存一条，按 createdAt 升序即为对话时间线。
  //   id              消息 ID（前端生成的也可以，只要全局唯一；本端路由直接用时间戳+随机串）
  //   userId          所属用户；ON DELETE CASCADE 使账号删除时连带清理
  //   conversationId  所属会话；NULL 仅出现在 v10 迁移中途的极短窗口，业务层一律按会话维度读写
  //   role            'user' | 'assistant'
  //   content         纯文本消息内容（Markdown 原文）
  //   referencesJson  可选，仅 assistant 消息使用，存 [{id,title},...] 的 JSON 字符串；
  //                   笔记后续可能被删，恢复时前端点击跳转自行容错即可
  //   createdAt       创建时间，用于排序和按时间窗口裁剪
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_conversations (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_chat_conv_user
      ON ai_chat_conversations(userId, archived, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      conversationId TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      referencesJson TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_chat_user_created ON ai_chat_messages(userId, createdAt);
    -- 注意：idx_ai_chat_msg_conv (conversationId, createdAt) 的建立**不能**放在
    -- initSchema 里。原因：对 v9 或更早版本创建的老库，ai_chat_messages 表已存在
    -- 但没有 conversationId 列，此处 CREATE TABLE IF NOT EXISTS 不会补列，紧接着
    -- 建索引会抛 SqliteError: no such column: conversationId，导致 initSchema
    -- 崩溃，连后面的 runMigrations（v10 会补列）都没机会跑 —— 死锁。
    -- 该索引由 migrations.ts 的 v10 迁移统一创建（addColumnIfMissing 后建索引），
    -- 对全新库也会在同一次启动补建（IF NOT EXISTS 幂等）。
  `);

  // ==============================================================
  // AI 自定义指令（P2）：用户保存的可复用 prompt 模板
  // ==============================================================
  //
  // 场景：AI 写作助手里的"自定义指令"每次都要现场输入，用户希望能把常用的
  //   prompt（例如"翻译成德语并保留原文格式"）保存下来一键复用。
  //
  // 设计要点：
  //   - 按 userId 隔离（同一账号的所有设备共享，不按工作区区分——写作风格
  //     是人的属性不是工作区的属性）；
  //   - name 在同一用户下唯一，保证列表里不会出现重名条目；前端先做客户端校验、
  //     后端再用唯一索引兜底（UNIQUE(userId, name)）；
  //   - usageCount 记点击次数，用于"按使用频次排序"以把常用指令置顶；
  //   - 软失败策略：prompt 字段允许任意长度文本，不做长度限制（前端可自限 2000）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_custom_prompts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      usageCount INTEGER NOT NULL DEFAULT 0,
      lastUsedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_custom_prompts_user_name
      ON ai_custom_prompts(userId, name);
    CREATE INDEX IF NOT EXISTS idx_ai_custom_prompts_user_usage
      ON ai_custom_prompts(userId, usageCount DESC, updatedAt DESC);
  `);

  // ==============================================================
  // RAG Phase 1：笔记向量化（Embedding）基础表
  // ==============================================================
  //
  // 设计要点：
  //   - note_embeddings：每个 chunk 一行；当前 Phase 1 还没接 sqlite-vec，
  //     向量先以 JSON 文本形式存在 vectorJson（一维 float 数组）。
  //     Phase 2 接入 sqlite-vec 时会再建一个虚表 vec_note_chunks 并按 rowid
  //     关联，本表的 vectorJson 列保留作"原始向量备份"。
  //   - embedding_queue：异步任务队列，单条 noteId 对应一行。
  //     status: 'pending' | 'processing' | 'done' | 'failed'
  //     用 ON CONFLICT(noteId) DO UPDATE 实现"覆盖入队"——
  //     笔记连续修改 5 次只会留 1 条 pending。
  //   - 触发器：notes INSERT / contentText 或 title 变化时自动入队。
  //     和现有的 notes_au FTS 触发器同款条件，避免无意义重排。
  //   - 删除笔记 → CASCADE 清理 note_embeddings；队列也加触发器同步删除。
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId TEXT NOT NULL,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      chunkIndex INTEGER NOT NULL DEFAULT 0,
      chunkText TEXT NOT NULL DEFAULT '',
      vectorJson TEXT NOT NULL DEFAULT '[]',
      entityType TEXT NOT NULL DEFAULT 'note',
      attachmentId TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_note_embeddings_note ON note_embeddings(noteId);
    CREATE INDEX IF NOT EXISTS idx_note_embeddings_user ON note_embeddings(userId);
    CREATE INDEX IF NOT EXISTS idx_note_embeddings_model ON note_embeddings(model);
    -- 注意：以下几条索引**不能**放在 initSchema 里，必须交给 migrations.ts 单一负责：
    --   idx_note_embeddings_user_ws (userId, workspaceId)   -- 由 v7 建，依赖 v7 补的 workspaceId 列
    --   idx_note_embeddings_ws      (workspaceId)           -- 由 v7 建
    --   idx_note_embeddings_attachment (attachmentId)        -- 由 v8 建，依赖 v8 补的 attachmentId 列
    --
    -- 原因（与 idx_ai_chat_msg_conv 同构）：对 v6 或更早版本创建的老库，
    -- note_embeddings 表早已存在但缺 workspaceId / attachmentId 列。此处
    -- CREATE TABLE IF NOT EXISTS 不会补列，紧接着建索引会抛：
    --   SqliteError: no such column: workspaceId  (schema.js:806 附近)
    -- 报错发生在 initSchema 内，早于 runMigrations，v7/v8 的 addColumnIfMissing
    -- 根本来不及跑 —— 死锁。对全新库，v7/v8 首次启动也会运行一次
    -- (getCurrentSchemaVersion=0)，CREATE INDEX IF NOT EXISTS 幂等补建。

    CREATE TABLE IF NOT EXISTS embedding_queue (
      noteId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      retries INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      enqueuedAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_embedding_queue_status ON embedding_queue(status, enqueuedAt);
    -- idx_embedding_queue_user_ws (userId, workspaceId) 由 v7 单一负责，见上方长注释。

    -- INSERT 触发：新笔记入队（contentText 可能为空，由 worker 决定是否真的算 embedding）
    -- workspaceId 同步从 notes.workspaceId 取（NULL = 个人空间）
    DROP TRIGGER IF EXISTS notes_embed_ai;
    CREATE TRIGGER notes_embed_ai AFTER INSERT ON notes
    WHEN new.isTrashed = 0
    BEGIN
      INSERT INTO embedding_queue (noteId, userId, workspaceId, status, retries, enqueuedAt, updatedAt)
      VALUES (new.id, new.userId, new.workspaceId, 'pending', 0, datetime('now'), datetime('now'))
      ON CONFLICT(noteId) DO UPDATE SET
        workspaceId = excluded.workspaceId,
        status = 'pending',
        retries = 0,
        lastError = NULL,
        updatedAt = datetime('now');
    END;

    -- UPDATE 触发：title / contentText / workspaceId 任一变化都重新入队
    -- （workspaceId 变化 = 笔记跨空间移动；旧的 embedding 仍指向旧 workspaceId，
    --  worker 处理本笔记时会 DELETE+INSERT，新行带新 workspaceId，自动一致。）
    -- isTrashed: 0→1 进回收站时不重排（也可以选择删除，简单起见交给 worker 跳过）
    DROP TRIGGER IF EXISTS notes_embed_au;
    CREATE TRIGGER notes_embed_au AFTER UPDATE ON notes
    WHEN (old.title IS NOT new.title OR old.contentText IS NOT new.contentText
          OR old.workspaceId IS NOT new.workspaceId)
         AND new.isTrashed = 0
    BEGIN
      INSERT INTO embedding_queue (noteId, userId, workspaceId, status, retries, enqueuedAt, updatedAt)
      VALUES (new.id, new.userId, new.workspaceId, 'pending', 0, datetime('now'), datetime('now'))
      ON CONFLICT(noteId) DO UPDATE SET
        workspaceId = excluded.workspaceId,
        status = 'pending',
        retries = 0,
        lastError = NULL,
        updatedAt = datetime('now');
    END;

    -- ==============================================================
    -- 附件内容索引（与 note 索引共用 vec_note_chunks 虚表，靠 entityType 分辨）
    -- ==============================================================
    --
    -- attachment_chunks：附件分块原文（召回后拼 prompt 用）
    -- attachment_embedding_queue：附件任务队列（主键 attachmentId，与 note 队列分离）
    -- attachments_embed_ad：附件删除时级联清理 note_embeddings 里对应的 attachment 行
    CREATE TABLE IF NOT EXISTS attachment_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attachmentId TEXT NOT NULL,
      chunkIndex INTEGER NOT NULL DEFAULT 0,
      chunkText TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_chunks_attachment ON attachment_chunks(attachmentId);

    CREATE TABLE IF NOT EXISTS attachment_embedding_queue (
      attachmentId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      noteId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retries INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      enqueuedAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_queue_status ON attachment_embedding_queue(status, enqueuedAt);
    CREATE INDEX IF NOT EXISTS idx_attachment_queue_user_ws ON attachment_embedding_queue(userId, workspaceId);

    DROP TRIGGER IF EXISTS attachments_embed_ad;
    CREATE TRIGGER attachments_embed_ad AFTER DELETE ON attachments
    BEGIN
      DELETE FROM note_embeddings
       WHERE entityType = 'attachment' AND attachmentId = old.id;
    END;
  `);

  // 一次性回填：老库存量笔记入队，方便首次启动后台 worker 后能逐步建立索引。
  // 仅在 embedding_queue 完全为空时执行，避免重启时反复回填。
  // 注意：只入队没有任何 embedding 的笔记，避免破坏已建好的索引。
  try {
    const queued = db.prepare("SELECT COUNT(*) as c FROM embedding_queue").get() as { c: number };
    if (queued.c === 0) {
      db.prepare(`
        INSERT INTO embedding_queue (noteId, userId, workspaceId, status, retries, enqueuedAt, updatedAt)
        SELECT n.id, n.userId, n.workspaceId, 'pending', 0, datetime('now'), datetime('now')
        FROM notes n
        WHERE n.isTrashed = 0
          AND NOT EXISTS (SELECT 1 FROM note_embeddings e WHERE e.noteId = n.id)
        ON CONFLICT(noteId) DO NOTHING
      `).run();
    }
  } catch (e) {
    // 回填失败不影响主流程
    console.warn("[schema] backfill embedding_queue failed:", e);
  }
}
