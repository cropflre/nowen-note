import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data/nowen-note.db");

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
}
