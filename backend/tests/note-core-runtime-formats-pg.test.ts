import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteCoreRuntime, NoteCoreRuntimeError } from "../src/services/note-core-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-note-formats-owner";
const EDITOR = "pg-note-formats-editor";
const NOTEBOOK = "pg-note-formats-notebook";
const NOTE = "66666666-6666-4666-8666-666666666666";
const TARGET = "77777777-7777-4777-8777-777777777777";
const ATTACHMENT = "88888888-8888-4888-8888-888888888888";

function tiptapBody(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { blockId: "blk_seed000" },
      content: [{ type: "text", text }],
    }],
  });
}

async function seed(pool: import("pg").Pool): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [OWNER, EDITOR]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0), ($2, $2, 'hash', 0)`,
    [OWNER, EDITOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Formats')`,
    [NOTEBOOK, OWNER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES
       ($1, $2, $3, 'Formats', $4, 'Seed', 'tiptap-json', 1),
       ($5, $2, $3, 'Target', $4, 'Seed', 'tiptap-json', 1)`,
    [NOTE, OWNER, NOTEBOOK, tiptapBody("Seed"), TARGET],
  );
  await pool.query(
    `INSERT INTO note_acl ("noteId", "userId", permission)
     VALUES ($1, $2, 'write')`,
    [NOTE, EDITOR],
  );
  await pool.query(
    `INSERT INTO attachments (
       id, "noteId", "userId", filename, "mimeType", size, path
     ) VALUES ($1, $2, $3, 'format.png', 'image/png', 10, 'test/format.png')`,
    [ATTACHMENT, NOTE, OWNER],
  );
}

test("PostgreSQL note runtime saves Markdown, HTML and metadata with legacy-compatible semantics", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const runtime = createNoteCoreRuntime(new PostgresAdapter(pool), "postgres");

    const markdown = [
      "# Markdown heading",
      "",
      `See [[note:${TARGET}|Target]] and /api/attachments/${ATTACHMENT}`,
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");

    const markdownSaved = await runtime.saveNote(OWNER, NOTE, {
      version: 1,
      content: markdown,
      contentFormat: "markdown",
      contentText: "untrusted client text",
      isPinned: 1,
      isFavorite: 1,
    });
    assert.equal(markdownSaved.note.version, 2);
    assert.equal(markdownSaved.note.contentFormat, "markdown");
    assert.equal(markdownSaved.note.isPinned, 1);
    assert.equal(markdownSaved.note.isFavorite, 1);
    assert.match(String(markdownSaved.note.content), /\^blk_/);
    assert.equal(
      markdownSaved.note.contentText,
      `Markdown heading\n\nSee [[note:${TARGET}|Target]] and /api/attachments/${ATTACHMENT}\n\nconst value = 1;`,
    );

    const firstBlocks = await pool.query(
      `SELECT "blockId", "blockType", "plainText", "startOffset", "endOffset"
         FROM note_blocks_index WHERE "noteId" = $1 ORDER BY "blockOrder"`,
      [NOTE],
    );
    assert.deepEqual(
      firstBlocks.rows.map((row) => row.blockType),
      ["heading", "paragraph", "codeBlock"],
    );
    assert.ok(firstBlocks.rows.every((row) => /^blk_/.test(row.blockId)));
    assert.ok(firstBlocks.rows.every((row) => row.startOffset !== null && row.endOffset !== null));

    const links = await pool.query(
      `SELECT "targetNoteId", "sourceBlockId" FROM note_links WHERE "sourceNoteId" = $1`,
      [NOTE],
    );
    assert.equal(links.rowCount, 1);
    assert.equal(links.rows[0].targetNoteId, TARGET);
    assert.ok(firstBlocks.rows.some((row) => row.blockId === links.rows[0].sourceBlockId));

    const references = await pool.query(
      `SELECT "attachmentId" FROM attachment_references WHERE "noteId" = $1`,
      [NOTE],
    );
    assert.deepEqual(references.rows.map((row) => row.attachmentId), [ATTACHMENT]);

    const normalizedMarkdown = String(markdownSaved.note.content);
    const noOp = await runtime.saveNote(OWNER, NOTE, {
      version: 2,
      content: normalizedMarkdown,
      contentFormat: "markdown",
    });
    assert.equal(noOp.note.version, 2);
    const stableBlocks = await pool.query(
      `SELECT "blockId" FROM note_blocks_index WHERE "noteId" = $1 ORDER BY "blockOrder"`,
      [NOTE],
    );
    assert.deepEqual(
      stableBlocks.rows.map((row) => row.blockId),
      firstBlocks.rows.map((row) => row.blockId),
    );

    const metadata = await runtime.saveNote(OWNER, NOTE, {
      isArchived: true,
    });
    assert.equal(metadata.note.version, 3);
    assert.equal(metadata.note.isArchived, 1);
    assert.equal(metadata.note.isFavorite, 1);

    const favoriteOff = await runtime.saveNote(OWNER, NOTE, {
      isFavorite: false,
    });
    assert.equal(favoriteOff.note.version, 3);
    assert.equal(favoriteOff.note.isFavorite, 0);

    await assert.rejects(
      () => runtime.saveNote(EDITOR, NOTE, { isLocked: true }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );
    const editorFavorite = await runtime.saveNote(EDITOR, NOTE, { isFavorite: true });
    assert.equal(editorFavorite.note.isFavorite, 1);
    assert.equal(editorFavorite.note.version, 3);
    const ownerView = await runtime.getNote(OWNER, NOTE);
    assert.equal(ownerView.isFavorite, 0);

    const locked = await runtime.saveNote(OWNER, NOTE, { isLocked: true });
    assert.equal(locked.note.version, 4);
    assert.equal(locked.note.isLocked, 1);
    await assert.rejects(
      () => runtime.saveNote(OWNER, NOTE, { version: 4, title: "Blocked" }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "NOTE_LOCKED",
    );
    const unlocked = await runtime.saveNote(OWNER, NOTE, { isLocked: false });
    assert.equal(unlocked.note.version, 5);

    const html = "<h1>Hello</h1><script>ignore()</script><style>.x{}</style><p>World</p>";
    const htmlSaved = await runtime.saveNote(OWNER, NOTE, {
      version: 5,
      content: html,
      contentFormat: "html",
      contentText: "client value",
    });
    assert.equal(htmlSaved.note.version, 6);
    assert.equal(htmlSaved.note.content, html);
    assert.equal(htmlSaved.note.contentText, "Hello World");
    assert.equal((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_blocks_index WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count, 0);

    await assert.rejects(
      () => runtime.saveNote(OWNER, NOTE, {
        version: 999,
        title: "Conflict",
        isPinned: 0,
        isFavorite: 1,
      }),
      (error: unknown) => error instanceof NoteCoreRuntimeError
        && error.code === "VERSION_CONFLICT"
        && error.details?.currentVersion === 6,
    );
    const afterConflict = await runtime.getNote(OWNER, NOTE);
    assert.equal(afterConflict.title, "Formats");
    assert.equal(afterConflict.isPinned, 1);
    assert.equal(afterConflict.isFavorite, 0);
    assert.equal(afterConflict.version, 6);
  } finally {
    await closePgPool(pool);
  }
});
