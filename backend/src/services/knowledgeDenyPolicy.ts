import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import { getDb } from "../db/schema.js";
import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { restoreKnowledgeNodeInheritanceIfEmpty } from "./knowledgeAccessPolicy.js";

export interface KnowledgeDenyMatch {
  nodeId: string;
  depth: number;
}

const initializedDatabases = new WeakSet<Database.Database>();

export function ensureKnowledgeDenyTable(db: Database.Database = getDb()): void {
  if (initializedDatabases.has(db)) return;
  ensureKnowledgeTreeTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_tree_denials (
      nodeId TEXT NOT NULL,
      userId TEXT NOT NULL,
      deniedBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (nodeId, userId),
      FOREIGN KEY (nodeId) REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (deniedBy) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_tree_denials_user
      ON knowledge_tree_denials(userId, nodeId);
  `);
  initializedDatabases.add(db);
}

export function findNearestKnowledgeDenial(
  nodeId: string,
  userId: string,
  db: Database.Database = getDb(),
): KnowledgeDenyMatch | null {
  ensureKnowledgeDenyTable(db);
  return (db.prepare(`
    WITH RECURSIVE ancestors(id, parentId, depth) AS (
      SELECT id, parentId, 0 FROM knowledge_tree_nodes WHERE id = ?
      UNION ALL
      SELECT parent.id, parent.parentId, ancestors.depth + 1
      FROM knowledge_tree_nodes parent
      JOIN ancestors ON parent.id = ancestors.parentId
    )
    SELECT denial.nodeId, ancestors.depth
    FROM ancestors
    JOIN knowledge_tree_denials denial
      ON denial.nodeId = ancestors.id AND denial.userId = ?
    ORDER BY ancestors.depth ASC
    LIMIT 1
  `).get(nodeId, userId) as KnowledgeDenyMatch | undefined) || null;
}

function writeHistory(db: Database.Database, input: {
  nodeId: string;
  actorUserId: string;
  targetUserId: string;
  denied: boolean;
}): void {
  db.prepare(`
    INSERT INTO knowledge_tree_history (
      id, nodeId, action, actorUserId, targetUserId, metadata
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    input.nodeId,
    input.denied ? "permission_set" : "permission_clear",
    input.actorUserId,
    input.targetUserId,
    JSON.stringify({ rolePreset: "deny", denied: input.denied }),
  );
}

export function setKnowledgeNodeDenied(input: {
  nodeId: string;
  targetUserId: string;
  actorUserId: string;
  db?: Database.Database;
}): void {
  const db = input.db || getDb();
  ensureKnowledgeDenyTable(db);
  db.transaction(() => {
    db.prepare("DELETE FROM knowledge_tree_acl WHERE nodeId = ? AND userId = ?")
      .run(input.nodeId, input.targetUserId);
    // Replacing the final automatically-created allow rule with a denial must not
    // leave an empty allowlist boundary that accidentally hides the node from every
    // other workspace member. Explicit restricted mode is intentionally preserved.
    restoreKnowledgeNodeInheritanceIfEmpty({ nodeId: input.nodeId, db });
    db.prepare(`
      INSERT INTO knowledge_tree_denials (nodeId, userId, deniedBy, updatedAt)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(nodeId, userId) DO UPDATE SET
        deniedBy = excluded.deniedBy,
        updatedAt = datetime('now')
    `).run(input.nodeId, input.targetUserId, input.actorUserId);
    writeHistory(db, { ...input, denied: true });
  })();
}

export function clearKnowledgeNodeDenied(input: {
  nodeId: string;
  targetUserId: string;
  actorUserId: string;
  db?: Database.Database;
}): boolean {
  const db = input.db || getDb();
  ensureKnowledgeDenyTable(db);
  let removed = false;
  db.transaction(() => {
    removed = db.prepare("DELETE FROM knowledge_tree_denials WHERE nodeId = ? AND userId = ?")
      .run(input.nodeId, input.targetUserId).changes > 0;
    if (removed) writeHistory(db, { ...input, denied: false });
  })();
  return removed;
}

export function listKnowledgeNodeDenials(
  nodeId: string,
  db: Database.Database = getDb(),
): Array<{
  nodeId: string;
  userId: string;
  rolePreset: "deny";
  username: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  updatedAt: string;
}> {
  ensureKnowledgeDenyTable(db);
  return db.prepare(`
    SELECT d.nodeId, d.userId, 'deny' AS rolePreset,
           u.username, u.displayName, u.email,
           d.createdAt, d.updatedAt
    FROM knowledge_tree_denials d
    JOIN users u ON u.id = d.userId
    WHERE d.nodeId = ?
    ORDER BY lower(COALESCE(u.displayName, u.username)), u.id
  `).all(nodeId) as Array<{
    nodeId: string;
    userId: string;
    rolePreset: "deny";
    username: string;
    displayName: string | null;
    email: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}
