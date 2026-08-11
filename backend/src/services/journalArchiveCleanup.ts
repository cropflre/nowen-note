import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { synchronizeLegacyNotebookHierarchy } from "./legacyKnowledgeHierarchy.js";
import { JOURNAL_ARCHIVE_ID_PREFIX } from "./journalArchiveTree.js";

export type JournalArchiveCleanupBlockReason =
  | "SYSTEM_ARCHIVE_FOLDER"
  | "HAS_CHILD_NOTEBOOKS"
  | "HAS_NOTES"
  | "HAS_MEMBERS"
  | "HAS_SHARE_LINKS"
  | "HAS_PASSWORD"
  | "HAS_CUSTOM_ACL";

export interface JournalArchiveCleanupCandidate {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: string;
  evidenceCount: number;
}

export interface JournalArchiveCleanupBlocked extends JournalArchiveCleanupCandidate {
  reasons: JournalArchiveCleanupBlockReason[];
  descendantNotebookCount: number;
  noteCount: number;
  memberCount: number;
  shareLinkCount: number;
  passwordCount: number;
  aclCount: number;
}

export interface JournalArchiveCleanupPreview {
  previewToken: string;
  candidateCount: number;
  blockedCount: number;
  candidates: JournalArchiveCleanupCandidate[];
  blocked: JournalArchiveCleanupBlocked[];
}

export interface JournalArchiveCleanupApplyResult {
  cleanupId: string;
  cleaned: number;
  alreadyDeleted: number;
  cleanedNotebooks: Array<{ id: string; name: string }>;
}

export interface JournalArchiveCleanupRestoreResult {
  cleanupId: string;
  restored: number;
  alreadyActive: number;
  missing: number;
  restoredNotebooks: Array<{ id: string; name: string }>;
}

interface NotebookRow {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: string;
  isDeleted: number;
}

interface EvidenceRow {
  notebookId: string;
  evidenceCount: number;
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function countRows(
  db: Database.Database,
  table: string,
  column: string,
  values: readonly string[],
  extraWhere = "",
): number {
  if (values.length === 0 || !tableExists(db, table)) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${table}
    WHERE ${column} IN (${placeholders(values)}) ${extraWhere}
  `).get(...values) as { count: number };
  return Number(row?.count || 0);
}

function readSubtreeIds(
  db: Database.Database,
  userId: string,
  notebookId: string,
): string[] {
  return (db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id
      FROM notebooks
      WHERE id = ? AND userId = ? AND workspaceId IS NULL AND isDeleted = 0
      UNION ALL
      SELECT child.id
      FROM notebooks child
      JOIN subtree parent ON child.parentId = parent.id
      WHERE child.userId = ? AND child.workspaceId IS NULL AND child.isDeleted = 0
    )
    SELECT id FROM subtree
  `).all(notebookId, userId, userId) as Array<{ id: string }>).map((row) => row.id);
}

function readEvidence(db: Database.Database, userId: string): EvidenceRow[] {
  if (!tableExists(db, "knowledge_tree_history")) return [];
  return db.prepare(`
    SELECT
      substr(fromParentId, 10) AS notebookId,
      COUNT(*) AS evidenceCount
    FROM knowledge_tree_history
    WHERE actorUserId = ?
      AND action = 'move'
      AND fromParentId LIKE 'notebook:%'
      AND metadata LIKE '%"source":"journal_archive"%'
    GROUP BY fromParentId
    ORDER BY notebookId ASC
  `).all(userId) as EvidenceRow[];
}

function previewToken(userId: string, candidates: JournalArchiveCleanupCandidate[]): string {
  const snapshot = candidates
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      parentId: candidate.parentId,
      updatedAt: candidate.updatedAt,
      evidenceCount: candidate.evidenceCount,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256")
    .update(JSON.stringify({ userId, snapshot }), "utf8")
    .digest("hex");
}

export function previewJournalArchiveCleanup(input: {
  db: Database.Database;
  userId: string;
}): JournalArchiveCleanupPreview {
  ensureKnowledgeTreeTables(input.db);
  const candidates: JournalArchiveCleanupCandidate[] = [];
  const blocked: JournalArchiveCleanupBlocked[] = [];

  for (const evidence of readEvidence(input.db, input.userId)) {
    const notebook = input.db.prepare(`
      SELECT id, name, parentId, updatedAt, isDeleted
      FROM notebooks
      WHERE id = ? AND userId = ? AND workspaceId IS NULL
    `).get(evidence.notebookId, input.userId) as NotebookRow | undefined;
    if (!notebook || notebook.isDeleted === 1) continue;

    const subtreeIds = readSubtreeIds(input.db, input.userId, notebook.id);
    if (subtreeIds.length === 0) continue;

    const nodeIds = subtreeIds.map((id) => `notebook:${id}`);
    const noteCount = countRows(input.db, "notes", "notebookId", subtreeIds);
    const memberCount = countRows(input.db, "notebook_members", "notebookId", subtreeIds);
    const shareLinkCount = countRows(input.db, "notebook_share_links", "notebookId", subtreeIds);
    const passwordCount = countRows(input.db, "notebook_passwords", "notebookId", subtreeIds);
    const aclCount = countRows(input.db, "knowledge_tree_acl", "nodeId", nodeIds);
    const reasons: JournalArchiveCleanupBlockReason[] = [];

    if (notebook.id.startsWith(JOURNAL_ARCHIVE_ID_PREFIX)) reasons.push("SYSTEM_ARCHIVE_FOLDER");
    if (subtreeIds.length > 1) reasons.push("HAS_CHILD_NOTEBOOKS");
    if (noteCount > 0) reasons.push("HAS_NOTES");
    if (memberCount > 0) reasons.push("HAS_MEMBERS");
    if (shareLinkCount > 0) reasons.push("HAS_SHARE_LINKS");
    if (passwordCount > 0) reasons.push("HAS_PASSWORD");
    if (aclCount > 0) reasons.push("HAS_CUSTOM_ACL");

    const base: JournalArchiveCleanupCandidate = {
      id: notebook.id,
      name: notebook.name,
      parentId: notebook.parentId,
      updatedAt: notebook.updatedAt,
      evidenceCount: Number(evidence.evidenceCount || 0),
    };

    if (reasons.length === 0) {
      candidates.push(base);
    } else {
      blocked.push({
        ...base,
        reasons,
        descendantNotebookCount: Math.max(0, subtreeIds.length - 1),
        noteCount,
        memberCount,
        shareLinkCount,
        passwordCount,
        aclCount,
      });
    }
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
  blocked.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));

  return {
    previewToken: previewToken(input.userId, candidates),
    candidateCount: candidates.length,
    blockedCount: blocked.length,
    candidates,
    blocked,
  };
}

function insertCleanupHistory(
  db: Database.Database,
  input: {
    action: "delete_subtree" | "restore";
    userId: string;
    notebook: NotebookRow;
    cleanupId: string;
  },
): void {
  db.prepare(`
    INSERT INTO knowledge_tree_history (
      id, nodeId, action, actorUserId, fromParentId, toParentId, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    `notebook:${input.notebook.id}`,
    input.action,
    input.userId,
    input.notebook.parentId ? `notebook:${input.notebook.parentId}` : null,
    input.action === "restore" && input.notebook.parentId
      ? `notebook:${input.notebook.parentId}`
      : null,
    JSON.stringify({
      source: "journal_archive_cleanup",
      cleanupId: input.cleanupId,
      notebookId: input.notebook.id,
      notebookName: input.notebook.name,
      parentId: input.notebook.parentId,
    }),
  );
}

export function applyJournalArchiveCleanup(input: {
  db: Database.Database;
  userId: string;
  previewToken: string;
  candidateIds?: string[];
}): JournalArchiveCleanupApplyResult {
  const execute = (): JournalArchiveCleanupApplyResult => {
    const preview = previewJournalArchiveCleanup({ db: input.db, userId: input.userId });
    if (!input.previewToken || input.previewToken !== preview.previewToken) {
      throw new Error("JOURNAL_ARCHIVE_CLEANUP_STALE_PREVIEW");
    }

    const available = new Map(preview.candidates.map((candidate) => [candidate.id, candidate]));
    const requested = input.candidateIds?.length
      ? Array.from(new Set(input.candidateIds))
      : preview.candidates.map((candidate) => candidate.id);
    if (requested.some((id) => !available.has(id))) {
      throw new Error("JOURNAL_ARCHIVE_CLEANUP_INVALID_SELECTION");
    }

    const cleanupId = randomUUID();
    let cleaned = 0;
    let alreadyDeleted = 0;
    const cleanedNotebooks: Array<{ id: string; name: string }> = [];

    for (const id of requested) {
      const notebook = input.db.prepare(`
        SELECT id, name, parentId, updatedAt, isDeleted
        FROM notebooks
        WHERE id = ? AND userId = ? AND workspaceId IS NULL
      `).get(id, input.userId) as NotebookRow | undefined;
      if (!notebook) throw new Error(`JOURNAL_ARCHIVE_CLEANUP_NOTEBOOK_MISSING:${id}`);
      if (notebook.isDeleted === 1) {
        alreadyDeleted += 1;
        continue;
      }

      const changed = input.db.prepare(`
        UPDATE notebooks
        SET isDeleted = 1,
            deletedAt = datetime('now'),
            updatedAt = datetime('now')
        WHERE id = ? AND userId = ? AND workspaceId IS NULL AND isDeleted = 0
      `).run(id, input.userId);
      if (!changed.changes) {
        alreadyDeleted += 1;
        continue;
      }

      synchronizeLegacyNotebookHierarchy({
        db: input.db,
        notebookId: id,
        actorUserId: input.userId,
        reason: "delete",
        parentMode: "preserve",
      });
      insertCleanupHistory(input.db, {
        action: "delete_subtree",
        userId: input.userId,
        notebook,
        cleanupId,
      });
      cleaned += 1;
      cleanedNotebooks.push({ id, name: notebook.name });
    }

    return { cleanupId, cleaned, alreadyDeleted, cleanedNotebooks };
  };

  return input.db.inTransaction ? execute() : input.db.transaction(execute)();
}

export function restoreJournalArchiveCleanup(input: {
  db: Database.Database;
  userId: string;
  cleanupId: string;
}): JournalArchiveCleanupRestoreResult {
  const execute = (): JournalArchiveCleanupRestoreResult => {
    ensureKnowledgeTreeTables(input.db);
    const history = input.db.prepare(`
      SELECT metadata
      FROM knowledge_tree_history
      WHERE actorUserId = ?
        AND action = 'delete_subtree'
        AND metadata LIKE '%"source":"journal_archive_cleanup"%'
        AND metadata LIKE ?
      ORDER BY createdAt ASC, id ASC
    `).all(input.userId, `%"cleanupId":"${input.cleanupId}"%`) as Array<{ metadata: string }>;

    if (history.length === 0) throw new Error("JOURNAL_ARCHIVE_CLEANUP_NOT_FOUND");

    const notebookIds = Array.from(new Set(history.map((row) => {
      try {
        return String((JSON.parse(row.metadata) as { notebookId?: unknown }).notebookId || "");
      } catch {
        return "";
      }
    }).filter(Boolean)));

    let restored = 0;
    let alreadyActive = 0;
    let missing = 0;
    const restoredNotebooks: Array<{ id: string; name: string }> = [];

    for (const id of notebookIds) {
      const notebook = input.db.prepare(`
        SELECT id, name, parentId, updatedAt, isDeleted
        FROM notebooks
        WHERE id = ? AND userId = ? AND workspaceId IS NULL
      `).get(id, input.userId) as NotebookRow | undefined;
      if (!notebook) {
        missing += 1;
        continue;
      }
      if (notebook.isDeleted === 0) {
        alreadyActive += 1;
        continue;
      }

      if (notebook.parentId) {
        const parent = input.db.prepare(`
          SELECT isDeleted FROM notebooks
          WHERE id = ? AND userId = ? AND workspaceId IS NULL
        `).get(notebook.parentId, input.userId) as { isDeleted: number } | undefined;
        if (!parent || parent.isDeleted === 1) {
          throw new Error(`JOURNAL_ARCHIVE_CLEANUP_PARENT_UNAVAILABLE:${id}`);
        }
      }

      input.db.prepare(`
        UPDATE notebooks
        SET isDeleted = 0,
            deletedAt = NULL,
            updatedAt = datetime('now')
        WHERE id = ? AND userId = ? AND workspaceId IS NULL
      `).run(id, input.userId);
      synchronizeLegacyNotebookHierarchy({
        db: input.db,
        notebookId: id,
        actorUserId: input.userId,
        reason: "restore",
        parentMode: "preserve",
      });
      insertCleanupHistory(input.db, {
        action: "restore",
        userId: input.userId,
        notebook,
        cleanupId: input.cleanupId,
      });
      restored += 1;
      restoredNotebooks.push({ id, name: notebook.name });
    }

    return {
      cleanupId: input.cleanupId,
      restored,
      alreadyActive,
      missing,
      restoredNotebooks,
    };
  };

  return input.db.inTransaction ? execute() : input.db.transaction(execute)();
}
