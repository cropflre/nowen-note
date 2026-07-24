import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-image-authority-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_YJS_SUBDOCUMENTS = "1";

const USER_ID = "remote-authority-user";
const NOTEBOOK_ID = "remote-authority-book";
const NOTE_ID = "41414141-4141-4414-8414-414141414141";
let closeDb: (() => void) | undefined;

test.after(() => {
  closeDb?.();
  delete process.env.NOWEN_YJS_SUBDOCUMENTS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [schema, localization, importer, store] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/remote-image-localization"),
    import("../src/services/remote-image-import"),
    import("../src/lib/blockAuthorityStore"),
  ]);
  closeDb = schema.closeDb;
  return { ...schema, localization, importer, store };
}

async function seed() {
  const { getDb } = await modules();
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db.prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, USER_ID, "Authority images");
  const content = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "blk_remote_authority" },
        content: [{ type: "text", text: "before" }],
      },
      {
        type: "image",
        attrs: {
          blockId: "blk_remote_image",
          src: "https://cdn.example.com/authority.png",
          alt: "authority",
        },
      },
    ],
  });
  db.prepare(`
    INSERT OR REPLACE INTO notes
      (id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked, isTrashed)
    VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json', 5, 0, 0)
  `).run(NOTE_ID, USER_ID, NOTEBOOK_ID, "Authority image", content, "before");
  return content;
}

function pixelPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

test("whole-note localization rebuilds Block Authority and Yjs subdocuments", async () => {
  const original = await seed();
  const { getDb, localization, importer, store } = await modules();
  const imported = await importer.saveDownloadedRemoteImageForNote({
    downloaded: {
      buffer: pixelPng(),
      mimeType: "image/png",
      filename: "authority.png",
      finalUrl: "https://cdn.example.com/authority.png",
    },
    sourceUrl: "https://cdn.example.com/authority.png",
    noteId: NOTE_ID,
    userId: USER_ID,
    workspaceId: null,
    uploadSource: "authority-test",
  });

  const applied = localization.applyLocalizedContent({
    userId: USER_ID,
    noteId: NOTE_ID,
    scannedVersion: 5,
    scannedContent: original,
    contentFormat: "tiptap-json",
    replacements: new Map([["https://cdn.example.com/authority.png", imported.url]]),
  });
  assert.equal(applied.updated, true);
  assert.equal(applied.conflict, false);
  assert.equal(applied.finalVersion, 6);

  const db = getDb();
  const note = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(NOTE_ID) as {
    content: string;
    version: number;
  };
  assert.equal(note.version, 6);
  assert.match(note.content, new RegExp(imported.id));
  assert.equal(store.readAuthoritativeNoteContent(db, NOTE_ID, note.content).source, "blocks");
  assert.equal(
    (db.prepare("SELECT status FROM note_block_documents WHERE noteId = ?").get(NOTE_ID) as { status: string }).status,
    "healthy",
  );
  const manifest = db.prepare(
    "SELECT generation, structureVersion FROM note_y_subdocument_manifests WHERE noteId = ?",
  ).get(NOTE_ID) as { generation: number; structureVersion: number } | undefined;
  assert.ok(manifest);
  assert.ok(manifest.generation >= 1);
  assert.ok(manifest.structureVersion >= 1);
});

test("late conflict can roll back task-created attachment rows and objects", async () => {
  const original = await seed();
  const { getDb } = await modules();
  const mutation = await import("../src/services/remote-image-localization-mutation");
  const saved = await mutation.saveLocalizedAttachment({
    jobId: "late-conflict-job",
    userId: USER_ID,
    noteId: NOTE_ID,
    workspaceId: null,
    sourceUrl: "https://cdn.example.com/late.png",
    downloaded: {
      buffer: pixelPng(),
      mimeType: "image/png",
      filename: "late.png",
      finalUrl: "https://cdn.example.com/late.png",
    },
  });
  assert.ok(saved.created);
  const db = getDb();
  db.prepare("UPDATE notes SET version = version + 1, content = content || ' ' WHERE id = ?").run(NOTE_ID);
  const applied = mutation.applyLocalizedContent({
    userId: USER_ID,
    noteId: NOTE_ID,
    scannedVersion: 5,
    scannedContent: original,
    contentFormat: "tiptap-json",
    replacements: new Map([["https://cdn.example.com/late.png", saved.imported.url]]),
  });
  assert.equal(applied.conflict, true);
  await mutation.rollbackLocalizedAttachments([saved.created!]);
  assert.equal(db.prepare("SELECT id FROM attachments WHERE id = ?").get(saved.imported.id), undefined);
});
