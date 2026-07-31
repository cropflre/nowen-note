import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole } from "../middleware/acl";
import { resolveEffectiveNoteCapabilities } from "../services/share-capabilities";

const app = new Hono();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const CHANGE_PAGE_SIZE = 500;
const CLIENT_RETENTION_DAYS = 90;
const CHANGE_HARD_RETENTION_DAYS = 180;

interface SyncScope {
  key: string;
  workspaceId: string | null;
  role: string | null;
}

interface NotebookRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  name: string;
  description: string | null;
  icon: string;
  color: string | null;
  sortOrder: number;
  isExpanded: number;
  isDeleted?: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;
  title: string;
  content: string;
  contentText: string;
  contentFormat?: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  isTrashed: number;
  trashedAt: string | null;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface AttachmentRow {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

interface ChangeRow {
  sequence: number;
  entityType: "note" | "attachment";
  entityId: string;
  noteId: string | null;
  userId: string;
  workspaceId: string | null;
  notebookId: string | null;
  operation: "upsert" | "delete";
  version: number | null;
  changedAt: string;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function currentSequence(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(sequence) AS sequence FROM offline_sync_changes").get() as
    | { sequence: number | null }
    | undefined;
  return Number(row?.sequence || 0);
}

function minAvailableSequence(db: Database.Database): number {
  const row = db.prepare("SELECT MIN(sequence) AS sequence FROM offline_sync_changes").get() as
    | { sequence: number | null }
    | undefined;
  return Number(row?.sequence || 0);
}

function resolveScope(c: any): { scope?: SyncScope; response?: Response } {
  const userId = c.req.header("X-User-Id") || "";
  const requested = (c.req.query("workspaceId") || "personal").trim();
  if (!requested || requested === "personal") {
    return { scope: { key: "personal", workspaceId: null, role: null } };
  }
  const role = getUserWorkspaceRole(requested, userId);
  if (!role) {
    return {
      response: c.json(
        { error: "无权同步该工作区", code: "OFFLINE_SYNC_SCOPE_FORBIDDEN" },
        403,
      ),
    };
  }
  return { scope: { key: `workspace:${requested}`, workspaceId: requested, role } };
}

function personalNotebookAccess(db: Database.Database, userId: string): {
  rows: NotebookRow[];
  ids: Set<string>;
  fingerprintParts: string[];
} {
  const rows = db.prepare(`
    SELECT id, userId, workspaceId, parentId, name, description, icon, color,
           sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    FROM notebooks
    WHERE workspaceId IS NULL
    ORDER BY id ASC
  `).all() as NotebookRow[];

  const members = db.prepare(`
    SELECT notebookId, role, allowDownload, allowReshare, status, updatedAt
    FROM notebook_members
    WHERE userId = ? AND status != 'removed'
    ORDER BY notebookId ASC
  `).all(userId) as Array<{
    notebookId: string;
    role: string;
    allowDownload: number;
    allowReshare: number;
    status: string;
    updatedAt: string;
  }>;

  const ids = new Set<string>();
  for (const row of rows) {
    if (row.userId === userId) ids.add(row.id);
  }
  for (const member of members) ids.add(member.notebookId);

  // Notebook sharing inherits down the tree. Expand all descendants of owned or
  // shared roots so the offline snapshot matches resolveNotebookPermission().
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        changed = true;
      }
    }
  }

  const fingerprintParts = [
    ...rows
      .filter((row) => ids.has(row.id))
      .map((row) => `n:${row.id}:${row.parentId || ""}:${row.userId}:${row.updatedAt}:${row.isDeleted || 0}`),
    ...members.map((member) =>
      `m:${member.notebookId}:${member.role}:${member.allowDownload}:${member.allowReshare}:${member.updatedAt}`,
    ),
  ];

  return { rows: rows.filter((row) => ids.has(row.id)), ids, fingerprintParts };
}

function workspaceNotebookAccess(
  db: Database.Database,
  workspaceId: string,
  role: string | null,
): { rows: NotebookRow[]; ids: Set<string>; fingerprintParts: string[] } {
  const rows = db.prepare(`
    SELECT id, userId, workspaceId, parentId, name, description, icon, color,
           sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    FROM notebooks
    WHERE workspaceId = ?
    ORDER BY id ASC
  `).all(workspaceId) as NotebookRow[];
  return {
    rows,
    ids: new Set(rows.map((row) => row.id)),
    fingerprintParts: [
      `workspace:${workspaceId}:${role || ""}`,
      ...rows.map((row) => `n:${row.id}:${row.parentId || ""}:${row.updatedAt}:${row.isDeleted || 0}`),
    ],
  };
}

function resolveNotebookAccess(
  db: Database.Database,
  userId: string,
  scope: SyncScope,
): { rows: NotebookRow[]; ids: Set<string>; accessFingerprint: string } {
  const resolved = scope.workspaceId
    ? workspaceNotebookAccess(db, scope.workspaceId, scope.role)
    : personalNotebookAccess(db, userId);
  const accessFingerprint = createHash("sha256")
    .update(resolved.fingerprintParts.sort().join("\n"))
    .digest("hex");
  return { rows: resolved.rows, ids: resolved.ids, accessFingerprint };
}

function noteIsInScope(
  note: Pick<NoteRow, "id" | "userId" | "workspaceId" | "notebookId">,
  userId: string,
  scope: SyncScope,
  notebookIds: Set<string>,
): boolean {
  if (scope.workspaceId) return note.workspaceId === scope.workspaceId;
  if (note.workspaceId !== null) return false;
  if (note.userId === userId || notebookIds.has(note.notebookId)) return true;
  return resolveEffectiveNoteCapabilities(note.id, userId).read;
}

function noteSelectSql(): string {
  return `SELECT n.id, n.userId, n.notebookId, n.workspaceId, n.title,
      n.content, n.contentText, n.contentFormat, n.isPinned,
      CASE WHEN EXISTS(
        SELECT 1 FROM favorites f WHERE f.noteId = n.id AND f.userId = ?
      ) THEN 1 ELSE 0 END AS isFavorite,
      n.isLocked, n.isArchived, n.isTrashed, n.trashedAt, n.version,
      n.sortOrder, n.createdAt, n.updatedAt
    FROM notes n`;
}

function listAllAccessibleNotes(
  db: Database.Database,
  userId: string,
  scope: SyncScope,
  notebookIds: Set<string>,
): NoteRow[] {
  const rows = scope.workspaceId
    ? db.prepare(`${noteSelectSql()} WHERE n.workspaceId = ? ORDER BY n.id ASC`)
        .all(userId, scope.workspaceId) as NoteRow[]
    : db.prepare(`${noteSelectSql()} WHERE n.workspaceId IS NULL ORDER BY n.id ASC`)
        .all(userId) as NoteRow[];
  return rows.filter((row) => noteIsInScope(row, userId, scope, notebookIds));
}

function listSnapshotPage(
  db: Database.Database,
  userId: string,
  scope: SyncScope,
  notebookIds: Set<string>,
  cursor: string,
  limit: number,
): { rows: NoteRow[]; hasMore: boolean; nextCursor: string | null } {
  const target = limit + 1;
  const collected: NoteRow[] = [];
  let scanCursor = cursor;
  let reachedEnd = false;

  while (collected.length < target && !reachedEnd) {
    const scanLimit = Math.max(100, target * 3);
    const rows = scope.workspaceId
      ? db.prepare(`${noteSelectSql()} WHERE n.workspaceId = ? AND n.id > ? ORDER BY n.id ASC LIMIT ?`)
          .all(userId, scope.workspaceId, scanCursor, scanLimit) as NoteRow[]
      : db.prepare(`${noteSelectSql()} WHERE n.workspaceId IS NULL AND n.id > ? ORDER BY n.id ASC LIMIT ?`)
          .all(userId, scanCursor, scanLimit) as NoteRow[];

    if (rows.length === 0) break;
    for (const row of rows) {
      if (noteIsInScope(row, userId, scope, notebookIds)) collected.push(row);
      if (collected.length >= target) break;
    }
    scanCursor = rows[rows.length - 1].id;
    reachedEnd = rows.length < scanLimit;
  }

  const hasMore = collected.length > limit;
  const rows = hasMore ? collected.slice(0, limit) : collected;
  return {
    rows,
    hasMore,
    nextCursor: hasMore && rows.length > 0 ? rows[rows.length - 1].id : null,
  };
}

function listAttachments(db: Database.Database, noteId: string): AttachmentRow[] {
  return db.prepare(`
    SELECT id, noteId, filename, mimeType, size, createdAt
    FROM attachments
    WHERE noteId = ?
    ORDER BY id ASC
  `).all(noteId) as AttachmentRow[];
}

function listNoteTags(db: Database.Database, noteId: string): any[] {
  return db.prepare(`
    SELECT t.*
    FROM tags t
    INNER JOIN note_tags nt ON nt.tagId = t.id
    WHERE nt.noteId = ?
    ORDER BY t.name COLLATE NOCASE ASC, t.id ASC
  `).all(noteId) as any[];
}

function buildBundle(db: Database.Database, userId: string, note: NoteRow) {
  const capabilities = resolveEffectiveNoteCapabilities(note.id, userId);
  const downloadAllowed = Boolean(capabilities.read && capabilities.download);
  const attachments = downloadAllowed ? listAttachments(db, note.id) : [];
  return {
    note: { ...note, tags: listNoteTags(db, note.id) },
    attachments,
    attachmentDownloadAllowed: downloadAllowed,
    attachmentBytes: attachments.reduce((sum, attachment) => sum + Number(attachment.size || 0), 0),
  };
}

function listTagsForScope(
  db: Database.Database,
  userId: string,
  scope: SyncScope,
  accessibleNotes: NoteRow[],
): any[] {
  if (scope.workspaceId) {
    return db.prepare(`
      SELECT * FROM tags
      WHERE workspaceId = ?
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `).all(scope.workspaceId) as any[];
  }

  const accessibleNoteIds = new Set(accessibleNotes.map((note) => note.id));
  const linkedTagIds = new Set(
    (db.prepare(`
      SELECT nt.noteId, nt.tagId
      FROM note_tags nt
      INNER JOIN notes n ON n.id = nt.noteId
      WHERE n.workspaceId IS NULL
    `).all() as Array<{ noteId: string; tagId: string }>)
      .filter((row) => accessibleNoteIds.has(row.noteId))
      .map((row) => row.tagId),
  );

  return (db.prepare(`
    SELECT * FROM tags
    WHERE workspaceId IS NULL
    ORDER BY name COLLATE NOCASE ASC, id ASC
  `).all() as any[]).filter((tag) => tag.userId === userId || linkedTagIds.has(tag.id));
}

app.get("/plan", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const scopeResult = resolveScope(c);
  if (scopeResult.response) return scopeResult.response;
  const scope = scopeResult.scope!;
  const access = resolveNotebookAccess(db, userId, scope);
  const notes = listAllAccessibleNotes(db, userId, scope, access.ids);
  const accessFingerprint = createHash("sha256")
    .update([
      access.accessFingerprint,
      ...notes.map((note) => {
        const capabilities = resolveEffectiveNoteCapabilities(note.id, userId);
        return `note:${note.id}:${note.notebookId}:${note.workspaceId || ""}:${capabilities.permission || ""}:${capabilities.download ? 1 : 0}`;
      }),
    ].sort().join("\n"))
    .digest("hex");
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);
  const minSequence = minAvailableSequence(db);
  const serverSequence = currentSequence(db);

  let attachmentCount = 0;
  let attachmentBytes = 0;
  let attachmentForbiddenNotes = 0;
  for (const note of notes) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
      FROM attachments WHERE noteId = ?
    `).get(note.id) as { count: number; bytes: number };
    const count = Number(row.count || 0);
    if (count === 0) continue;
    const capabilities = resolveEffectiveNoteCapabilities(note.id, userId);
    if (!capabilities.read || !capabilities.download) {
      attachmentForbiddenNotes += 1;
      continue;
    }
    attachmentCount += count;
    attachmentBytes += Number(row.bytes || 0);
  }

  return c.json({
    scopeKey: scope.key,
    workspaceId: scope.workspaceId,
    serverSequence,
    minAvailableSequence: minSequence,
    resetRequired: after > 0 && minSequence > 0 && after < minSequence - 1,
    accessFingerprint,
    noteCount: notes.length,
    attachmentCount,
    attachmentBytes,
    attachmentForbiddenNotes,
    notebooks: access.rows,
    tags: listTagsForScope(db, userId, scope, notes),
    serverTime: new Date().toISOString(),
  });
});

app.get("/snapshot", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const scopeResult = resolveScope(c);
  if (scopeResult.response) return scopeResult.response;
  const scope = scopeResult.scope!;
  const access = resolveNotebookAccess(db, userId, scope);
  const cursor = (c.req.query("cursor") || "").trim();
  const limit = clampInt(c.req.query("limit"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const requestedSequence = Number(c.req.query("snapshotSequence") || 0) || 0;
  const snapshotSequence = requestedSequence > 0 ? requestedSequence : currentSequence(db);
  const page = listSnapshotPage(db, userId, scope, access.ids, cursor, limit);

  return c.json({
    scopeKey: scope.key,
    snapshotSequence,
    items: page.rows.map((note) => buildBundle(db, userId, note)),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  });
});

app.get("/changes", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const scopeResult = resolveScope(c);
  if (scopeResult.response) return scopeResult.response;
  const scope = scopeResult.scope!;
  const access = resolveNotebookAccess(db, userId, scope);
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);
  const limit = clampInt(c.req.query("limit"), CHANGE_PAGE_SIZE, 1, 1000);
  const minSequence = minAvailableSequence(db);
  const serverSequence = currentSequence(db);

  if (after > 0 && minSequence > 0 && after < minSequence - 1) {
    return c.json({
      scopeKey: scope.key,
      resetRequired: true,
      minAvailableSequence: minSequence,
      serverSequence,
      nextSequence: after,
      hasMore: false,
      items: [],
    });
  }

  const raw = scope.workspaceId
    ? db.prepare(`
        SELECT * FROM offline_sync_changes
        WHERE sequence > ? AND workspaceId = ?
        ORDER BY sequence ASC
        LIMIT ?
      `).all(after, scope.workspaceId, limit) as ChangeRow[]
    : db.prepare(`
        SELECT * FROM offline_sync_changes
        WHERE sequence > ? AND workspaceId IS NULL
        ORDER BY sequence ASC
        LIMIT ?
      `).all(after, limit) as ChangeRow[];

  const nextSequence = raw.length > 0 ? raw[raw.length - 1].sequence : serverSequence;
  const latestByNote = new Map<string, ChangeRow>();
  for (const change of raw) {
    const noteId = change.noteId || (change.entityType === "note" ? change.entityId : "");
    if (!noteId) continue;
    if (scope.workspaceId) {
      latestByNote.set(noteId, change);
      continue;
    }
    if (change.userId === userId || (change.notebookId && access.ids.has(change.notebookId))) {
      latestByNote.set(noteId, change);
    }
  }

  const items: any[] = [];
  for (const [noteId, change] of latestByNote.entries()) {
    const note = db.prepare(`${noteSelectSql()} WHERE n.id = ?`).get(userId, noteId) as NoteRow | undefined;
    if (note && noteIsInScope(note, userId, scope, access.ids)) {
      items.push({
        sequence: change.sequence,
        operation: "upsert",
        ...buildBundle(db, userId, note),
      });
    } else {
      items.push({
        sequence: change.sequence,
        operation: "delete",
        noteId,
      });
    }
  }
  items.sort((a, b) => a.sequence - b.sequence);

  return c.json({
    scopeKey: scope.key,
    resetRequired: false,
    minAvailableSequence: minSequence,
    serverSequence,
    nextSequence,
    hasMore: raw.length === limit && nextSequence < serverSequence,
    items,
  });
});

app.post("/ack", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json().catch(() => ({})) as {
    clientId?: unknown;
    scopeKey?: unknown;
    sequence?: unknown;
  };
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const scopeKey = typeof body.scopeKey === "string" ? body.scopeKey.trim() : "";
  const sequence = Number(body.sequence);
  if (!clientId || clientId.length > 128 || !scopeKey || scopeKey.length > 160 || !Number.isSafeInteger(sequence) || sequence < 0) {
    return c.json({ error: "Invalid sync acknowledgement", code: "INVALID_SYNC_ACK" }, 400);
  }

  db.prepare(`
    INSERT INTO offline_sync_clients (clientId, userId, scopeKey, lastSequence, lastSeenAt)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(clientId, userId, scopeKey) DO UPDATE SET
      lastSequence = CASE
        WHEN excluded.lastSequence > offline_sync_clients.lastSequence
          THEN excluded.lastSequence
        ELSE offline_sync_clients.lastSequence
      END,
      lastSeenAt = datetime('now')
  `).run(clientId, userId, scopeKey, sequence);

  db.prepare(`
    DELETE FROM offline_sync_clients
    WHERE lastSeenAt < datetime('now', '-${CLIENT_RETENTION_DAYS} days')
  `).run();

  const oldestAck = db.prepare(`
    SELECT MIN(lastSequence) AS sequence
    FROM offline_sync_clients
    WHERE lastSeenAt >= datetime('now', '-${CLIENT_RETENTION_DAYS} days')
  `).get() as { sequence: number | null } | undefined;
  if (oldestAck?.sequence && oldestAck.sequence > 0) {
    db.prepare(`
      DELETE FROM offline_sync_changes
      WHERE sequence <= ? AND changedAt < datetime('now', '-7 days')
    `).run(oldestAck.sequence);
  }
  db.prepare(`
    DELETE FROM offline_sync_changes
    WHERE changedAt < datetime('now', '-${CHANGE_HARD_RETENTION_DAYS} days')
  `).run();

  return c.json({
    success: true,
    acknowledgedSequence: sequence,
    minAvailableSequence: minAvailableSequence(db),
  });
});

export default app;
