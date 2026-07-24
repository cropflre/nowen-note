-- Issue #370 v63: preserve unified-tree parents that point to documents.
-- The business notebooks.parentId column still points at the nearest physical notebook container;
-- an unrelated sort/expand update must not overwrite the richer knowledge_tree_nodes.parentId.

CREATE OR REPLACE FUNCTION knowledge_tree_sync_notebook() RETURNS trigger AS $$
DECLARE
    existing_parent TEXT;
    next_parent TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM knowledge_tree_nodes WHERE "resourceType" = 'notebook' AND "resourceId" = OLD.id;
        RETURN OLD;
    END IF;

    SELECT "parentId" INTO existing_parent
      FROM knowledge_tree_nodes
     WHERE "resourceType" = 'notebook' AND "resourceId" = NEW.id
     LIMIT 1;

    IF TG_OP = 'UPDATE' AND OLD."parentId" IS NOT DISTINCT FROM NEW."parentId" THEN
        next_parent := existing_parent;
    ELSE
        next_parent := CASE WHEN NEW."parentId" IS NULL THEN NULL ELSE 'notebook:' || NEW."parentId" END;
    END IF;

    INSERT INTO knowledge_tree_nodes (
        id, "userId", "workspaceId", "scopeKey", "parentId", "nodeType", "resourceType",
        "resourceId", "sortOrder", "isExpanded", "isDeleted", "deletedAt", "createdAt", "updatedAt"
    ) VALUES (
        'notebook:' || NEW.id,
        NEW."userId",
        NEW."workspaceId",
        CASE WHEN NEW."workspaceId" IS NULL THEN 'personal:' || NEW."userId" ELSE 'workspace:' || NEW."workspaceId" END,
        next_parent,
        'folder',
        'notebook',
        NEW.id,
        COALESCE(NEW."sortOrder", 0),
        COALESCE(NEW."isExpanded", true),
        COALESCE(NEW."isDeleted", false),
        NEW."deletedAt",
        NEW."createdAt",
        NEW."updatedAt"
    ) ON CONFLICT ("scopeKey", "resourceType", "resourceId") DO UPDATE SET
        "userId" = EXCLUDED."userId",
        "workspaceId" = EXCLUDED."workspaceId",
        "scopeKey" = EXCLUDED."scopeKey",
        "parentId" = EXCLUDED."parentId",
        "sortOrder" = EXCLUDED."sortOrder",
        "isExpanded" = EXCLUDED."isExpanded",
        "isDeleted" = EXCLUDED."isDeleted",
        "deletedAt" = EXCLUDED."deletedAt",
        "updatedAt" = EXCLUDED."updatedAt";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS knowledge_tree_notebooks_sync ON notebooks;
CREATE TRIGGER knowledge_tree_notebooks_sync
AFTER INSERT OR UPDATE OR DELETE ON notebooks
FOR EACH ROW EXECUTE FUNCTION knowledge_tree_sync_notebook();
