-- Issue #370 v64: avoid validating unchanged parents during state-only sync updates.

DROP TRIGGER IF EXISTS knowledge_tree_parent_guard ON knowledge_tree_nodes;
DROP TRIGGER IF EXISTS knowledge_tree_parent_guard_insert ON knowledge_tree_nodes;
DROP TRIGGER IF EXISTS knowledge_tree_parent_guard_update ON knowledge_tree_nodes;

CREATE TRIGGER knowledge_tree_parent_guard_insert
BEFORE INSERT ON knowledge_tree_nodes
FOR EACH ROW
EXECUTE FUNCTION knowledge_tree_validate_parent();

CREATE TRIGGER knowledge_tree_parent_guard_update
BEFORE UPDATE OF "parentId", "scopeKey" ON knowledge_tree_nodes
FOR EACH ROW
WHEN (
    OLD."parentId" IS DISTINCT FROM NEW."parentId"
    OR OLD."scopeKey" IS DISTINCT FROM NEW."scopeKey"
)
EXECUTE FUNCTION knowledge_tree_validate_parent();
