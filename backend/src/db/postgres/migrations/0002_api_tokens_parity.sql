ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS "tokenHash" TEXT;

ALTER TABLE api_tokens
  ADD COLUMN IF NOT EXISTS scopes TEXT NOT NULL DEFAULT '[]';

UPDATE api_tokens
SET "tokenHash" = token_hash
WHERE "tokenHash" IS NULL;

ALTER TABLE api_tokens
  ALTER COLUMN "tokenHash" SET NOT NULL;

-- Legacy pilot columns remain readable during upgrade, but no longer block
-- writes from the current Repository contract.
ALTER TABLE api_tokens
  ALTER COLUMN "tokenId" DROP NOT NULL;

ALTER TABLE api_tokens
  ALTER COLUMN token_hash DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash
  ON api_tokens("tokenHash");

CREATE TABLE IF NOT EXISTS api_token_usage (
  "tokenId" TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("tokenId", day)
);

CREATE INDEX IF NOT EXISTS idx_api_token_usage_day
  ON api_token_usage(day);
