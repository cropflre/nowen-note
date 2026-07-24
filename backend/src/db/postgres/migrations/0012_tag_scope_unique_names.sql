-- Align PostgreSQL tag uniqueness with SQLite v59.
-- Personal tags are unique by (userId, normalized name).
-- Workspace tags are unique by (workspaceId, normalized name), regardless of creator.

CREATE TEMP TABLE tag_scope_canonical_map ON COMMIT DROP AS
SELECT
  t.id AS old_id,
  FIRST_VALUE(t.id) OVER (
    PARTITION BY
      CASE
        WHEN t."workspaceId" IS NULL THEN 'personal:' || t."userId"
        ELSE 'workspace:' || t."workspaceId"
      END,
      lower(trim(t.name))
    ORDER BY t."createdAt" ASC, t.id ASC
  ) AS canonical_id
FROM tags t;

INSERT INTO note_tags ("noteId", "tagId")
SELECT DISTINCT nt."noteId", mapping.canonical_id
FROM note_tags nt
JOIN tag_scope_canonical_map mapping ON mapping.old_id = nt."tagId"
ON CONFLICT ("noteId", "tagId") DO NOTHING;

DELETE FROM note_tags nt
USING tag_scope_canonical_map mapping
WHERE nt."tagId" = mapping.old_id
  AND mapping.old_id <> mapping.canonical_id;

DELETE FROM tags t
USING tag_scope_canonical_map mapping
WHERE t.id = mapping.old_id
  AND mapping.old_id <> mapping.canonical_id;

UPDATE tags SET name = trim(name) WHERE name <> trim(name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_personal_name_unique
  ON tags ("userId", lower(trim(name)))
  WHERE "workspaceId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_workspace_name_unique
  ON tags ("workspaceId", lower(trim(name)))
  WHERE "workspaceId" IS NOT NULL;
