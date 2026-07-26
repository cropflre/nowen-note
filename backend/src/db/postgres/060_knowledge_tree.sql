-- Issue #370 P0-C / P1: unified navigation tree and granular capabilities.
-- Apply after schema.base.sql. Existing business tables remain authoritative.

CREATE TABLE IF NOT EXISTS knowledge_tree_nodes (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "workspaceId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "parentId" TEXT REFERENCES knowledge_tree_nodes(id) ON DELETE SET NULL,
    "nodeType" TEXT NOT NULL CHECK ("nodeType" IN ('folder', 'note', 'markdown', 'word', 'mindmap', 'file')),
    "resourceType" TEXT NOT NULL CHECK ("resourceType" IN ('notebook', 'note', 'mindmap', 'file')),
    "resourceId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isExpanded" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE ("scopeKey", "resourceType", "resourceId")
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tree_scope_parent
    ON knowledge_tree_nodes ("scopeKey", "parentId", "sortOrder", "createdAt");
CREATE INDEX IF NOT EXISTS idx_knowledge_tree_resource
    ON knowledge_tree_nodes ("resourceType", "resourceId");
CREATE INDEX IF NOT EXISTS idx_knowledge_tree_workspace
    ON knowledge_tree_nodes ("workspaceId", "isDeleted");

CREATE TABLE IF NOT EXISTS knowledge_tree_acl (
    "nodeId" TEXT NOT NULL REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "rolePreset" TEXT NOT NULL CHECK ("rolePreset" IN ('readonly', 'editor', 'maintainer', 'admin')),
    "canView" BOOLEAN NOT NULL DEFAULT true,
    "canComment" BOOLEAN NOT NULL DEFAULT false,
    "canCreate" BOOLEAN NOT NULL DEFAULT false,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "canMove" BOOLEAN NOT NULL DEFAULT false,
    "canDownload" BOOLEAN NOT NULL DEFAULT true,
    "canReshare" BOOLEAN NOT NULL DEFAULT false,
    "canManageMembers" BOOLEAN NOT NULL DEFAULT false,
    "grantedBy" TEXT REFERENCES users(id) ON DELETE SET NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("nodeId", "userId")
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tree_acl_user
    ON knowledge_tree_acl ("userId", "nodeId");

CREATE TABLE IF NOT EXISTS knowledge_tree_history (
    id TEXT PRIMARY KEY,
    "nodeId" TEXT NOT NULL REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN (
        'create', 'move', 'reorder', 'delete_subtree', 'delete_promote',
        'restore', 'permission_set', 'permission_clear'
    )),
    "actorUserId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "fromParentId" TEXT,
    "toParentId" TEXT,
    "targetUserId" TEXT REFERENCES users(id) ON DELETE SET NULL,
    metadata JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tree_history_node
    ON knowledge_tree_history ("nodeId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_tree_history_actor
    ON knowledge_tree_history ("actorUserId", "createdAt" DESC);

INSERT INTO knowledge_tree_nodes (
    id, "userId", "workspaceId", "scopeKey", "parentId", "nodeType", "resourceType",
    "resourceId", "sortOrder", "isExpanded", "isDeleted", "deletedAt", "createdAt", "updatedAt"
)
SELECT
    'notebook:' || nb.id,
    nb."userId",
    nb."workspaceId",
    CASE WHEN nb."workspaceId" IS NULL THEN 'personal:' || nb."userId" ELSE 'workspace:' || nb."workspaceId" END,
    CASE WHEN nb."parentId" IS NULL THEN NULL ELSE 'notebook:' || nb."parentId" END,
    'folder', 'notebook', nb.id, COALESCE(nb."sortOrder", 0), COALESCE(nb."isExpanded", true),
    COALESCE(nb."isDeleted", false), nb."deletedAt", nb."createdAt", nb."updatedAt"
FROM notebooks nb
ON CONFLICT ("scopeKey", "resourceType", "resourceId") DO NOTHING;

INSERT INTO knowledge_tree_nodes (
    id, "userId", "workspaceId", "scopeKey", "parentId", "nodeType", "resourceType",
    "resourceId", "sortOrder", "isExpanded", "isDeleted", "deletedAt", "createdAt", "updatedAt"
)
SELECT
    'note:' || n.id,
    n."userId",
    n."workspaceId",
    CASE WHEN n."workspaceId" IS NULL THEN 'personal:' || n."userId" ELSE 'workspace:' || n."workspaceId" END,
    'notebook:' || n."notebookId",
    CASE WHEN n.note_type = 'word' THEN 'word' WHEN n."contentFormat" = 'markdown' THEN 'markdown' ELSE 'note' END,
    'note', n.id, COALESCE(n."sortOrder", 0), true, COALESCE(n."isTrashed", false),
    n."trashedAt", n."createdAt", n."updatedAt"
FROM notes n
ON CONFLICT ("scopeKey", "resourceType", "resourceId") DO NOTHING;

CREATE OR REPLACE FUNCTION knowledge_tree_validate_parent() RETURNS trigger AS $$
BEGIN
    IF NEW."parentId" IS NULL THEN RETURN NEW; END IF;
    IF NEW."parentId" = NEW.id THEN
        RAISE EXCEPTION 'KNOWLEDGE_TREE_SELF_PARENT';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM knowledge_tree_nodes p
        WHERE p.id = NEW."parentId" AND p."scopeKey" = NEW."scopeKey" AND p."isDeleted" = false
    ) THEN
        RAISE EXCEPTION 'KNOWLEDGE_TREE_PARENT_SCOPE_MISMATCH';
    END IF;
    IF EXISTS (
        WITH RECURSIVE descendants(id) AS (
            SELECT id FROM knowledge_tree_nodes WHERE "parentId" = NEW.id AND "isDeleted" = false
            UNION ALL
            SELECT child.id FROM knowledge_tree_nodes child
            JOIN descendants parent ON child."parentId" = parent.id
            WHERE child."isDeleted" = false
        )
        SELECT 1 FROM descendants WHERE id = NEW."parentId"
    ) THEN
        RAISE EXCEPTION 'KNOWLEDGE_TREE_CYCLE';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS knowledge_tree_parent_guard ON knowledge_tree_nodes;
CREATE TRIGGER knowledge_tree_parent_guard
BEFORE INSERT OR UPDATE OF "parentId", "scopeKey" ON knowledge_tree_nodes
FOR EACH ROW EXECUTE FUNCTION knowledge_tree_validate_parent();

CREATE OR REPLACE FUNCTION knowledge_tree_sync_notebook() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM knowledge_tree_nodes WHERE "resourceType" = 'notebook' AND "resourceId" = OLD.id;
        RETURN OLD;
    END IF;
    INSERT INTO knowledge_tree_nodes (
        id, "userId", "workspaceId", "scopeKey", "parentId", "nodeType", "resourceType",
        "resourceId", "sortOrder", "isExpanded", "isDeleted", "deletedAt", "createdAt", "updatedAt"
    ) VALUES (
        'notebook:' || NEW.id, NEW."userId", NEW."workspaceId",
        CASE WHEN NEW."workspaceId" IS NULL THEN 'personal:' || NEW."userId" ELSE 'workspace:' || NEW."workspaceId" END,
        CASE WHEN NEW."parentId" IS NULL THEN NULL ELSE 'notebook:' || NEW."parentId" END,
        'folder', 'notebook', NEW.id, COALESCE(NEW."sortOrder", 0), COALESCE(NEW."isExpanded", true),
        COALESCE(NEW."isDeleted", false), NEW."deletedAt", NEW."createdAt", NEW."updatedAt"
    ) ON CONFLICT ("scopeKey", "resourceType", "resourceId") DO UPDATE SET
        "userId" = EXCLUDED."userId", "workspaceId" = EXCLUDED."workspaceId",
        "scopeKey" = EXCLUDED."scopeKey", "parentId" = EXCLUDED."parentId",
        "sortOrder" = EXCLUDED."sortOrder", "isExpanded" = EXCLUDED."isExpanded",
        "isDeleted" = EXCLUDED."isDeleted", "deletedAt" = EXCLUDED."deletedAt",
        "updatedAt" = EXCLUDED."updatedAt";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS knowledge_tree_notebooks_sync ON notebooks;
CREATE TRIGGER knowledge_tree_notebooks_sync
AFTER INSERT OR UPDATE OR DELETE ON notebooks
FOR EACH ROW EXECUTE FUNCTION knowledge_tree_sync_notebook();

CREATE OR REPLACE FUNCTION knowledge_tree_sync_note() RETURNS trigger AS $$
DECLARE
    existing_parent TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM knowledge_tree_nodes WHERE "resourceType" = 'note' AND "resourceId" = OLD.id;
        RETURN OLD;
    END IF;
    SELECT "parentId" INTO existing_parent
      FROM knowledge_tree_nodes WHERE "resourceType" = 'note' AND "resourceId" = NEW.id LIMIT 1;
    INSERT INTO knowledge_tree_nodes (
        id, "userId", "workspaceId", "scopeKey", "parentId", "nodeType", "resourceType",
        "resourceId", "sortOrder", "isExpanded", "isDeleted", "deletedAt", "createdAt", "updatedAt"
    ) VALUES (
        'note:' || NEW.id, NEW."userId", NEW."workspaceId",
        CASE WHEN NEW."workspaceId" IS NULL THEN 'personal:' || NEW."userId" ELSE 'workspace:' || NEW."workspaceId" END,
        COALESCE(existing_parent, 'notebook:' || NEW."notebookId"),
        CASE WHEN NEW.note_type = 'word' THEN 'word' WHEN NEW."contentFormat" = 'markdown' THEN 'markdown' ELSE 'note' END,
        'note', NEW.id, COALESCE(NEW."sortOrder", 0), true, COALESCE(NEW."isTrashed", false),
        NEW."trashedAt", NEW."createdAt", NEW."updatedAt"
    ) ON CONFLICT ("scopeKey", "resourceType", "resourceId") DO UPDATE SET
        "userId" = EXCLUDED."userId", "workspaceId" = EXCLUDED."workspaceId",
        "scopeKey" = EXCLUDED."scopeKey", "nodeType" = EXCLUDED."nodeType",
        "sortOrder" = EXCLUDED."sortOrder", "isDeleted" = EXCLUDED."isDeleted",
        "deletedAt" = EXCLUDED."deletedAt", "updatedAt" = EXCLUDED."updatedAt";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS knowledge_tree_notes_sync ON notes;
CREATE TRIGGER knowledge_tree_notes_sync
AFTER INSERT OR UPDATE OR DELETE ON notes
FOR EACH ROW EXECUTE FUNCTION knowledge_tree_sync_note();
