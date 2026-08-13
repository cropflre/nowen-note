import type { Migration } from "./migrations.impl.js";

export const noteTemplatesMigration: Migration = {
  version: 79,
  name: "note-templates",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_templates (
        id TEXT PRIMARY KEY,
        workspaceId TEXT,
        createdBy TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        contentText TEXT NOT NULL DEFAULT '',
        contentFormat TEXT NOT NULL CHECK (contentFormat IN ('tiptap-json', 'markdown')),
        sourceNoteId TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (sourceNoteId) REFERENCES notes(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_note_templates_personal_time
        ON note_templates(createdBy, workspaceId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_note_templates_workspace_time
        ON note_templates(workspaceId, updatedAt DESC);

      CREATE TABLE IF NOT EXISTS note_template_attachments (
        id TEXT PRIMARY KEY,
        templateId TEXT NOT NULL,
        sourceAttachmentId TEXT,
        filename TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL UNIQUE,
        hash TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (templateId) REFERENCES note_templates(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_note_template_attachments_template
        ON note_template_attachments(templateId);
    `);
  },
};
