import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "nowen-note.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  }
  return db;
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
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parentId) REFERENCES notebooks(id) ON DELETE CASCADE
    );

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
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_diaries_user_created ON diaries(userId, createdAt DESC);

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
      version INTEGER NOT NULL,
      changeType TEXT DEFAULT 'edit',
      changeSummary TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(noteId, version DESC);

    -- 评论批注表
    CREATE TABLE IF NOT EXISTS share_comments (
      id TEXT PRIMARY KEY,
      noteId TEXT NOT NULL,
      userId TEXT NOT NULL,
      parentId TEXT,
      content TEXT NOT NULL,
      anchorData TEXT,
      isResolved INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parentId) REFERENCES share_comments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_share_comments_note ON share_comments(noteId);

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

    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
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

    CREATE INDEX IF NOT EXISTS idx_ws_owner ON workspaces(ownerId);
    CREATE INDEX IF NOT EXISTS idx_ws_members_user ON workspace_members(userId);
    CREATE INDEX IF NOT EXISTS idx_ws_members_ws ON workspace_members(workspaceId);
    CREATE INDEX IF NOT EXISTS idx_ws_invites_code ON workspace_invites(code);
    CREATE INDEX IF NOT EXISTS idx_ws_invites_ws ON workspace_invites(workspaceId);
    CREATE INDEX IF NOT EXISTS idx_note_acl_user ON note_acl(userId);
    CREATE INDEX IF NOT EXISTS idx_note_acl_note ON note_acl(noteId);
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
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_diaries_user_created ON diaries(userId, createdAt DESC);
    `);
  } catch {
    // 新表或表不存在，跳过
  }

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
}
