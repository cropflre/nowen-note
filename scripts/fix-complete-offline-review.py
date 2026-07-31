from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one marker, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


route = Path("backend/src/routes/offline-sync.ts")
text = route.read_text(encoding="utf-8")

corrected_segment = r'''function resolveNotebookAccess(
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
  return note.userId === userId || notebookIds.has(note.notebookId);
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

function personalNoteAccess(
  userId: string,
  notebookIds: Set<string>,
  alias = "n",
): { clause: string; params: unknown[] } {
  const ids = [...notebookIds];
  const notebookClause = ids.length > 0
    ? ` OR ${alias}.notebookId IN (${ids.map(() => "?").join(",")})`
    : "";
  return {
    clause: `${alias}.workspaceId IS NULL AND (${alias}.userId = ?${notebookClause})`,
    params: [userId, ...ids],
  };
}

function listAllAccessibleNotes(
  db: Database.Database,
  userId: string,
  scope: SyncScope,
  notebookIds: Set<string>,
): NoteRow[] {
  if (scope.workspaceId) {
    return db.prepare(`${noteSelectSql()} WHERE n.workspaceId = ? ORDER BY n.id ASC`)
      .all(userId, scope.workspaceId) as NoteRow[];
  }
  const access = personalNoteAccess(userId, notebookIds);
  return db.prepare(`${noteSelectSql()} WHERE ${access.clause} ORDER BY n.id ASC`)
    .all(userId, ...access.params) as NoteRow[];
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
  const rows = scope.workspaceId
    ? db.prepare(`${noteSelectSql()} WHERE n.workspaceId = ? AND n.id > ? ORDER BY n.id ASC LIMIT ?`)
        .all(userId, scope.workspaceId, cursor, target) as NoteRow[]
    : (() => {
        const access = personalNoteAccess(userId, notebookIds);
        return db.prepare(`${noteSelectSql()} WHERE ${access.clause} AND n.id > ? ORDER BY n.id ASC LIMIT ?`)
          .all(userId, ...access.params, cursor, target) as NoteRow[];
      })();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page,
    hasMore,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function attachmentMapForNotes(
  db: Database.Database,
  noteIds: string[],
): Map<string, AttachmentRow[]> {
  const result = new Map<string, AttachmentRow[]>();
  for (const batch of chunks(noteIds, 400)) {
    if (batch.length === 0) continue;
    const rows = db.prepare(`
      SELECT id, noteId, filename, mimeType, size, createdAt
      FROM attachments
      WHERE noteId IN (${batch.map(() => "?").join(",")})
      ORDER BY noteId ASC, id ASC
    `).all(...batch) as AttachmentRow[];
    for (const row of rows) {
      const list = result.get(row.noteId) || [];
      list.push(row);
      result.set(row.noteId, list);
    }
  }
  return result;
}

function tagMapForNotes(db: Database.Database, noteIds: string[]): Map<string, any[]> {
  const result = new Map<string, any[]>();
  for (const batch of chunks(noteIds, 400)) {
    if (batch.length === 0) continue;
    const rows = db.prepare(`
      SELECT nt.noteId AS linkedNoteId, t.*
      FROM note_tags nt
      INNER JOIN tags t ON t.id = nt.tagId
      WHERE nt.noteId IN (${batch.map(() => "?").join(",")})
      ORDER BY nt.noteId ASC, t.name COLLATE NOCASE ASC, t.id ASC
    `).all(...batch) as Array<any & { linkedNoteId: string }>;
    for (const row of rows) {
      const { linkedNoteId, ...tag } = row;
      const list = result.get(linkedNoteId) || [];
      list.push(tag);
      result.set(linkedNoteId, list);
    }
  }
  return result;
}

function buildBundles(db: Database.Database, userId: string, notes: NoteRow[]) {
  const noteIds = notes.map((note) => note.id);
  const attachmentsByNote = attachmentMapForNotes(db, noteIds);
  const tagsByNote = tagMapForNotes(db, noteIds);
  return notes.map((note) => {
    const allAttachments = attachmentsByNote.get(note.id) || [];
    const downloadAllowed = allAttachments.length === 0
      || Boolean(resolveEffectiveNoteCapabilities(note.id, userId).download);
    const attachments = downloadAllowed ? allAttachments : [];
    return {
      note: { ...note, tags: tagsByNote.get(note.id) || [] },
      attachments,
      attachmentDownloadAllowed: downloadAllowed,
      attachmentBytes: attachments.reduce(
        (sum, attachment) => sum + Number(attachment.size || 0),
        0,
      ),
      rawAttachmentCount: allAttachments.length,
    };
  });
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
  `).all() as any[]).filter(
    (tag) => tag.userId === userId || linkedTagIds.has(tag.id),
  );
}

app.get("/plan", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const scopeResult = resolveScope(c);
  if (scopeResult.response) return scopeResult.response;
  const scope = scopeResult.scope!;
  const access = resolveNotebookAccess(db, userId, scope);
  const notes = listAllAccessibleNotes(db, userId, scope, access.ids);
  const accessFingerprint = access.accessFingerprint;
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);
  const minSequence = minAvailableSequence(db);
  const serverSequence = currentSequence(db);

  let attachmentCount = 0;
  let attachmentBytes = 0;
  let attachmentForbiddenNotes = 0;
  for (const batch of chunks(notes, 200)) {
    for (const bundle of buildBundles(db, userId, batch)) {
      if (bundle.rawAttachmentCount > 0 && !bundle.attachmentDownloadAllowed) {
        attachmentForbiddenNotes += 1;
        continue;
      }
      attachmentCount += bundle.attachments.length;
      attachmentBytes += bundle.attachmentBytes;
    }
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
'''

text, count = re.subn(
    r'function resolveNotebookAccess\(.*?\napp\.get\("/snapshot",',
    corrected_segment + '\napp.get("/snapshot",',
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit(f"backend route repair: expected one damaged segment, found {count}")
route.write_text(text, encoding="utf-8")

# Avoid scanning the whole persistent job store once for every attachment.
replace_once(
    "frontend/src/lib/offlineWorkspaceSync.ts",
    '''  for (const attachment of desired) {
    const existing = await getOfflineAttachment(attachment.id);''',
    '''  const jobsById = new Map(
    (await getAllOfflineAttachmentJobs()).map((job) => [job.id, job] as const),
  );
  for (const attachment of desired) {
    const existing = await getOfflineAttachment(attachment.id);''',
)
replace_once(
    "frontend/src/lib/offlineWorkspaceSync.ts",
    '''    const prior = (await getAllOfflineAttachmentJobs()).find((job) => job.id === attachment.id);
    await putOfflineAttachmentJob({''',
    '''    const prior = jobsById.get(attachment.id);
    await putOfflineAttachmentJob({''',
)
