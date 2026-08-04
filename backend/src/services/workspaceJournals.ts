import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import {
  getUserWorkspaceRole,
  hasPermission,
  isFeatureEnabled,
  isSystemAdmin,
  resolveWorkspaceFeatures,
  roleToPermission,
  type WorkspaceRole,
} from "../middleware/acl.js";
import {
  synchronizeLegacyNoteHierarchy,
  synchronizeLegacyNotebookHierarchy,
} from "./legacyKnowledgeHierarchy.js";
import { parseJournalDateKey } from "./journalArchiveTree.js";

export const WORKSPACE_JOURNAL_ROOT_TITLE = "工作区日记";
export const WORKSPACE_JOURNAL_ID_PREFIX = "__nowen_workspace_journal__";

export interface WorkspaceJournalFolderPath {
  rootNotebookId: string;
  rootNodeId: string;
  yearNotebookId: string;
  yearNodeId: string;
  monthNotebookId: string;
  monthNodeId: string;
  yearTitle: string;
  monthTitle: string;
}

export interface WorkspaceJournalRecord {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string;
  title: string;
  content: string;
  contentText: string;
  isPinned: number;
  isLocked: number;
  isArchived: number;
  isTrashed: number;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  contentFormat: string;
  note_type: string;
  journal_date: string | null;
}

export interface WorkspaceJournalResult {
  note: WorkspaceJournalRecord;
  existed: boolean;
  canWrite: boolean;
  role: WorkspaceRole | "system-admin";
  archive: WorkspaceJournalFolderPath | null;
}

export class WorkspaceJournalError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_NOT_FOUND"
      | "WORKSPACE_FORBIDDEN"
      | "WORKSPACE_DIARIES_DISABLED"
      | "WORKSPACE_JOURNAL_READ_ONLY"
      | "WORKSPACE_JOURNAL_TRASHED"
      | "WORKSPACE_JOURNAL_BINDING_BROKEN",
    message: string,
    readonly status: 403 | 404 | 409 = 403,
  ) {
    super(message);
  }
}

function workspaceKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId, "utf8").digest("hex").slice(0, 24);
}

export function workspaceJournalNotebookId(
  workspaceId: string,
  level: "root" | "year" | "month",
  archiveKey = "",
): string {
  const suffix = archiveKey ? `:${archiveKey}` : "";
  return `${WORKSPACE_JOURNAL_ID_PREFIX}:${workspaceKey(workspaceId)}:${level}${suffix}`;
}

function noteSortOrder(dateKey: string): number {
  return -Number(dateKey.replaceAll("-", ""));
}

function readWorkspaceOwner(db: Database.Database, workspaceId: string): string | null {
  const owner = db.prepare(`
    SELECT userId
    FROM workspace_members
    WHERE workspaceId = ? AND role = 'owner'
    ORDER BY joinedAt ASC, userId ASC
    LIMIT 1
  `).get(workspaceId) as { userId: string } | undefined;
  return owner?.userId || null;
}

function resolveAccess(
  db: Database.Database,
  workspaceId: string,
  actorUserId: string,
): { role: WorkspaceRole | "system-admin"; canWrite: boolean; ownerUserId: string } {
  const workspace = db.prepare("SELECT id FROM workspaces WHERE id = ?")
    .get(workspaceId) as { id: string } | undefined;
  if (!workspace) {
    throw new WorkspaceJournalError("WORKSPACE_NOT_FOUND", "工作区不存在", 404);
  }

  const systemAdmin = isSystemAdmin(actorUserId);
  const memberRole = getUserWorkspaceRole(workspaceId, actorUserId);
  if (!systemAdmin && !memberRole) {
    throw new WorkspaceJournalError("WORKSPACE_FORBIDDEN", "无权访问该工作区", 403);
  }

  const features = resolveWorkspaceFeatures(workspaceId);
  if (!isFeatureEnabled(features, "diaries")) {
    throw new WorkspaceJournalError(
      "WORKSPACE_DIARIES_DISABLED",
      "该工作区已关闭每日记录功能",
      403,
    );
  }

  const canWrite = systemAdmin
    || !!memberRole && hasPermission(roleToPermission(memberRole), "write");
  const ownerUserId = readWorkspaceOwner(db, workspaceId) || actorUserId;
  return {
    role: systemAdmin ? "system-admin" : memberRole as WorkspaceRole,
    canWrite,
    ownerUserId,
  };
}

function ensureWorkspaceFolder(
  db: Database.Database,
  input: {
    workspaceId: string;
    ownerUserId: string;
    actorUserId: string;
    stableId: string;
    parentId: string | null;
    title: string;
    icon: string;
    sortOrder: number;
  },
): string {
  const stable = db.prepare(`
    SELECT id, workspaceId, parentId, name, icon, sortOrder, isDeleted
    FROM notebooks
    WHERE id = ?
  `).get(input.stableId) as {
    id: string;
    workspaceId: string | null;
    parentId: string | null;
    name: string;
    icon: string | null;
    sortOrder: number;
    isDeleted: number;
  } | undefined;
  if (stable && stable.workspaceId !== input.workspaceId) {
    throw new Error(`WORKSPACE_JOURNAL_ID_CONFLICT:${input.stableId}`);
  }

  let notebookId = stable?.id || "";
  let created = false;
  if (!notebookId) {
    const matching = db.prepare(`
      SELECT id
      FROM notebooks
      WHERE workspaceId = ?
        AND parentId IS ?
        AND name = ?
        AND isDeleted = 0
      ORDER BY createdAt ASC, id ASC
      LIMIT 1
    `).get(input.workspaceId, input.parentId, input.title) as { id: string } | undefined;
    notebookId = matching?.id || input.stableId;

    if (!matching) {
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO notebooks (
          id, userId, workspaceId, parentId, name, icon, sortOrder,
          isExpanded, isDeleted, deletedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)
      `).run(
        notebookId,
        input.ownerUserId,
        input.workspaceId,
        input.parentId,
        input.title,
        input.icon,
        input.sortOrder,
      );
      created = inserted.changes > 0;
    }
  }

  const before = db.prepare(`
    SELECT parentId, name, icon, sortOrder, isDeleted
    FROM notebooks WHERE id = ?
  `).get(notebookId) as {
    parentId: string | null;
    name: string;
    icon: string | null;
    sortOrder: number;
    isDeleted: number;
  } | undefined;

  db.prepare(`
    UPDATE notebooks
    SET userId = ?, workspaceId = ?, parentId = ?, name = ?, icon = ?,
        sortOrder = ?, isDeleted = 0, deletedAt = NULL
    WHERE id = ?
  `).run(
    input.ownerUserId,
    input.workspaceId,
    input.parentId,
    input.title,
    input.icon,
    input.sortOrder,
    notebookId,
  );

  const changed = created
    || !before
    || before.parentId !== input.parentId
    || before.name !== input.title
    || before.icon !== input.icon
    || before.sortOrder !== input.sortOrder
    || before.isDeleted !== 0;
  synchronizeLegacyNotebookHierarchy({
    db,
    notebookId,
    actorUserId: input.actorUserId,
    reason: created ? "create" : changed ? "move" : "metadata",
    parentMode: "resource",
  });
  return notebookId;
}

function ensureFolders(
  db: Database.Database,
  input: {
    workspaceId: string;
    ownerUserId: string;
    actorUserId: string;
    dateKey: string;
  },
): WorkspaceJournalFolderPath {
  const parts = parseJournalDateKey(input.dateKey);
  const rootNotebookId = ensureWorkspaceFolder(db, {
    ...input,
    stableId: workspaceJournalNotebookId(input.workspaceId, "root"),
    parentId: null,
    title: WORKSPACE_JOURNAL_ROOT_TITLE,
    icon: "📘",
    sortOrder: -1_990_000_000,
  });
  const yearTitle = `${parts.year}年`;
  const yearNotebookId = ensureWorkspaceFolder(db, {
    ...input,
    stableId: workspaceJournalNotebookId(input.workspaceId, "year", parts.year),
    parentId: rootNotebookId,
    title: yearTitle,
    icon: "📅",
    sortOrder: -Number(parts.year),
  });
  const monthKey = `${parts.year}-${parts.month}`;
  const monthTitle = `${parts.year}年${parts.month}月`;
  const monthNotebookId = ensureWorkspaceFolder(db, {
    ...input,
    stableId: workspaceJournalNotebookId(input.workspaceId, "month", monthKey),
    parentId: yearNotebookId,
    title: monthTitle,
    icon: "🗓️",
    sortOrder: -Number(parts.month),
  });

  return {
    rootNotebookId,
    rootNodeId: `notebook:${rootNotebookId}`,
    yearNotebookId,
    yearNodeId: `notebook:${yearNotebookId}`,
    monthNotebookId,
    monthNodeId: `notebook:${monthNotebookId}`,
    yearTitle,
    monthTitle,
  };
}

function readBoundJournal(
  db: Database.Database,
  workspaceId: string,
  dateKey: string,
): WorkspaceJournalRecord | null {
  const row = db.prepare(`
    SELECT n.id, n.userId, n.notebookId, n.workspaceId, n.title, n.content,
           n.contentText, n.isPinned, n.isLocked, n.isArchived, n.isTrashed,
           n.version, n.sortOrder, n.createdAt, n.updatedAt, n.trashedAt,
           n.contentFormat, n.note_type, n.journal_date
    FROM workspace_journals wj
    JOIN notes n ON n.id = wj.noteId
    WHERE wj.workspaceId = ? AND wj.journalDate = ?
  `).get(workspaceId, dateKey) as WorkspaceJournalRecord | undefined;
  return row || null;
}

function validateBoundJournal(
  note: WorkspaceJournalRecord,
  workspaceId: string,
): void {
  if (note.workspaceId !== workspaceId) {
    throw new WorkspaceJournalError(
      "WORKSPACE_JOURNAL_BINDING_BROKEN",
      "共享日记的工作区归属不一致",
      409,
    );
  }
  if (note.isTrashed !== 0) {
    throw new WorkspaceJournalError(
      "WORKSPACE_JOURNAL_TRASHED",
      "该日期的共享日记位于回收站，请先恢复",
      409,
    );
  }
}

function placeBoundJournal(
  db: Database.Database,
  input: {
    workspaceId: string;
    actorUserId: string;
    ownerUserId: string;
    dateKey: string;
    note: WorkspaceJournalRecord;
  },
): WorkspaceJournalFolderPath {
  validateBoundJournal(input.note, input.workspaceId);
  const archive = ensureFolders(db, input);
  const targetSortOrder = noteSortOrder(input.dateKey);
  const changed = input.note.userId !== input.ownerUserId
    || input.note.notebookId !== archive.monthNotebookId
    || input.note.sortOrder !== targetSortOrder;
  db.prepare(`
    UPDATE notes
    SET userId = ?, workspaceId = ?, notebookId = ?, sortOrder = ?
    WHERE id = ?
  `).run(
    input.ownerUserId,
    input.workspaceId,
    archive.monthNotebookId,
    targetSortOrder,
    input.note.id,
  );
  synchronizeLegacyNoteHierarchy({
    db,
    noteId: input.note.id,
    actorUserId: input.actorUserId,
    reason: changed ? "move" : "metadata",
    parentMode: "resource",
  });
  return archive;
}

export function checkWorkspaceJournal(input: {
  db: Database.Database;
  workspaceId: string;
  actorUserId: string;
  dateKey: string;
}): {
  exists: boolean;
  noteId: string | null;
  title: string | null;
  canWrite: boolean;
  role: WorkspaceRole | "system-admin";
} {
  const dateKey = parseJournalDateKey(input.dateKey).dateKey;
  const access = resolveAccess(input.db, input.workspaceId, input.actorUserId);
  const note = readBoundJournal(input.db, input.workspaceId, dateKey);
  return {
    exists: !!note && note.isTrashed === 0,
    noteId: note?.isTrashed === 0 ? note.id : null,
    title: note?.isTrashed === 0 ? note.title : null,
    canWrite: access.canWrite,
    role: access.role,
  };
}

export function getOrCreateWorkspaceJournal(input: {
  db: Database.Database;
  workspaceId: string;
  actorUserId: string;
  dateKey: string;
}): WorkspaceJournalResult {
  const dateKey = parseJournalDateKey(input.dateKey).dateKey;
  const access = resolveAccess(input.db, input.workspaceId, input.actorUserId);

  const existing = readBoundJournal(input.db, input.workspaceId, dateKey);
  if (existing) {
    validateBoundJournal(existing, input.workspaceId);
    if (!access.canWrite) {
      return {
        note: existing,
        existed: true,
        canWrite: false,
        role: access.role,
        archive: null,
      };
    }
  } else if (!access.canWrite) {
    throw new WorkspaceJournalError(
      "WORKSPACE_JOURNAL_READ_ONLY",
      "当前工作区角色只能查看日记，无法创建缺失日期",
      403,
    );
  }

  const execute = (): WorkspaceJournalResult => {
    const current = readBoundJournal(input.db, input.workspaceId, dateKey);
    if (current) {
      const archive = placeBoundJournal(input.db, {
        ...input,
        ownerUserId: access.ownerUserId,
        dateKey,
        note: current,
      });
      return {
        note: readBoundJournal(input.db, input.workspaceId, dateKey) as WorkspaceJournalRecord,
        existed: true,
        canWrite: true,
        role: access.role,
        archive,
      };
    }

    const archive = ensureFolders(input.db, {
      workspaceId: input.workspaceId,
      ownerUserId: access.ownerUserId,
      actorUserId: input.actorUserId,
      dateKey,
    });
    const noteId = uuid();
    input.db.prepare(`
      INSERT INTO notes (
        id, userId, notebookId, workspaceId, title, content, contentText,
        note_type, journal_date, sortOrder
      ) VALUES (?, ?, ?, ?, ?, '{}', '', 'note', NULL, ?)
    `).run(
      noteId,
      access.ownerUserId,
      archive.monthNotebookId,
      input.workspaceId,
      dateKey,
      noteSortOrder(dateKey),
    );
    input.db.prepare(`
      INSERT INTO workspace_journals (
        workspaceId, journalDate, noteId, createdBy, updatedAt
      ) VALUES (?, ?, ?, ?, datetime('now'))
    `).run(input.workspaceId, dateKey, noteId, input.actorUserId);
    synchronizeLegacyNoteHierarchy({
      db: input.db,
      noteId,
      actorUserId: input.actorUserId,
      reason: "create",
      parentMode: "resource",
    });

    const note = readBoundJournal(input.db, input.workspaceId, dateKey);
    if (!note) {
      throw new WorkspaceJournalError(
        "WORKSPACE_JOURNAL_BINDING_BROKEN",
        "共享日记创建后无法读取",
        409,
      );
    }
    return { note, existed: false, canWrite: true, role: access.role, archive };
  };

  try {
    return input.db.inTransaction ? execute() : input.db.transaction(execute)();
  } catch (error: any) {
    if (!String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) throw error;
    const concurrent = readBoundJournal(input.db, input.workspaceId, dateKey);
    if (!concurrent) throw error;
    validateBoundJournal(concurrent, input.workspaceId);
    if (!access.canWrite) {
      return {
        note: concurrent,
        existed: true,
        canWrite: false,
        role: access.role,
        archive: null,
      };
    }
    const archive = placeBoundJournal(input.db, {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      ownerUserId: access.ownerUserId,
      dateKey,
      note: concurrent,
    });
    return {
      note: readBoundJournal(input.db, input.workspaceId, dateKey) as WorkspaceJournalRecord,
      existed: true,
      canWrite: true,
      role: access.role,
      archive,
    };
  }
}
