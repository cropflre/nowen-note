-- Explicit per-member deny rules for the unified knowledge tree.
--
-- A denial applies to the target node and descendants. The effective resolver
-- compares the nearest allow and deny rule; the more specific rule wins and a
-- denial wins at equal depth. Workspace owners remain an unconditional bypass.

CREATE TABLE IF NOT EXISTS knowledge_tree_denials (
  "nodeId" TEXT NOT NULL
    REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,
  "deniedBy" TEXT
    REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("nodeId", "userId")
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tree_denials_user
  ON knowledge_tree_denials("userId", "nodeId");
