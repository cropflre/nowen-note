ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS "resourceMode" TEXT NOT NULL DEFAULT 'unrestricted';

ALTER TABLE api_tokens
  DROP CONSTRAINT IF EXISTS api_tokens_resource_mode_check;

ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_resource_mode_check
  CHECK ("resourceMode" IN ('unrestricted', 'restricted'));

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
