-- API Token resource scope schema for PostgreSQL
-- Safe to apply repeatedly during SQLite -> PostgreSQL migration validation.

ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS scopes TEXT NOT NULL DEFAULT '[]';

ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS "resourceMode" TEXT NOT NULL DEFAULT 'unrestricted';

-- Normalize the historical draft schema to the runtime naming contract when possible.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_tokens' AND column_name = 'token_hash'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_tokens' AND column_name = 'tokenHash'
  ) THEN
    ALTER TABLE api_tokens RENAME COLUMN token_hash TO "tokenHash";
  END IF;
END $$;

ALTER TABLE api_tokens
  DROP CONSTRAINT IF EXISTS api_tokens_resource_mode_check;
ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_resource_mode_check
  CHECK ("resourceMode" IN ('unrestricted', 'restricted'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_hash
  ON api_tokens("tokenHash");
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_active
  ON api_tokens("userId", "revokedAt");

CREATE TABLE IF NOT EXISTS api_token_usage (
  "tokenId" TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("tokenId", day)
);

CREATE INDEX IF NOT EXISTS idx_api_token_usage_day
  ON api_token_usage(day);

CREATE TABLE IF NOT EXISTS api_token_resources (
  id TEXT PRIMARY KEY,
  "tokenId" TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  "resourceType" TEXT NOT NULL DEFAULT 'notebook',
  "resourceId" TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  "includeDescendants" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("tokenId", "resourceType", "resourceId"),
  CHECK ("resourceType" IN ('notebook')),
  CHECK (permission IN ('read', 'write'))
);

CREATE INDEX IF NOT EXISTS idx_api_token_resources_token
  ON api_token_resources("tokenId", "resourceType");
CREATE INDEX IF NOT EXISTS idx_api_token_resources_resource
  ON api_token_resources("resourceType", "resourceId");
