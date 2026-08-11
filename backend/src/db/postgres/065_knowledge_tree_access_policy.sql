-- Knowledge tree restricted access policy (Issue #643)
--
-- A policy row marks a node as an allowlist boundary. Workspace membership alone
-- must not grant visibility below that node; effective access must come from a
-- knowledge_tree_acl row on the boundary or one of its descendants.
-- isExplicit distinguishes a manual private boundary from the automatic boundary
-- created when the first direct member is added.

CREATE TABLE IF NOT EXISTS knowledge_tree_access_policies (
  "nodeId" TEXT PRIMARY KEY
    REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
  "accessMode" TEXT NOT NULL DEFAULT 'restricted'
    CHECK ("accessMode" IN ('inherit', 'restricted')),
  "isExplicit" INTEGER NOT NULL DEFAULT 0
    CHECK ("isExplicit" IN (0, 1)),
  "updatedBy" TEXT
    REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE knowledge_tree_access_policies
  ADD COLUMN IF NOT EXISTS "isExplicit" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_knowledge_tree_access_policy_mode
  ON knowledge_tree_access_policies("accessMode", "nodeId");

-- Existing explicit ACLs were presented to users as a member list, so migrate
-- them to automatic restricted boundaries. Removing the final member can then
-- restore inheritance, while a manually selected empty restricted mode persists.
INSERT INTO knowledge_tree_access_policies (
  "nodeId",
  "accessMode",
  "isExplicit",
  "updatedBy",
  "createdAt",
  "updatedAt"
)
SELECT
  "nodeId",
  'restricted',
  0,
  MAX("grantedBy"),
  MIN("createdAt"),
  MAX("updatedAt")
FROM knowledge_tree_acl
GROUP BY "nodeId"
ON CONFLICT ("nodeId") DO NOTHING;
