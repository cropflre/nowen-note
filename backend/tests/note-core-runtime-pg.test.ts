import assert from "node:assert/strict";
import test from "node:test";
import { v4 as uuid } from "uuid";

import { DbStatementChangeError } from "../src/db/adapters/types";
import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNotesRuntimeRouter } from "../src/routes/notes-runtime";
import { createNoteCoreRuntime, NoteCoreRuntimeError } from "../src/services/note-core-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-note-core-owner";
const OTHER = "pg-note-core-other";
const NOTEBOOK = "pg-note-core-notebook";
const OTHER_NOTEBOOK = "pg-note-core-other-notebook";
const TARGET = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const LOCKED = "33333333-3333-4333-8333-333333333333";
const OTHER_NOTE = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT = "55555555-5555-4555-8555-555555555555";

function doc(content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}

function paragraph(blockId: string | null, content: unknown[]) {
  return {
    type: "paragraph",
    ...(blockId ? { attrs: { blockId } } : {}),
    content,
  };
}

async function seed(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [OWNER, OTHER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $2, 'hash', 0), ($3, $4, 'hash', 0)`,
    [OWNER, OWNER, OTHER, OTHER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Core'), ($3, $4, 'Other')`,
    [NOTEBOOK, OWNER, OTHER_NOTEBOOK, OTHER],
  );

  const targetContent = doc([
    paragraph("blk_target00", [{ type: "text", text: "Old target body" }]),
  ]);
  const sourceContent = doc([
    paragraph("blk_source00", [{
      type: "text",
      text: "Old target",
      marks: [{
        type: "link",
        attrs: {
          href: `note:${TARGET}`,
          rel: "noopener noreferrer nofollow nowen-title-auto",
        },
      }],
    }]),
  ]);
  const lockedContent = doc([
    paragraph("blk_locked00", [{ type: "text", text: "Locked" }]),
  ]);

  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version, "isLocked"
     ) VALUES
       ($1, $2, $3, 'Old target', $4, 'Old target body', 'tiptap-json', 1, false),
       ($5, $2, $3, 'Source', $6, 'Old target', 'tiptap-json', 1, false),
       ($7, $2, $3, 'Locked', $8, 'Locked', 'tiptap-json', 1, true),
       ($9, $10, $11, 'Other', $8, 'Locked', 'tiptap-json', 1, false)`,
    [
      TARGET,
      OWNER,
      NOTEBOOK,
      targetContent,
      SOURCE,
      sourceContent,
      LOCKED,
      lockedContent,
      OTHER_NOTE,
      OTHER,
      OTHER_NOTEBOOK,
    ],
  );

  await pool.query(
    `INSERT INTO note_links (
       id, "userId", "sourceNoteId", "targetNoteId", "sourceBlockId", "linkType", "linkText"
     ) VALUES ($1, $2, $3, $4, 'blk_source00', 'note', 'Old target')`,
    [uuid(), OWNER, SOURCE, TARGET],
  );

  await pool.query(
    `INSERT INTO attachments (
       id, "noteId", "userId", filename, "mimeType", size, path
     ) VALUES ($1, $2, $3, 'image.png', 'image/png', 12, 'test/image.png')`,
    [ATTACHMENT, TARGET, OWNER],
  );
}

test("PostgreSQL core note runtime reads and saves Tiptap notes atomically", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const adapter = new PostgresAdapter(pool);
    const runtime = createNoteCoreRuntime(adapter, "postgres");

    const full = await runtime.getNote(OWNER, TARGET);
    assert.equal(full.id, TARGET);
    assert.equal(full.permission, "manage");
    assert.equal(full.isLocked, 0);
    assert.equal(full.contentFormat, "tiptap-json");
    assert.equal(typeof full.content, "string");

    const slim = await runtime.getNote(OWNER, TARGET, { slim: true });
    assert.equal("content" in slim, false);
    assert.equal("contentText" in slim, false);
    assert.equal(slim.version, 1);

    await assert.rejects(
      () => runtime.getNote(OTHER, TARGET),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      () => runtime.saveNote(OWNER, TARGET, { title: "Missing version" }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "VERSION_REQUIRED",
    );
    await assert.rejects(
      () => runtime.saveNote(OWNER, TARGET, { version: 0, title: "Stale" }),
      (error: unknown) => error instanceof NoteCoreRuntimeError
        && error.code === "VERSION_CONFLICT"
        && error.details?.currentVersion === 1,
    );
    await assert.rejects(
      () => runtime.saveNote(OWNER, LOCKED, { version: 1, title: "No" }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "NOTE_LOCKED",
    );
    await assert.rejects(
      () => runtime.saveNote(OWNER, TARGET, {
        version: 1,
        contentFormat: "plaintext",
        content: "Unsupported format",
      }),
      (error: unknown) => error instanceof NoteCoreRuntimeError
        && error.code === "INVALID_CONTENT_FORMAT",
    );

    const nextContent = doc([
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "New heading" }],
      },
      paragraph(null, [{
        type: "text",
        text: "Source note",
        marks: [{ type: "link", attrs: { href: `note:${SOURCE}` } }],
      }]),
      {
        type: "image",
        attrs: { src: `/api/attachments/${ATTACHMENT}`, alt: "local" },
      },
    ]);

    const saved = await runtime.saveNote(OWNER, TARGET, {
      version: 1,
      title: "New target",
      content: nextContent,
      contentFormat: "tiptap-json",
      contentText: "client value must be ignored",
    });
    assert.deepEqual(saved.warnings, []);
    assert.equal(saved.note.title, "New target");
    assert.equal(saved.note.version, 2);
    assert.equal(saved.note.contentText, "New heading\n\nSource note");

    const stored = await pool.query(
      `SELECT title, content, "contentText", version FROM notes WHERE id = $1`,
      [TARGET],
    );
    assert.equal(stored.rows[0].title, "New target");
    assert.equal(stored.rows[0].version, 2);
    assert.match(stored.rows[0].content, /blk_/);
    assert.equal(stored.rows[0].contentText, "New heading\n\nSource note");

    const versionRows = await pool.query(
      `SELECT title, version, "changeSummary" FROM note_versions WHERE "noteId" = $1`,
      [TARGET],
    );
    assert.equal(versionRows.rowCount, 1);
    assert.equal(versionRows.rows[0].title, "Old target");
    assert.equal(versionRows.rows[0].version, 1);

    const blocks = await pool.query(
      `SELECT "blockType", "plainText" FROM note_blocks_index
       WHERE "noteId" = $1 ORDER BY "blockOrder"`,
      [TARGET],
    );
    assert.deepEqual(
      blocks.rows.map((row) => [row.blockType, row.plainText]),
      [["heading", "New heading"], ["paragraph", "Source note"]],
    );

    const links = await pool.query(
      `SELECT "targetNoteId", "sourceBlockId" FROM note_links WHERE "sourceNoteId" = $1`,
      [TARGET],
    );
    assert.equal(links.rowCount, 1);
    assert.equal(links.rows[0].targetNoteId, SOURCE);
    assert.match(links.rows[0].sourceBlockId, /^blk_/);

    const references = await pool.query(
      `SELECT "attachmentId" FROM attachment_references WHERE "noteId" = $1`,
      [TARGET],
    );
    assert.deepEqual(references.rows.map((row) => row.attachmentId), [ATTACHMENT]);

    const propagated = await pool.query(
      `SELECT content, version FROM notes WHERE id = $1`,
      [SOURCE],
    );
    assert.equal(propagated.rows[0].version, 2);
    assert.match(propagated.rows[0].content, /New target/);
    assert.doesNotMatch(propagated.rows[0].content, /Old target/);

    const stableBlockCount = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_blocks_index WHERE "noteId" = $1`,
      [TARGET],
    )).rows[0].count);
    const guardVersionId = uuid();
    await assert.rejects(
      () => adapter.executeStatements([
        {
          sql: `INSERT INTO note_versions (
                  id, "noteId", "userId", title, content, "contentText",
                  "contentFormat", version
                ) VALUES (?, ?, ?, 'guard', '{}', '', 'tiptap-json', 99)`,
          params: [guardVersionId, TARGET, OWNER],
        },
        {
          sql: `UPDATE notes SET title = 'should rollback' WHERE id = ? AND version = ?`,
          params: [TARGET, 999],
          requireChanges: 1,
        },
        {
          sql: `DELETE FROM note_blocks_index WHERE "noteId" = ?`,
          params: [TARGET],
        },
      ]),
      (error: unknown) => error instanceof DbStatementChangeError,
    );
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_versions WHERE id = $1`,
      [guardVersionId],
    )).rows[0].count, 0);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_blocks_index WHERE "noteId" = $1`,
      [TARGET],
    )).rows[0].count, stableBlockCount);

    const router = createNotesRuntimeRouter(adapter, "postgres");
    const routeResponse = await router.request(`/${TARGET}?slim=1`, {
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(routeResponse.status, 200);
    const routeBody = await routeResponse.json() as Record<string, unknown>;
    assert.equal(routeBody.id, TARGET);
    assert.equal("content" in routeBody, false);

    const collectionResponse = await router.request("/", {
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(collectionResponse.status, 200);
    const collectionBody = await collectionResponse.json() as Array<{ id: string }>;
    assert.ok(collectionBody.some((note) => note.id === TARGET));
  } finally {
    await closePgPool(pool);
  }
});
