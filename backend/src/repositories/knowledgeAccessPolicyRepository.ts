import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";

export type KnowledgeAccessMode = "inherit" | "restricted";

export interface KnowledgeAccessPolicyMatch {
  nodeId: string;
  accessMode: "restricted";
  depth: number;
}

export interface KnowledgeAccessPolicyState {
  accessMode: KnowledgeAccessMode;
  isExplicit: boolean;
}

const initializedDatabases = new WeakSet<Database.Database>();

function createPolicyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_tree_access_policies (
      nodeId TEXT PRIMARY KEY,
      accessMode TEXT NOT NULL DEFAULT 'restricted'
        CHECK(accessMode IN ('inherit', 'restricted')),
      isExplicit INTEGER NOT NULL DEFAULT 0,
      updatedBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (nodeId) REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (updatedBy) REFERENCES users(id) ON DELETE SET NULL
    );
  `);
}

function ensureCompatiblePolicySchema(db: Database.Database): void {
  const table = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'knowledge_tree_access_policies'
  `).get() as { sql: string | null } | undefined;
  if (!table) {
    createPolicyTable(db);
    return;
  }

  const columns = db.prepare("PRAGMA table_info(knowledge_tree_access_policies)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "isExplicit")) {
    db.exec(`
      ALTER TABLE knowledge_tree_access_policies
      ADD COLUMN isExplicit INTEGER NOT NULL DEFAULT 0;
    `);
  }

  const supportsInherit = /['\"]inherit['\"]/.test(table.sql || "");
  if (supportsInherit) return;

  db.transaction(() => {
    db.exec(`
      ALTER TABLE knowledge_tree_access_policies
      RENAME TO knowledge_tree_access_policies_legacy;
    `);
    createPolicyTable(db);
    db.exec(`
      INSERT INTO knowledge_tree_access_policies (
        nodeId, accessMode, isExplicit, updatedBy, createdAt, updatedAt
      )
      SELECT
        nodeId,
        CASE WHEN accessMode = 'restricted' THEN 'restricted' ELSE 'inherit' END,
        isExplicit,
        updatedBy,
        createdAt,
        updatedAt
      FROM knowledge_tree_access_policies_legacy;

      DROP TABLE knowledge_tree_access_policies_legacy;
    `);
  })();
}

export function ensureKnowledgeAccessPolicyTable(
  db: Database.Database = getDb(),
): void {
  if (initializedDatabases.has(db)) return;
  ensureKnowledgeTreeTables(db);
  ensureCompatiblePolicySchema(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_tree_access_policy_mode
      ON knowledge_tree_access_policies(accessMode, nodeId);

    INSERT OR IGNORE INTO knowledge_tree_access_policies (
      nodeId, accessMode, isExplicit, updatedBy, createdAt, updatedAt
    )
    SELECT
      nodeId,
      'restricted',
      0,
      MAX(grantedBy),
      MIN(createdAt),
      MAX(updatedAt)
    FROM knowledge_tree_acl
    GROUP BY nodeId;
  `);
  initializedDatabases.add(db);
}

export function getKnowledgeNodeAccessPolicy(
  nodeId: string,
  db: Database.Database = getDb(),
): KnowledgeAccessPolicyState {
  ensureKnowledgeAccessPolicyTable(db);
  const row = db.prepare(`
    SELECT accessMode, isExplicit
    FROM knowledge_tree_access_policies
    WHERE nodeId = ?
  `).get(nodeId) as { accessMode: KnowledgeAccessMode; isExplicit: number } | undefined;
  return row
    ? { accessMode: row.accessMode, isExplicit: row.isExplicit !== 0 }
    : { accessMode: "inherit", isExplicit: false };
}

export function getKnowledgeNodeAccessMode(
  nodeId: string,
  db: Database.Database = getDb(),
): KnowledgeAccessMode {
  return getKnowledgeNodeAccessPolicy(nodeId, db).accessMode;
}

export function findNearestRestrictedKnowledgePolicy(
  nodeId: string,
  db: Database.Database = getDb(),
): KnowledgeAccessPolicyMatch | null {
  ensureKnowledgeAccessPolicyTable(db);
  return (db.prepare(`
    WITH RECURSIVE ancestors(id, parentId, depth) AS (
      SELECT id, parentId, 0
      FROM knowledge_tree_nodes
      WHERE id = ?
      UNION ALL
      SELECT parent.id, parent.parentId, ancestors.depth + 1
      FROM knowledge_tree_nodes parent
      JOIN ancestors ON parent.id = ancestors.parentId
    )
    SELECT policy.nodeId, policy.accessMode, ancestors.depth
    FROM ancestors
    JOIN knowledge_tree_access_policies policy ON policy.nodeId = ancestors.id
    WHERE policy.accessMode = 'restricted'
    ORDER BY ancestors.depth ASC
    LIMIT 1
  `).get(nodeId) as KnowledgeAccessPolicyMatch | undefined) || null;
}

export function restrictKnowledgeNodeAccess(input: {
  nodeId: string;
  actorUserId: string;
  db?: Database.Database;
}): void {
  const db = input.db || getDb();
  ensureKnowledgeAccessPolicyTable(db);
  const current = db.prepare(`
    SELECT accessMode, isExplicit
    FROM knowledge_tree_access_policies
    WHERE nodeId = ?
  `).get(input.nodeId) as { accessMode: KnowledgeAccessMode; isExplicit: number } | undefined;
  if (current?.accessMode === "inherit" && current.isExplicit !== 0) return;

  db.prepare(`
    INSERT INTO knowledge_tree_access_policies (
      nodeId, accessMode, isExplicit, updatedBy, updatedAt
    ) VALUES (?, 'restricted', 0, ?, datetime('now'))
    ON CONFLICT(nodeId) DO UPDATE SET
      accessMode = 'restricted',
      updatedBy = excluded.updatedBy,
      updatedAt = datetime('now')
  `).run(input.nodeId, input.actorUserId);
}

export function setKnowledgeNodeAccessMode(input: {
  nodeId: string;
  accessMode: KnowledgeAccessMode;
  actorUserId: string;
  db?: Database.Database;
}): KnowledgeAccessPolicyState {
  const db = input.db || getDb();
  ensureKnowledgeAccessPolicyTable(db);
  db.prepare(`
    INSERT INTO knowledge_tree_access_policies (
      nodeId, accessMode, isExplicit, updatedBy, updatedAt
    ) VALUES (?, ?, 1, ?, datetime('now'))
    ON CONFLICT(nodeId) DO UPDATE SET
      accessMode = excluded.accessMode,
      isExplicit = 1,
      updatedBy = excluded.updatedBy,
      updatedAt = datetime('now')
  `).run(input.nodeId, input.accessMode, input.actorUserId);
  return { accessMode: input.accessMode, isExplicit: true };
}

export function restoreKnowledgeNodeInheritanceIfEmpty(input: {
  nodeId: string;
  db?: Database.Database;
}): boolean {
  const db = input.db || getDb();
  ensureKnowledgeAccessPolicyTable(db);
  const count = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM knowledge_tree_acl
    WHERE nodeId = ?
  `).get(input.nodeId) as { count: number }).count;
  if (count > 0) return false;
  const policy = db.prepare(`
    SELECT accessMode, isExplicit
    FROM knowledge_tree_access_policies
    WHERE nodeId = ?
  `).get(input.nodeId) as { accessMode: KnowledgeAccessMode; isExplicit: number } | undefined;
  if (!policy || policy.accessMode !== "restricted" || policy.isExplicit !== 0) return false;
  return db.prepare(`
    DELETE FROM knowledge_tree_access_policies
    WHERE nodeId = ?
  `).run(input.nodeId).changes > 0;
}
