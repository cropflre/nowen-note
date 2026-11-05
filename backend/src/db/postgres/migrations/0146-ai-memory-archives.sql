-- Storage parity only. The AI archive product runtime currently uses SQLite.
CREATE TABLE external_ai_sources (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, "accountScope" TEXT NOT NULL, "displayName" TEXT NOT NULL,
  "notebookId" TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, "captureEnabled" INTEGER NOT NULL DEFAULT 0,
  "permissionState" TEXT NOT NULL CHECK("permissionState" IN ('granted','revoked')),
  "lastSyncedAt" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL,
  UNIQUE("userId",provider,"accountScope")
);
CREATE INDEX external_ai_sources_owner ON external_ai_sources("userId","notebookId");
CREATE TABLE external_ai_conversations (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "sourceId" TEXT NOT NULL REFERENCES external_ai_sources(id) ON DELETE CASCADE, "externalConversationId" TEXT NOT NULL,
  title TEXT NOT NULL, "sourceUrl" TEXT NOT NULL, completeness TEXT NOT NULL,
  "noteId" TEXT REFERENCES notes(id) ON DELETE SET NULL, "projectionHash" TEXT,
  "projectionStatus" TEXT NOT NULL DEFAULT 'updated', revision INTEGER NOT NULL DEFAULT 1,
  "contentHash" TEXT NOT NULL, "lastSnapshotHash" TEXT NOT NULL,
  "lastSyncedAt" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL, "deletedAt" TEXT,
  UNIQUE("userId","sourceId","externalConversationId")
);
CREATE INDEX external_ai_conversations_owner ON external_ai_conversations("userId","sourceId","updatedAt");
CREATE TABLE external_ai_messages (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "conversationId" TEXT NOT NULL REFERENCES external_ai_conversations(id) ON DELETE CASCADE,
  "externalMessageId" TEXT NOT NULL, "identityState" TEXT NOT NULL,
  sequence INTEGER NOT NULL, role TEXT NOT NULL, "blocksJson" TEXT NOT NULL,
  "contentText" TEXT NOT NULL, "contentHash" TEXT NOT NULL, "captureState" TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL,
  UNIQUE("conversationId","externalMessageId")
);
CREATE INDEX external_ai_messages_order ON external_ai_messages("conversationId",sequence);
CREATE TABLE external_ai_message_revisions (
  "messageId" TEXT NOT NULL REFERENCES external_ai_messages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, "blocksJson" TEXT NOT NULL, "contentText" TEXT NOT NULL,
  role TEXT NOT NULL, "contentHash" TEXT NOT NULL, "createdAt" TEXT NOT NULL,
  PRIMARY KEY("messageId",revision)
);
CREATE TABLE ai_conversation_sync_operations (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "sourceId" TEXT NOT NULL REFERENCES external_ai_sources(id) ON DELETE CASCADE,
  "conversationId" TEXT NOT NULL REFERENCES external_ai_conversations(id) ON DELETE CASCADE,
  "operationId" TEXT NOT NULL, "payloadHash" TEXT NOT NULL, status TEXT NOT NULL,
  "resultJson" TEXT NOT NULL, "createdAt" TEXT NOT NULL, UNIQUE("userId","sourceId","operationId")
);
CREATE INDEX ai_conversation_sync_operations_conversation ON ai_conversation_sync_operations("conversationId");
