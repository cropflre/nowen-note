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
  // Normal note ACL intentionally conceals tombstones; recycle-bin lifecycle routes use the dedicated tombstone resolver.
  assert.equal(scan.notes.find((note) => note.noteId === TRASHED_NOTE_ID)?.status, "forbidden");
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

test("personal scope includes owned notes only and enforces exclusive selectors", async () => {
  await seed();
  const { localization } = await modules();
  const scan = localization.scanLocalizationScope(USER_ID, { allPersonal: true });
  assert.ok(scan.notes.some((note) => note.noteId === NOTE_ID));
  assert.ok(scan.notes.some((note) => note.noteId === SECOND_NOTE_ID));
  assert.ok(!scan.notes.some((note) => note.noteId === OTHER_NOTE_ID));
  assert.ok(!scan.notes.some((note) => note.noteId === TRASHED_NOTE_ID));
  assert.equal(scan.uniqueRemoteUrlCount, 1);
  assert.throws(
    () => localization.scanLocalizationScope(USER_ID, { allPersonal: true, noteIds: [NOTE_ID] }),
    /必须且只能提供一个/,
  );
});

test("image-level progress initializes by per-note URLs, not note count", async () => {
  await seed();
  const { localization } = await modules();
  const created = localization.createLocalizationJob(USER_ID, {
    noteIds: [NOTE_ID, SECOND_NOTE_ID, LOCKED_NOTE_ID],
  });
  assert.equal(created.summary.totalImageOperations, 2);
  // Cancel before the scheduled runner starts: no external network access needed.
  localization.cancelLocalizationJob(USER_ID, created.id);
  const completed = await waitForJob(USER_ID, created.id);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.summary.totalImageOperations, 2);
  assert.equal(completed.summary.processedImageOperations, 2);
  assert.equal(completed.summary.skippedImageOperations, 2);
  assert.equal(completed.summary.downloadedUniqueUrls, 0);
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

test("all-personal job scans automatically beyond the note and image batch limits", async () => {
  await seed();
  const { localization, getDb } = await modules();
  const db = getDb();
  const insert = db.prepare(`INSERT INTO notes
    (id, userId, notebookId, title, content, contentFormat, version)
    VALUES (?, ?, ?, 'Batch', ?, 'markdown', 1)`);
  db.transaction(() => {
    for (let i = 0; i < 105; i += 1) {
      insert.run(`batch-${i}`, USER_ID, NOTEBOOK_ID,
        Array.from({ length: 6 }, (_, j) => `![x](https://8.8.8.8/${i}-${j}.png)`).join("\n"));
    }
  })();
  try {
    const created = localization.createLocalizationJob(USER_ID, { allPersonal: true });
    assert.equal(created.status, "queued");
    assert.ok(created.summary.totalNotes > 100);
    assert.equal(created.summary.scannedNotes, 0, "scan must run in the background");
    localization.cancelLocalizationJob(USER_ID, created.id);
    const cancelled = await waitForJob(USER_ID, created.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.summary.downloadedUniqueUrls, 0);
    assert.equal(cancelled.summary.scannedNotes, 0);
  } finally {
    db.prepare("DELETE FROM notes WHERE id LIKE 'batch-%'").run();
  }
});

test("automatic batches save images past all batch bounds and preserve failed links (DCC-006)", async (context) => {
  await seed();
  const { localization, getDb } = await modules();
  const db = getDb();
  // Keep this fixture offline: public IPs pass SSRF checks and fetch is mocked.
  db.prepare("UPDATE notes SET content = '' WHERE userId = ? AND isLocked = 0 AND isTrashed = 0").run(USER_ID);
  const insert = db.prepare(`INSERT INTO notes
    (id, userId, notebookId, title, content, contentFormat, version)
    VALUES (?, ?, ?, 'Automatic batch', ?, 'markdown', 1)`);
  db.transaction(() => {
    for (let i = 0; i < 105; i += 1) {
      insert.run(`auto-${i}`, USER_ID, NOTEBOOK_ID, i < 2
        ? `![good](https://1.1.1.${i + 1}/good.png)\n![bad](https://1.1.1.${i + 3}/bad.png)` : "plain text");
    }
  })();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const largePng = Buffer.concat([png, Buffer.alloc(600_000)]);
  const fetchMock = context.mock.method(globalThis, "fetch", async (input: any) => {
    return String(input).includes("/bad.png")
      ? new Response("unavailable", { status: 503 })
      : new Response(largePng, { headers: { "content-type": "image/png" } });
  });
  process.env.REMOTE_IMAGE_LOCALIZATION_MAX_NOTES = "2";
  process.env.REMOTE_IMAGE_LOCALIZATION_MAX_IMAGES = "1";
  process.env.REMOTE_IMAGE_LOCALIZATION_MAX_TOTAL_MB = "1";
  try {
    const created = localization.createLocalizationJob(USER_ID, { allPersonal: true });
    const completed = await waitForJob(USER_ID, created.id);
    assert.equal(completed.status, "completed_with_errors");
    assert.ok(completed.summary.scannedNotes > 100);
    assert.equal(completed.summary.processedNotes, completed.summary.totalNotes);
    assert.equal(completed.summary.localizedUrls, 2);
    assert.equal(completed.summary.failedUrls, 2);
    assert.ok(completed.summary.downloadedBytes > 1024 * 1024, "capacity limit applies to cached batches, not the full library");
    assert.equal(fetchMock.mock.callCount(), 4);
    for (let i = 0; i < 2; i += 1) {
      const note = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(`auto-${i}`) as { content: string; version: number };
      assert.match(note.content, /\/api\/attachments\//);
      assert.match(note.content, /\/bad.png/);
      assert.equal(note.version, 2);
    }
    assert.ok(!completed.noteResults.some((note) => note.noteId === OTHER_NOTE_ID || note.noteId === TRASHED_NOTE_ID));
    // More retry notes than the configured batch size must still be admitted.
    process.env.REMOTE_IMAGE_LOCALIZATION_MAX_NOTES = "1";
    const retry = localization.retryLocalizationJob(USER_ID, completed.id);
    assert.equal(retry.summary.totalNotes, 2);
    localization.cancelLocalizationJob(USER_ID, retry.id);
    assert.equal((await waitForJob(USER_ID, retry.id)).status, "cancelled");
  } finally {
    delete process.env.REMOTE_IMAGE_LOCALIZATION_MAX_NOTES;
    delete process.env.REMOTE_IMAGE_LOCALIZATION_MAX_IMAGES;
    delete process.env.REMOTE_IMAGE_LOCALIZATION_MAX_TOTAL_MB;
    fetchMock.mock.restore();
    db.prepare("DELETE FROM notes WHERE id LIKE 'auto-%'").run();
  }
});

test("an interrupted automatic scan retries all unscanned notes beyond the batch limit", async (context) => {
  await seed();
  const { localization, getDb } = await modules();
  const db = getDb();
  const created = localization.createLocalizationJob(USER_ID, { allPersonal: true });
  const originalPrepare = db.prepare;
  const failure = context.mock.method(db, "prepare", function (sql: string) {
    if (sql.includes("SELECT id, userId, notebookId")) throw new Error("Scan interrupted");
    return originalPrepare.call(db, sql);
  });
  const interrupted = await waitForJob(USER_ID, created.id);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.summary.scannedNotes, 0);
  failure.mock.restore();
  process.env.REMOTE_IMAGE_LOCALIZATION_MAX_NOTES = "1";
  try {
    const retry = localization.retryLocalizationJob(USER_ID, created.id);
    assert.equal(retry.summary.totalNotes, created.summary.totalNotes);
    assert.equal(retry.summary.scannedNotes, 0);
    localization.cancelLocalizationJob(USER_ID, retry.id);
    assert.equal((await waitForJob(USER_ID, retry.id)).status, "cancelled");
  } finally {
    delete process.env.REMOTE_IMAGE_LOCALIZATION_MAX_NOTES;
  }
});

test("automatic scan skips notes moved into a workspace after the job was created (DCC-006)", async () => {
  await seed();
  const { localization, getDb } = await modules();
  const db = getDb();
  db.prepare("UPDATE notes SET content = '' WHERE userId = ? AND isLocked = 0").run(USER_ID);
  db.prepare("INSERT OR IGNORE INTO workspaces (id, ownerId) VALUES ('localization-workspace', ?)").run(USER_ID);
  db.prepare("UPDATE notes SET content = '![x](https://8.8.4.4/workspace.png)' WHERE id = ?").run(NOTE_ID);
  const created = localization.createLocalizationJob(USER_ID, { allPersonal: true });
  db.prepare("UPDATE notes SET workspaceId = 'localization-workspace' WHERE id = ?").run(NOTE_ID);
  try {
    const completed = await waitForJob(USER_ID, created.id);
    assert.equal(completed.summary.downloadedUniqueUrls, 0);
    assert.equal(completed.noteResults.find((note) => note.noteId === NOTE_ID)?.status, "forbidden");
  } finally {
    db.prepare("UPDATE notes SET workspaceId = NULL WHERE id = ?").run(NOTE_ID);
  }
});

test("an edit during automatic download retains the newer body and creates no attachment (DCC-004)", async (context) => {
  await seed();
  const { localization, getDb } = await modules();
  const db = getDb();
  db.prepare("UPDATE notes SET content = '' WHERE userId = ? AND isLocked = 0").run(USER_ID);
  db.prepare("UPDATE notes SET content = '![x](https://4.2.2.1/edit.png)' WHERE id = ?").run(NOTE_ID);
  const existing = db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId = ?").get(NOTE_ID) as { count: number };
  context.mock.method(globalThis, "fetch", async () => {
    db.prepare("UPDATE notes SET content = 'newer unsynced edit', version = version + 1 WHERE id = ?").run(NOTE_ID);
    return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { headers: { "content-type": "image/png" } });
  });
  const created = localization.createLocalizationJob(USER_ID, { allPersonal: true });
  const completed = await waitForJob(USER_ID, created.id);
  assert.equal(completed.summary.localizedUrls, 0);
  assert.equal(completed.summary.failedUrls, 1);
  const note = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(NOTE_ID) as { content: string; version: number };
  assert.equal(note.content, "newer unsynced edit");
  assert.equal(note.version, 8);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId = ?").get(NOTE_ID), existing);
});

test("stopping during a rate-limit cooldown does not download or fail remaining images", async (context) => {
  await seed();
  const { localization, getDb } = await modules();
  const db = getDb();
  db.prepare("UPDATE notes SET content = '' WHERE userId = ? AND isLocked = 0").run(USER_ID);
  db.prepare("UPDATE notes SET content = '![x](https://9.9.9.9/one.png)\n![y](https://9.9.9.9/two.png)' WHERE id = ?").run(NOTE_ID);
  let jobId = "";
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    setTimeout(() => localization.cancelLocalizationJob(USER_ID, jobId), 20);
    return new Response("limited", { status: 429, headers: { "retry-after": "60" } });
  });
  const created = localization.createLocalizationJob(USER_ID, { allPersonal: true });
  jobId = created.id;
  const completed = await waitForJob(USER_ID, created.id);
  assert.equal(completed.status, "cancelled");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(completed.summary.failedUrls, 0);
  assert.equal(completed.summary.localizedUrls, 0);
  assert.equal(completed.summary.processedImageOperations, completed.summary.totalImageOperations);
});
