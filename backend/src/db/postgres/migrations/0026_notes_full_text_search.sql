-- PG-FTS-01 / Issue #252
-- PostgreSQL-native full-text search for notes, tags and attachments.
-- The `simple` configuration preserves identifiers and avoids language-specific
-- stemming surprises. The runtime retains a bounded literal fallback for Han,
-- short and punctuation-heavy terms, then verifies all terms in application code.

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, COALESCE("contentText", '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_notes_search_vector
  ON notes USING GIN ("searchVector");

CREATE INDEX IF NOT EXISTS idx_tags_search_vector
  ON tags USING GIN (to_tsvector('simple'::regconfig, COALESCE(name, '')));

CREATE INDEX IF NOT EXISTS idx_attachments_filename_search_vector
  ON attachments USING GIN (to_tsvector('simple'::regconfig, COALESCE(filename, '')));

CREATE INDEX IF NOT EXISTS idx_attachment_chunks_search_vector
  ON attachment_chunks USING GIN (
    to_tsvector('simple'::regconfig, COALESCE("chunkText", ''))
  );

COMMENT ON COLUMN notes."searchVector" IS
  'Weighted PostgreSQL full-text vector: title=A, contentText=B (Issue #252)';

ANALYZE notes;
ANALYZE tags;
ANALYZE attachments;
ANALYZE attachment_chunks;
