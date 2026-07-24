import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-image-localization-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const USER_ID = "user-image-localization";
const OTHER_USER_ID = "user-image-localization-other";
const NOTEBOOK_ID = "nb-image-localization";
const CHILD_NOTEBOOK_ID = "nb-image-localization-child";
const NOTE_ID = "note-image-localization";
const SECOND_NOTE_ID = "note-image-localization-second";
const LOCKED_NOTE_ID = "note-image-localization-locked";
const TRASHED_NOTE_ID = "note-image-localization-trashed";
const OTHER_NOTE_ID = "note-image-localization-other";

async function modules() {
  const [{ getDb }, localization, importer] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/remote-image-localization"),
    import("../src/services/remote-image-import"),
  ]);
  return { getDb, localization, importer };
}

async function seed() {
  const { getDb } = await modules();
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OTHER_USER_ID, OTHER_USER_ID, "hash");
  db.prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, USER_ID, "Images");
  db.prepare("INSERT OR IGNORE INTO notebooks (id, userId, name, parentId) VALUES (?, ?, ?, ?)")
    .run(CHILD_NOTEBOOK_ID, USER_ID, "Child", NOTEBOOK_ID);
  db.prepare(`
    INSERT OR REPLACE INTO notes
      (id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked, isTrashed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    NOTE_ID,
    USER_ID,
    NOTEBOOK_ID,
    "Remote images",
    "![remote](https://cdn.example.com/a.png)\n![local](/api/attachments/local-1)\n![data](data:image/png;base64,AAAA)",
    "",
    "markdown",
    7,
    0,
    0,
  );
  db.prepare(`
    INSERT OR REPLACE INTO notes
      (id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked, isTrashed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SECOND_NOTE_ID,
    USER_ID,
    CHILD_NOTEBOOK_ID,
    "Second",
    "![same](https://cdn.example.com/a.png)",
    "",
    "markdown",
    2,
    0,
    0,
  );
  db.prepare(`
    INSERT OR REPLACE INTO notes
      (id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked, isTrashed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(LOCKED_NOTE_ID, USER_ID, NOTEBOOK_ID, "Locked", "![x](https://cdn.example.com/x.png)", "", "markdown", 1, 1, 0);
  db.prepare(`
    INSERT OR REPLACE INTO notes
      (id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked, isTrashed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(TRASHED_NOTE_ID, USER_ID, NOTEBOOK_ID, "Trashed", "![x](https://cdn.example.com/x.png)", "", "markdown", 1, 0, 1);

  db.prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run("nb-image-other", OTHER_USER_ID, "Other");
  db.prepare(`
    INSERT OR REPLACE INTO notes
      (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(OTHER_NOTE_ID, OTHER_USER_ID, "nb-image-other", "Other", "![x](https://cdn.example.com/other.png)", "", "markdown", 1);
}

async function waitForJob(userId: string, jobId: string) {
  const { localization } = await modules();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = localization.getLocalizationJob(userId, jobId);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("localization job did not finish");
}

test("scanLocalizationScope reports remote/local/ignored images and permission skips", async () => {
  await seed();
  const { localization } = await modules();
  const scan = localization.scanLocalizationScope(USER_ID, {
    noteIds: [NOTE_ID, LOCKED_NOTE_ID, TRASHED_NOTE_ID, OTHER_NOTE_ID],
    expectedVersions: { [NOTE_ID]: 7 },
  });

  assert.equal(scan.noteCount, 4);
  assert.equal(scan.readyNoteCount, 1);
  assert.equal(scan.notesWithRemoteImages, 1);
  assert.equal(scan.remoteReferenceCount, 1);
  assert.equal(scan.localReferenceCount, 1);
  assert.equal(scan.ignoredReferenceCount, 1);
  assert.equal(scan.uniqueRemoteUrlCount, 1);
  assert.equal(scan.notes.find((note) => note.noteId === LOCKED_NOTE_ID)?.status, "locked");
  assert.equal(scan.notes.find((note) => note.noteId === TRASHED_NOTE_ID)?.status, "trashed");
  assert.equal(scan.notes.find((note) => note.noteId === OTHER_NOTE_ID)?.status, "forbidden");
});

test("notebook scope includes descendants and deduplicates task URLs", async () => {
  await seed();
  const { localization } = await modules();
  const scan = localization.scanLocalizationScope(USER_ID, { notebookId: NOTEBOOK_ID });
  assert.ok(scan.notes.some((note) => note.noteId === NOTE_ID));
  assert.ok(scan.notes.some((note) => note.noteId === SECOND_NOTE_ID));
  assert.equal(scan.uniqueRemoteUrlCount, 1);
  assert.equal(scan.remoteReferenceCount, 2);
});

test("expected version mismatch is recorded without downloading or overwriting", async () => {
  await seed();
  const { localization, getDb } = await modules();
  const created = localization.createLocalizationJob(USER_ID, {
    noteIds: [NOTE_ID],
    expectedVersions: { [NOTE_ID]: 6 },
  });
  const completed = await waitForJob(USER_ID, created.id);
  assert.equal(completed.status, "completed_with_errors");
  assert.equal(completed.noteResults[0].status, "conflict");
  assert.equal(completed.summary.downloadedUniqueUrls, 0);
  const row = getDb().prepare("SELECT version, content FROM notes WHERE id = ?").get(NOTE_ID) as { version: number; content: string };
  assert.equal(row.version, 7);
  assert.match(row.content, /https:\/\/cdn\.example\.com\/a\.png/);
});

test("same-note retry reuses an existing attachment row and cross-note dedup shares storage", async () => {
  await seed();
  const { importer, getDb } = await modules();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const downloaded = {
    buffer: png,
    mimeType: "image/png",
    filename: "pixel.png",
    finalUrl: "https://cdn.example.com/pixel.png",
  };

  const first = await importer.saveDownloadedRemoteImageForNote({
    downloaded,
    sourceUrl: downloaded.finalUrl,
    noteId: NOTE_ID,
    userId: USER_ID,
    workspaceId: null,
    uploadSource: "test-localization",
  });
  const sameNote = await importer.saveDownloadedRemoteImageForNote({
    downloaded,
    sourceUrl: downloaded.finalUrl,
    noteId: NOTE_ID,
    userId: USER_ID,
    workspaceId: null,
    uploadSource: "test-localization",
  });
  assert.equal(sameNote.id, first.id);
  assert.equal(sameNote.deduplicated, true);

  const secondNote = await importer.saveDownloadedRemoteImageForNote({
    downloaded,
    sourceUrl: downloaded.finalUrl,
    noteId: SECOND_NOTE_ID,
    userId: USER_ID,
    workspaceId: null,
    uploadSource: "test-localization",
  });
  assert.notEqual(secondNote.id, first.id);
  assert.equal(secondNote.deduplicated, true);

  const rows = getDb().prepare("SELECT id, noteId, path FROM attachments WHERE id IN (?, ?) ORDER BY noteId")
    .all(first.id, secondNote.id) as Array<{ id: string; noteId: string; path: string }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].path, rows[1].path);
  const sameNoteCount = getDb().prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId = ? AND hash IS NOT NULL")
    .get(NOTE_ID) as { count: number };
  assert.equal(sameNoteCount.count, 1);
});

test("job ownership is isolated", async () => {
  await seed();
  const { localization } = await modules();
  const created = localization.createLocalizationJob(USER_ID, { noteIds: [LOCKED_NOTE_ID] });
  await assert.rejects(
    async () => localization.getLocalizationJob(OTHER_USER_ID, created.id),
    (error: any) => error?.code === "JOB_NOT_FOUND",
  );
});
