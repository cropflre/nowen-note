CREATE TABLE IF NOT EXISTS note_templates (
  id TEXT PRIMARY KEY,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  "createdBy" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  "contentText" TEXT NOT NULL DEFAULT '',
  "contentFormat" TEXT NOT NULL CHECK ("contentFormat" IN ('tiptap-json', 'markdown')),
  "sourceNoteId" TEXT REFERENCES notes(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_templates_personal_time
  ON note_templates("createdBy", "workspaceId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_note_templates_workspace_time
  ON note_templates("workspaceId", "updatedAt" DESC);

CREATE TABLE IF NOT EXISTS note_template_attachments (
  id TEXT PRIMARY KEY,
  "templateId" TEXT NOT NULL REFERENCES note_templates(id) ON DELETE CASCADE,
  "sourceAttachmentId" TEXT,
  filename TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL UNIQUE,
  hash TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_template_attachments_template
  ON note_template_attachments("templateId");
