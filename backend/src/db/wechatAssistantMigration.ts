import type { Migration } from "./migrations.impl.js";

export const wechatAssistantMigration: Migration = {
  version: 121,
  name: "wechat-assistant-inbox",
  up(db) {
    db.exec(`
      CREATE TABLE wechat_assistant_profiles (
        userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        tokenVersion INTEGER NOT NULL,
        openId TEXT UNIQUE,
        notebookId TEXT REFERENCES notebooks(id) ON DELETE SET NULL,
        workflowId TEXT REFERENCES automation_workflows(id) ON DELETE SET NULL
      );
      CREATE TABLE wechat_assistant_sessions (
        sceneHash TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tokenVersion INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE wechat_assistant_items (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        urlKey TEXT NOT NULL,
        openId TEXT,
        tokenVersion INTEGER NOT NULL,
        runId TEXT REFERENCES automation_workflow_runs(id) ON DELETE SET NULL,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX wechat_assistant_items_owner_url ON wechat_assistant_items(userId,urlKey);
    `);
  },
};
