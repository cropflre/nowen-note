import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";

export const JOURNAL_ARCHIVE_ROOT_TITLE = "个人日记";
export const JOURNAL_ARCHIVE_ID_PREFIX = "__nowen_journal_archive__";

interface FolderStats {
  created: number;
  adopted: number;
  reused: number;
}

interface JournalRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  notebookId: string;
  sortOrder: number;
  note_type: string | null;
  journal_date: string | null;
  isTrashed: number;
}

export interface JournalDateParts {
  dateKey: string;
  year: string;
  month: string;
  day: string;
}

export interface JournalArchiveFolderPath {
  rootNotebookId: string;
  rootNodeId: string;
  yearNotebookId: string;
  yearNodeId: string;
  monthNotebookId: string;
  monthNodeId: string;
  yearTitle: string;
  monthTitle: string;
}

export interface JournalArchivePlacementResult extends JournalArchiveFolderPath {
  noteId: string;
  dateKey: string;
  moved: boolean;
  previousNotebookId: string;
  foldersCreated: number;
  foldersAdopted: number;
  foldersReused: number;
}

export interface JournalArchiveOrganizeResult {
  total: number;
  organized: number;
  moved: number;
  alreadyOrganized: number;
  skippedInvalidDate: number;
  skippedWorkspaceJournal: number;
  foldersCreated: number;
  foldersAdopted: number;
  foldersReused: number;
  rootNotebookId: string | null;
}

function scopeKey(userId: string): string {
  return `personal:${userId}`;
}

function userKey(userId: string): string {
  return createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24);
}

export function journalArchiveNotebookId(
  userId: string,
  level: "root" | "year" | "month",
  archiveKey = "",
): string {
  const suffix = archiveKey ? `:${archiveKey}` : "";
  return `${JOURNAL_ARCHIVE_ID_PREFIX}:${userKey(userId)}:${level}${suffix}`;
}

function notebookNodeId(notebookId: string): string {
  return `notebook:${notebookId}`;
}

export function parseJournalDateKey(value: string): JournalDateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`INVALID_JOURNAL_DATE:${value}`);

  const [, year, month, day] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const daysInMonth = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();

  if (
    yearNumber < 1
    || monthNumber < 1
    || monthNumber > 12
    || dayNumber < 1
    || dayNumber > daysInMonth
  ) {
    throw new Error(`INVALID_JOURNAL_DATE:${value}`);
  }

  return { dateKey: value, year, month, day };
}

function noteSortOrder(dateKey: string): number {
  return -Number(dateKey.replaceAll("-", ""));
}

function recordHistory(
  db: Database.Database,
  input: {
    nodeId: string;
    action: "create" | "move";
    actorUserId: string;
    fromParentId: string | null;
    toParentId: string | null;
    metadata: Record<string, unknown>;
  },
): void {
  db.prepare(`
    INSERT INTO knowledge_tree_history (
      id, nodeId, action, actorUserId, fromParentId, toParentId, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.nodeId,
    input.action,
    input.actorUserId,
    input.fromParentId,
    input.toParentId,
    JSON.stringify(input.metadata),
  );
}

function ensureArchiveFolder(
  db: Database.Database,
  input: {
    userId: string;
    stableId: string;
    parentId: string | null;
    title: string;
    icon: string;
    sortOrder: number;
    kind: "root" | "year" | "month";
    archiveKey: string;
  },
  stats: FolderStats,
): string {
  const stable = db.prepare(`
    SELECT id, userId, workspaceId
    FROM notebooks
    WHERE id = ?
  `).get(input.stableId) as {
    id: string;
    userId: string;
    workspaceId: string | null;
  } | undefined;

  if (stable && (stable.userId !== input.userId || stable.workspaceId !== null)) {
    throw new Error(`JOURNAL_ARCHIVE_ID_CONFLICT:${input.stableId}`);
  }

  let notebookId = stable?.id || "";
  if (!notebookId) {
    const matching = db.prepare(`
      SELECT id
      FROM notebooks
      WHERE userId = ?
        AND workspaceId IS NULL
        AND parentId IS ?
        AND name = ?
        AND isDeleted = 0
      ORDER BY createdAt ASC, id ASC
      LIMIT 1
    `).get(input.userId, input.parentId, input.title) as { id: string } | undefined;

    if (matching) {
      notebookId = matching.id;
      stats.adopted += 1;
    } else {
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO notebooks (
          id, userId, workspaceId, parentId, name, icon, sortOrder,
          isExpanded, isDeleted, deletedAt
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, 1, 0, NULL)
      `).run(
        input.stableId,
        input.userId,
        input.parentId,
        input.title,
        input.icon,
        input.sortOrder,
      );
      notebookId = input.stableId;
      if (inserted.changes > 0) {
        stats.created += 1;
        recordHistory(db, {
          nodeId: notebookNodeId(notebookId),
          action: "create",
          actorUserId: input.userId,
          fromParentId: null,
          toParentId: input.parentId ? notebookNodeId(input.parentId) : null,
          metadata: {
            source: "journal_archive",
            kind: input.kind,
            archiveKey: input.archiveKey,
          },
        });
      } else {
        stats.reused += 1;
      }
    }
  } else {
    stats.reused += 1;
  }

  db.prepare(`
    UPDATE notebooks
    SET userId = ?, workspaceId = NULL, parentId = ?, name = ?, icon = ?,
        sortOrder = ?, isDeleted = 0, deletedAt = NULL
    WHERE id = ?
  `).run(
    input.userId,
    input.parentId,
    input.title,
    input.icon,
    input.sortOrder,
    notebookId,
  );

  return notebookId;
}

function ensureFoldersInternal(
  db: Database.Database,
  userId: string,
  dateKey: string,
  stats: FolderStats,
): JournalArchiveFolderPath {
  ensureKnowledgeTreeTables(db);
  const parts = parseJournalDateKey(dateKey);

  const rootNotebookId = ensureArchiveFolder(db, {
    userId,
    stableId: journalArchiveNotebookId(userId, "root"),
    parentId: null,
    title: JOURNAL_ARCHIVE_ROOT_TITLE,
    icon: "📔",
    sortOrder: -2_000_000_000,
    kind: "root",
    archiveKey: "root",
  }, stats);

  const yearTitle = `${parts.year}年`;
  const yearNotebookId = ensureArchiveFolder(db, {
    userId,
    stableId: journalArchiveNotebookId(userId, "year", parts.year),
    parentId: rootNotebookId,
    title: yearTitle,
    icon: "📅",
    sortOrder: -Number(parts.year),
    kind: "year",
    archiveKey: parts.year,
  }, stats);

  const monthKey = `${parts.year}-${parts.month}`;
  const monthTitle = `${parts.year}年${parts.month}月`;
  const monthNotebookId = ensureArchiveFolder(db, {
    userId,
    stableId: journalArchiveNotebookId(userId, "month", monthKey),
    parentId: yearNotebookId,
    title: monthTitle,
    icon: "🗓️",
    sortOrder: -Number(parts.month),
    kind: "month",
    archiveKey: monthKey,
  }, stats);

  return {
    rootNotebookId,
    rootNodeId: notebookNodeId(rootNotebookId),
    yearNotebookId,
    yearNodeId: notebookNodeId(yearNotebookId),
    monthNotebookId,
    monthNodeId: notebookNodeId(monthNotebookId),
    yearTitle,
    monthTitle,
  };
}

export function ensureJournalArchiveFolders(input: {
  db: Database.Database;
  userId: string;
  dateKey: string;
}): JournalArchiveFolderPath & Pick<JournalArchivePlacementResult, "foldersCreated" | "foldersAdopted" | "foldersReused"> {
  const stats: FolderStats = { created: 0, adopted: 0, reused: 0 };
  const execute = () => ensureFoldersInternal(input.db, input.userId, input.dateKey, stats);
  const path = input.db.inTransaction ? execute() : input.db.transaction(execute)();
  return {
    ...path,
    foldersCreated: stats.created,
    foldersAdopted: stats.adopted,
    foldersReused: stats.reused,
  };
}

function ensureNoteTreeRow(
  db: Database.Database,
  note: JournalRow,
  target: JournalArchiveFolderPath,
  sortOrder: number,
): { nodeId: string; previousParentId: string | null } {
  const existing = db.prepare(`
    SELECT id, parentId
    FROM knowledge_tree_nodes
    WHERE resourceType = 'note' AND resourceId = ?
  `).get(note.id) as { id: string; parentId: string | null } | undefined;

  if (!existing) {
    db.prepare(`
      INSERT OR IGNORE INTO knowledge_tree_nodes (
        id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
        resourceId, sortOrder, isExpanded, isDeleted, deletedAt
      ) VALUES (?, ?, NULL, ?, ?, 'note', 'note', ?, ?, 1, 0, NULL)
    `).run(
      `note:${note.id}`,
      note.userId,
      scopeKey(note.userId),
      target.monthNodeId,
      note.id,
      sortOrder,
    );
  }

  const row = db.prepare(`
    SELECT id, parentId
    FROM knowledge_tree_nodes
    WHERE resourceType = 'note' AND resourceId = ?
  `).get(note.id) as { id: string; parentId: string | null } | undefined;

  if (!row) throw new Error(`JOURNAL_TREE_NODE_MISSING:${note.id}`);
  return { nodeId: row.id, previousParentId: existing?.parentId ?? null };
}

function placeJournalInternal(
  db: Database.Database,
  input: { userId: string; noteId: string; dateKey?: string },
  sharedStats?: FolderStats,
): JournalArchivePlacementResult {
  ensureKnowledgeTreeTables(db);
  const note = db.prepare(`
    SELECT id, userId, workspaceId, notebookId, sortOrder,
           note_type, journal_date, isTrashed
    FROM notes
    WHERE id = ? AND userId = ?
  `).get(input.noteId, input.userId) as JournalRow | undefined;

  if (!note) throw new Error(`JOURNAL_NOTE_NOT_FOUND:${input.noteId}`);
  if (note.note_type !== "journal") throw new Error(`NOTE_IS_NOT_JOURNAL:${input.noteId}`);
  if (note.isTrashed !== 0) throw new Error(`JOURNAL_IS_TRASHED:${input.noteId}`);
  if (note.workspaceId !== null) throw new Error(`JOURNAL_NOT_PERSONAL:${input.noteId}`);

  const dateKey = input.dateKey || note.journal_date || "";
  if (note.journal_date && note.journal_date !== dateKey) {
    throw new Error(`JOURNAL_DATE_MISMATCH:${input.noteId}`);
  }
  parseJournalDateKey(dateKey);

  const stats = sharedStats || { created: 0, adopted: 0, reused: 0 };
  const target = ensureFoldersInternal(db, input.userId, dateKey, stats);
  const targetSortOrder = noteSortOrder(dateKey);
  const tree = ensureNoteTreeRow(db, note, target, targetSortOrder);
  const moved = note.notebookId !== target.monthNotebookId
    || note.sortOrder !== targetSortOrder
    || tree.previousParentId !== target.monthNodeId;

  db.prepare(`
    UPDATE notes
    SET notebookId = ?, workspaceId = NULL, sortOrder = ?
    WHERE id = ? AND userId = ?
  `).run(target.monthNotebookId, targetSortOrder, note.id, input.userId);

  db.prepare(`
    UPDATE knowledge_tree_nodes
    SET userId = ?, workspaceId = NULL, scopeKey = ?, parentId = ?,
        nodeType = 'note', sortOrder = ?, isDeleted = 0, deletedAt = NULL,
        updatedAt = datetime('now')
    WHERE resourceType = 'note' AND resourceId = ?
  `).run(
    input.userId,
    scopeKey(input.userId),
    target.monthNodeId,
    targetSortOrder,
    note.id,
  );

  if (tree.previousParentId !== target.monthNodeId) {
    recordHistory(db, {
      nodeId: tree.nodeId,
      action: "move",
      actorUserId: input.userId,
      fromParentId: tree.previousParentId,
      toParentId: target.monthNodeId,
      metadata: {
        source: "journal_archive",
        journalDate: dateKey,
      },
    });
  }

  return {
    ...target,
    noteId: note.id,
    dateKey,
    moved,
    previousNotebookId: note.notebookId,
    foldersCreated: stats.created,
    foldersAdopted: stats.adopted,
    foldersReused: stats.reused,
  };
}

export function ensureJournalArchivePlacement(input: {
  db: Database.Database;
  userId: string;
  noteId: string;
  dateKey?: string;
}): JournalArchivePlacementResult {
  const execute = () => placeJournalInternal(input.db, input);
  return input.db.inTransaction ? execute() : input.db.transaction(execute)();
}

export function organizeJournalArchive(input: {
  db: Database.Database;
  userId: string;
}): JournalArchiveOrganizeResult {
  const execute = (): JournalArchiveOrganizeResult => {
    ensureKnowledgeTreeTables(input.db);
    const rows = input.db.prepare(`
      SELECT id, userId, workspaceId, notebookId, sortOrder,
             note_type, journal_date, isTrashed
      FROM notes
      WHERE userId = ? AND note_type = 'journal' AND isTrashed = 0
      ORDER BY journal_date ASC, createdAt ASC
    `).all(input.userId) as JournalRow[];

    const stats: FolderStats = { created: 0, adopted: 0, reused: 0 };
    let organized = 0;
    let moved = 0;
    let alreadyOrganized = 0;
    let skippedInvalidDate = 0;
    let skippedWorkspaceJournal = 0;
    let rootNotebookId: string | null = null;

    for (const row of rows) {
      if (row.workspaceId !== null) {
        skippedWorkspaceJournal += 1;
        continue;
      }
      try {
        parseJournalDateKey(row.journal_date || "");
      } catch {
        skippedInvalidDate += 1;
        continue;
      }

      const result = placeJournalInternal(input.db, {
        userId: input.userId,
        noteId: row.id,
        dateKey: row.journal_date || undefined,
      }, stats);
      rootNotebookId ||= result.rootNotebookId;
      organized += 1;
      if (result.moved) moved += 1;
      else alreadyOrganized += 1;
    }

    return {
      total: rows.length,
      organized,
      moved,
      alreadyOrganized,
      skippedInvalidDate,
      skippedWorkspaceJournal,
      foldersCreated: stats.created,
      foldersAdopted: stats.adopted,
      foldersReused: stats.reused,
      rootNotebookId,
    };
  };

  return input.db.inTransaction ? execute() : input.db.transaction(execute)();
}
