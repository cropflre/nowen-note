-- Advisory 威胁分类与按 Registry source 的全局 sequence 防回放状态。
BEGIN;

ALTER TABLE plugin_registry
  ADD COLUMN IF NOT EXISTS "advisoryAutoDisabled" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE plugin_security_advisories
  ADD COLUMN IF NOT EXISTS "threatState" TEXT NOT NULL DEFAULT 'vulnerable'
  CHECK ("threatState" IN ('vulnerable', 'revoked', 'malicious'));

CREATE TABLE IF NOT EXISTS plugin_advisory_sequence_state (
  "sourceId" TEXT PRIMARY KEY REFERENCES plugin_sources(id) ON DELETE CASCADE,
  "highestSeenSequence" BIGINT NOT NULL CHECK ("highestSeenSequence" >= 0),
  "documentJson" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM plugin_security_advisories
    GROUP BY "sourceId", sequence HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Advisory 历史数据存在全局 sequence 冲突';
  END IF;
  IF EXISTS (
    SELECT 1 FROM plugin_security_advisories
    WHERE (("documentJson"::jsonb ->> 'sequence')::BIGINT) IS DISTINCT FROM sequence
  ) THEN
    RAISE EXCEPTION 'Advisory 历史文档 sequence 不一致';
  END IF;
END $$;

INSERT INTO plugin_advisory_sequence_state("sourceId", "highestSeenSequence", "documentJson", "updatedAt")
SELECT DISTINCT ON ("sourceId") "sourceId", sequence, "documentJson", "updatedAt"
FROM plugin_security_advisories
ORDER BY "sourceId", sequence DESC, "advisoryId"
ON CONFLICT ("sourceId") DO NOTHING;

COMMIT;
