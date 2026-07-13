-- PostgreSQL Schema for nowen-note
-- Generated from SQLite schema (PG-SCHEMA-02)
--
-- 注意事项：
--   1. TEXT PRIMARY KEY 保持 TEXT，未改 UUID 类型
--   2. INTEGER boolean 映射为 BOOLEAN
--   3. datetime('now') 映射为 TIMESTAMPTZ DEFAULT NOW()
--   4. INTEGER PRIMARY KEY AUTOINCREMENT 映射为 GENERATED ALWAYS AS IDENTITY
--   5. BLOB 映射为 BYTEA
--   6. FTS5 虚拟表未迁移，留给 PG-FTS-01
--   7. PRAGMA 不迁移
--   8. 此文件为草案，未经实际运行验证

-- ============================================================
-- Core tables
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    "passwordHash" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    role TEXT NOT NULL DEFAULT 'user',
    "isDisabled" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT,
    "lastLoginAt" TIMESTAMPTZ,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastFailedLoginAt" TIMESTAMPTZ,
    "lockedUntil" TIMESTAMPTZ,
    "twoFactorSecret" TEXT,
    "twoFactorEnabledAt" TIMESTAMPTZ,
    "twoFactorBackupCodes" TEXT,
    "personalExportEnabled" BOOLEAN NOT NULL DEFAULT true,
    "personalImportEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon TEXT DEFAULT '🏢',
    "ownerId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "enabledFeatures" TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ws_owner ON workspaces("ownerId");

-- ============================================================
-- Notebooks
-- ============================================================

CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "parentId" TEXT REFERENCES notebooks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT DEFAULT '📒',
    color TEXT,
    "sortOrder" INTEGER DEFAULT 0,
    "isExpanded" BOOLEAN DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "workspaceId" TEXT
);

CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks("userId");
CREATE INDEX IF NOT EXISTS idx_notebooks_parent ON notebooks("parentId");
CREATE INDEX IF NOT EXISTS idx_notebooks_workspace ON notebooks("workspaceId");
CREATE INDEX IF NOT EXISTS idx_notebooks_isDeleted ON notebooks("isDeleted");

-- ============================================================
-- Notes
-- ============================================================

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "notebookId" TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '无标题笔记',
    content TEXT DEFAULT '{}',
    "contentText" TEXT DEFAULT '',
    "isPinned" BOOLEAN DEFAULT false,
    "isFavorite" BOOLEAN DEFAULT false,
    "isLocked" BOOLEAN DEFAULT false,
    "isArchived" BOOLEAN DEFAULT false,
    "isTrashed" BOOLEAN DEFAULT false,
    "trashedAt" TIMESTAMPTZ,
    version INTEGER DEFAULT 1,
    "sortOrder" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "workspaceId" TEXT,
    "contentFormat" TEXT NOT NULL DEFAULT 'tiptap-json',
    note_type TEXT NOT NULL DEFAULT 'normal',
    journal_date TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_user ON notes("userId");
CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes("notebookId");
CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes("workspaceId");
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes("updatedAt");
CREATE INDEX IF NOT EXISTS idx_notes_trashed ON notes("isTrashed");
CREATE INDEX IF NOT EXISTS idx_notes_journal_date ON notes("userId", note_type, journal_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_journal_unique ON notes("userId", note_type, journal_date);

-- TODO: FTS5 → tsvector/tsquery (PG-FTS-01)

-- ============================================================
-- Tags
-- ============================================================

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#58a6ff',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "workspaceId" TEXT
);

CREATE INDEX IF NOT EXISTS idx_tags_user_workspace ON tags("userId", "workspaceId");
CREATE INDEX IF NOT EXISTS idx_tags_workspace ON tags("workspaceId");

CREATE TABLE IF NOT EXISTS note_tags (
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "tagId" TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY ("noteId", "tagId")
);

CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags("noteId");
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags("tagId");

-- ============================================================
-- Workspace members & invites
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_members (
    "workspaceId" TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'editor',
    "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("workspaceId", "userId")
);

CREATE INDEX IF NOT EXISTS idx_ws_members_ws ON workspace_members("workspaceId");
CREATE INDEX IF NOT EXISTS idx_ws_members_user ON workspace_members("userId");

CREATE TABLE IF NOT EXISTS workspace_invites (
    id TEXT PRIMARY KEY,
    "workspaceId" TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    "maxUses" INTEGER DEFAULT 10,
    "useCount" INTEGER DEFAULT 0,
    "expiresAt" TIMESTAMPTZ,
    "createdBy" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ws_invites_ws ON workspace_invites("workspaceId");
CREATE INDEX IF NOT EXISTS idx_ws_invites_code ON workspace_invites(code);

-- ============================================================
-- Notebook members & share links
-- ============================================================

CREATE TABLE IF NOT EXISTS notebook_members (
    id TEXT PRIMARY KEY,
    "notebookId" TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'viewer',
    status TEXT NOT NULL DEFAULT 'active',
    "invitedBy" TEXT REFERENCES users(id) ON DELETE SET NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notebook_members_notebook ON notebook_members("notebookId");
CREATE INDEX IF NOT EXISTS idx_notebook_members_user ON notebook_members("userId");

CREATE TABLE IF NOT EXISTS notebook_share_links (
    id TEXT PRIMARY KEY,
    "notebookId" TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    enabled BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMPTZ,
    "createdBy" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notebook_share_links_notebook ON notebook_share_links("notebookId");
CREATE INDEX IF NOT EXISTS idx_notebook_share_links_token ON notebook_share_links(token);

-- ============================================================
-- Note ACL
-- ============================================================

CREATE TABLE IF NOT EXISTS note_acl (
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("noteId", "userId")
);

CREATE INDEX IF NOT EXISTS idx_note_acl_note ON note_acl("noteId");
CREATE INDEX IF NOT EXISTS idx_note_acl_user ON note_acl("userId");

-- ============================================================
-- Note links
-- ============================================================

CREATE TABLE IF NOT EXISTS note_links (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "sourceNoteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "targetNoteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "linkText" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "targetBlockId" TEXT,
    "sourceBlockId" TEXT,
    "linkType" TEXT NOT NULL DEFAULT 'note',
    excerpt TEXT
);

CREATE INDEX IF NOT EXISTS idx_note_links_user_source ON note_links("userId", "sourceNoteId");
CREATE INDEX IF NOT EXISTS idx_note_links_user_target ON note_links("userId", "targetNoteId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_note_links_unique_note ON note_links("userId", "sourceNoteId", "targetNoteId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_note_links_unique_block ON note_links("userId", "sourceNoteId", "targetNoteId", "targetBlockId");
CREATE INDEX IF NOT EXISTS idx_note_links_user_link_type ON note_links("userId", "linkType");
CREATE INDEX IF NOT EXISTS idx_note_links_user_target_block ON note_links("userId", "targetNoteId", "targetBlockId");

-- ============================================================
-- Note versions
-- ============================================================

CREATE TABLE IF NOT EXISTS note_versions (
    id TEXT PRIMARY KEY,
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    content TEXT,
    "contentText" TEXT,
    "contentFormat" TEXT NOT NULL DEFAULT 'tiptap-json',
    version INTEGER NOT NULL,
    "changeType" TEXT DEFAULT 'edit',
    "changeSummary" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions("noteId", version);

-- ============================================================
-- Y.js sync
-- ============================================================

CREATE TABLE IF NOT EXISTS note_ysnapshots (
    "noteId" TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    snapshot_blob BYTEA NOT NULL,
    "updatesMergedTo" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS note_yupdates (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "userId" TEXT,
    update_blob BYTEA NOT NULL,
    clock INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_yupdates_note ON note_yupdates("noteId", id);

-- ============================================================
-- Embeddings
-- ============================================================

CREATE TABLE IF NOT EXISTS note_embeddings (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "workspaceId" TEXT,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "chunkText" TEXT NOT NULL DEFAULT '',
    "vectorJson" TEXT NOT NULL DEFAULT '[]',
    "entityType" TEXT NOT NULL DEFAULT 'note',
    "attachmentId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_embeddings_note ON note_embeddings("noteId");
CREATE INDEX IF NOT EXISTS idx_note_embeddings_user ON note_embeddings("userId");
CREATE INDEX IF NOT EXISTS idx_note_embeddings_ws ON note_embeddings("workspaceId");
CREATE INDEX IF NOT EXISTS idx_note_embeddings_user_ws ON note_embeddings("userId", "workspaceId");
CREATE INDEX IF NOT EXISTS idx_note_embeddings_model ON note_embeddings(model);
CREATE INDEX IF NOT EXISTS idx_note_embeddings_attachment ON note_embeddings("attachmentId");

CREATE TABLE IF NOT EXISTS embedding_queue (
    "noteId" TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    retries INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "enqueuedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_embedding_queue_user_ws ON embedding_queue("userId", "workspaceId");
CREATE INDEX IF NOT EXISTS idx_embedding_queue_status ON embedding_queue(status, "enqueuedAt");

-- ============================================================
-- Attachments
-- ============================================================

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "workspaceId" TEXT,
    hash TEXT,
    "uploadSource" TEXT,
    "folderId" TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_user_ws_hash ON attachments("userId", "workspaceId", hash);
CREATE INDEX IF NOT EXISTS idx_attachments_workspace ON attachments("workspaceId");

CREATE TABLE IF NOT EXISTS attachment_chunks (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "attachmentId" TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "chunkText" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachment_chunks_attachment ON attachment_chunks("attachmentId");

CREATE TABLE IF NOT EXISTS attachment_folders (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    name TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachment_folders_user ON attachment_folders("userId");
CREATE INDEX IF NOT EXISTS idx_attachment_folders_parent ON attachment_folders("parentId");

CREATE TABLE IF NOT EXISTS attachment_references (
    "attachmentId" TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("attachmentId", "noteId")
);

CREATE INDEX IF NOT EXISTS idx_attachment_references_note ON attachment_references("noteId");
CREATE INDEX IF NOT EXISTS idx_attachment_references_attachment ON attachment_references("attachmentId");

CREATE TABLE IF NOT EXISTS attachment_embedding_queue (
    "attachmentId" TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "noteId" TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retries INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "enqueuedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachment_queue_user_ws ON attachment_embedding_queue("userId", "workspaceId");
CREATE INDEX IF NOT EXISTS idx_attachment_queue_status ON attachment_embedding_queue(status, "enqueuedAt");

-- ============================================================
-- Favorites
-- ============================================================

CREATE TABLE IF NOT EXISTS favorites (
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "workspaceId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("userId", "noteId")
);

CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites("userId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_favorites_note ON favorites("noteId");
CREATE INDEX IF NOT EXISTS idx_favorites_workspace ON favorites("workspaceId");

-- ============================================================
-- Tasks
-- ============================================================

CREATE TABLE IF NOT EXISTS task_projects (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "workspaceId" TEXT,
    name TEXT NOT NULL,
    icon TEXT DEFAULT 'folder',
    color TEXT DEFAULT '#6366f1',
    "sortOrder" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_projects_user ON task_projects("userId");
CREATE INDEX IF NOT EXISTS idx_task_projects_ws ON task_projects("workspaceId");

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    "isCompleted" BOOLEAN DEFAULT false,
    "completedAt" TIMESTAMPTZ,
    priority INTEGER DEFAULT 2,
    "dueDate" TEXT,
    "noteId" TEXT REFERENCES notes(id) ON DELETE SET NULL,
    "parentId" TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    "sortOrder" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "workspaceId" TEXT,
    "dueAt" TIMESTAMPTZ,
    "projectId" TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    "repeatRule" TEXT NOT NULL DEFAULT 'none',
    "repeatInterval" INTEGER NOT NULL DEFAULT 1,
    "repeatEndDate" TEXT,
    "repeatGroupId" TEXT,
    "repeatGeneratedFromId" TEXT,
    "repeatNextGeneratedId" TEXT,
    "repeatEndCount" INTEGER,
    "repeatSequenceIndex" INTEGER,
    "startDate" TEXT,
    description TEXT NOT NULL DEFAULT '',
    "repeatRuleJson" TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks("userId");
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks("parentId");
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks("dueDate");
CREATE INDEX IF NOT EXISTS idx_tasks_dueAt ON tasks("dueAt");
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks("workspaceId");
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks("isCompleted");
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks("completedAt");
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks("projectId");

CREATE TABLE IF NOT EXISTS task_templates (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "workspaceId" TEXT,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    color TEXT,
    items TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_templates_user ON task_templates("userId");
CREATE INDEX IF NOT EXISTS idx_task_templates_workspace ON task_templates("workspaceId");

CREATE TABLE IF NOT EXISTS task_reminders (
    id TEXT PRIMARY KEY,
    "taskId" TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "offsetMinutes" INTEGER NOT NULL DEFAULT 30,
    enabled BOOLEAN NOT NULL DEFAULT true,
    "lastNotifiedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "snoozedUntil" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_task_reminders_task ON task_reminders("taskId");
CREATE INDEX IF NOT EXISTS idx_task_reminders_enabled ON task_reminders(enabled);

CREATE TABLE IF NOT EXISTS task_dependencies (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "predecessorTaskId" TEXT NOT NULL,
    "successorTaskId" TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'finish_to_start',
    "createdAt" TIMESTAMPTZ DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_dependencies_unique ON task_dependencies("predecessorTaskId", "successorTaskId", type);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_predecessor ON task_dependencies("predecessorTaskId");
CREATE INDEX IF NOT EXISTS idx_task_dependencies_successor ON task_dependencies("successorTaskId");
CREATE INDEX IF NOT EXISTS idx_task_dependencies_user ON task_dependencies("userId");
CREATE INDEX IF NOT EXISTS idx_task_dependencies_workspace ON task_dependencies("workspaceId");

CREATE TABLE IF NOT EXISTS task_attachments (
    id TEXT PRIMARY KEY,
    "taskId" TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "workspaceId" TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments("taskId");
CREATE INDEX IF NOT EXISTS idx_task_attachments_user_created ON task_attachments("userId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_task_attachments_workspace ON task_attachments("workspaceId");

CREATE TABLE IF NOT EXISTS task_calendar_feeds (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "workspaceId" TEXT,
    token TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    "includeCompleted" BOOLEAN NOT NULL DEFAULT false,
    "includeDescription" BOOLEAN NOT NULL DEFAULT true,
    "defaultAlarmMinutes" INTEGER NOT NULL DEFAULT 30,
    "lastAccessedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_calendar_feeds_token ON task_calendar_feeds(token);
CREATE INDEX IF NOT EXISTS idx_task_calendar_feeds_user ON task_calendar_feeds("userId");

-- ============================================================
-- Shares & comments
-- ============================================================

CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "ownerId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "shareToken" TEXT NOT NULL,
    "shareType" TEXT NOT NULL DEFAULT 'link',
    permission TEXT NOT NULL DEFAULT 'view',
    password TEXT,
    "expiresAt" TIMESTAMPTZ,
    "maxViews" INTEGER,
    "viewCount" INTEGER DEFAULT 0,
    "isActive" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shares_note ON shares("noteId");
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares("ownerId");
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares("shareToken");

CREATE TABLE IF NOT EXISTS share_comments (
    id TEXT PRIMARY KEY,
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "userId" TEXT REFERENCES users(id) ON DELETE SET NULL,
    "guestName" TEXT,
    "guestIpHash" TEXT,
    "parentId" TEXT REFERENCES share_comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    "anchorData" TEXT,
    "isResolved" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_comments_note ON share_comments("noteId");
CREATE INDEX IF NOT EXISTS idx_share_comments_guest_ip ON share_comments("guestIpHash", "createdAt");

-- ============================================================
-- Diaries
-- ============================================================

CREATE TABLE IF NOT EXISTS diaries (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "contentText" TEXT DEFAULT '',
    mood TEXT DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    media TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "workspaceId" TEXT
);

CREATE INDEX IF NOT EXISTS idx_diaries_user_created ON diaries("userId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_diaries_workspace ON diaries("workspaceId");

CREATE TABLE IF NOT EXISTS diary_attachments (
    id TEXT PRIMARY KEY,
    "diaryId" TEXT REFERENCES diaries(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "mimeType" TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "workspaceId" TEXT
);

CREATE INDEX IF NOT EXISTS idx_diary_attachments_diary ON diary_attachments("diaryId");
CREATE INDEX IF NOT EXISTS idx_diary_attachments_user_created ON diary_attachments("userId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_diary_attachments_workspace ON diary_attachments("workspaceId");

-- ============================================================
-- Other tables
-- ============================================================

CREATE TABLE IF NOT EXISTS mindmap_folders (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "workspaceId" TEXT,
    "parentId" TEXT,
    name TEXT NOT NULL DEFAULT '未命名文件夹',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mindmap_folders_user ON mindmap_folders("userId");
CREATE INDEX IF NOT EXISTS idx_mindmap_folders_parent ON mindmap_folders("parentId");
CREATE INDEX IF NOT EXISTS idx_mindmap_folders_workspace ON mindmap_folders("workspaceId");

CREATE TABLE IF NOT EXISTS folder_sync_files (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sourcePathHash" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folder_sync_files_note ON folder_sync_files("noteId");
CREATE INDEX IF NOT EXISTS idx_folder_sync_files_user_hash ON folder_sync_files("userId", "sourcePathHash");

CREATE TABLE IF NOT EXISTS calendar_export_targets (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "feedId" TEXT NOT NULL REFERENCES task_calendar_feeds(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    name TEXT NOT NULL DEFAULT '',
    "configJson" TEXT NOT NULL,
    "publicUrl" TEXT,
    "lastExportAt" TIMESTAMPTZ,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_export_targets_user ON calendar_export_targets("userId");
CREATE INDEX IF NOT EXISTS idx_calendar_export_targets_feed ON calendar_export_targets("feedId");
CREATE INDEX IF NOT EXISTS idx_calendar_export_targets_enabled ON calendar_export_targets(enabled);

CREATE TABLE IF NOT EXISTS custom_fonts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    format TEXT NOT NULL,
    "fileSize" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt" TIMESTAMPTZ,
    ip TEXT DEFAULT '',
    "userAgent" TEXT DEFAULT '',
    "deviceLabel" TEXT,
    "revokedAt" TIMESTAMPTZ,
    "revokedReason" TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions("userId", "revokedAt", "lastSeenAt");

CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "lastUsedAt" TIMESTAMPTZ,
    "lastUsedIp" TEXT,
    "expiresAt" TIMESTAMPTZ,
    "revokedAt" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens("userId");

CREATE TABLE IF NOT EXISTS ai_custom_prompts (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_custom_prompts_user_name ON ai_custom_prompts("userId", name);
CREATE INDEX IF NOT EXISTS idx_ai_custom_prompts_user_usage ON ai_custom_prompts("userId", "usageCount", "updatedAt");

CREATE TABLE IF NOT EXISTS ai_chat_conversations (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    archived BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_conv_user ON ai_chat_conversations("userId", archived, "updatedAt");

CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "conversationId" TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    "referencesJson" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_msg_conv ON ai_chat_messages("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_ai_chat_user_created ON ai_chat_messages("userId", "createdAt");

-- ============================================================
-- Migration tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (version, name)
);
