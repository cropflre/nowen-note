import assert from "node:assert/strict";
import test from "node:test";

import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const skip = !hasPg;
const USER_ID = "note-link-title-user";
const NOTEBOOK_ID = "note-link-title-notebook";
const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const ALIAS_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_BLOCK_ID = "blk_title_source";
const ALIAS_BLOCK_ID = "blk_title_alias";

function tiptapLink(blockId: string, text: string, rel: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId, textAlign: null, lineHeight: null },
        content: [
          {
            type: "text",
            text,
            marks: [
              {
                type: "link",
                attrs: {
                  href: `note:${TARGET_ID}`,
                  target: null,
                  rel,
                  class: null,
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

async function cleanAll(pool: import("pg").Pool) {
  await pool.query('DELETE FROM note_links WHERE "sourceNoteId" IN ($1, $2) OR "targetNoteId" = $3', [
    SOURCE_ID,
    ALIAS_ID,
    TARGET_ID,
  ]);
  await pool.query('DELETE FROM note_blocks_index WHERE "noteId" IN ($1, $2)', [SOURCE_ID, ALIAS_ID]);
  await pool.query('DELETE FROM notes WHERE id IN ($1, $2, $3)', [SOURCE_ID, ALIAS_ID, TARGET_ID]);
  await pool.query('DELETE FROM notebooks WHERE id = $1', [NOTEBOOK_ID]);
  await pool.query('DELETE FROM users WHERE id = $1', [USER_ID]);
}

async function seed(pool: import("pg").Pool) {
  await pool.query(
    'INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)',
    [USER_ID, USER_ID, "hash"],
  );
  await pool.query(
    'INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, $3)',
    [NOTEBOOK_ID, USER_ID, "Title links"],
  );
  await pool.query(
    'INSERT INTO notes (id, "userId", "notebookId", title, content, "contentText", "contentFormat") VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [TARGET_ID, USER_ID, NOTEBOOK_ID, "New Title", "{}", "", "tiptap-json"],
  );
  await pool.query(
    'INSERT INTO notes (id, "userId", "notebookId", title, content, "contentText", "contentFormat") VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      SOURCE_ID,
      USER_ID,
      NOTEBOOK_ID,
      "Source",
      tiptapLink(SOURCE_BLOCK_ID, "Old Title", "noopener nowen-title-auto"),
      "Old Title",
      "tiptap-json",
    ],
  );
  await pool.query(
    'INSERT INTO notes (id, "userId", "notebookId", title, content, "contentText", "contentFormat") VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      ALIAS_ID,
      USER_ID,
      NOTEBOOK_ID,
      "Alias source",
      tiptapLink(ALIAS_BLOCK_ID, "Pinned alias", "noopener nowen-title-alias"),
      "Pinned alias",
      "tiptap-json",
    ],
  );
  await pool.query(
    `INSERT INTO note_links (
       id, "userId", "sourceNoteId", "targetNoteId", "sourceBlockId", "linkType"
     ) VALUES ($1, $2, $3, $4, $5, 'note')`,
    ["title-link-auto", USER_ID, SOURCE_ID, TARGET_ID, SOURCE_BLOCK_ID],
  );
  await pool.query(
    `INSERT INTO note_links (
       id, "userId", "sourceNoteId", "targetNoteId", "sourceBlockId", "linkType"
     ) VALUES ($1, $2, $3, $4, $5, 'note')`,
    ["title-link-alias", USER_ID, ALIAS_ID, TARGET_ID, ALIAS_BLOCK_ID],
  );
}

test("PG: automatic note-link titles update content, Block index and backlinks atomically", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seed(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createNoteLinkTitlesRuntime } = await import("../src/services/note-link-titles-runtime");
  const runtime = createNoteLinkTitlesRuntime(new PostgresAdapter(pool), "postgres");

  const updated = await runtime.syncAutomaticNoteLinkTitlesAsync(
    TARGET_ID,
    "Old Title",
    "New Title",
  );
  assert.deepEqual(updated, [SOURCE_ID]);

  const source = await pool.query(
    'SELECT content, "contentText", version FROM notes WHERE id = $1',
    [SOURCE_ID],
  );
  assert.equal(source.rows[0].contentText, "New Title");
  assert.equal(source.rows[0].version, 2);
  const doc = JSON.parse(source.rows[0].content);
  assert.equal(doc.content[0].content[0].text, "New Title");
  assert.match(doc.content[0].content[0].marks[0].attrs.rel, /\bnowen-title-auto\b/);

  const block = await pool.query(
    'SELECT "blockId", "plainText", path FROM note_blocks_index WHERE "noteId" = $1',
    [SOURCE_ID],
  );
  assert.deepEqual(block.rows, [{ blockId: SOURCE_BLOCK_ID, plainText: "New Title", path: "0" }]);

  const link = await pool.query(
    'SELECT "targetNoteId", "sourceBlockId" FROM note_links WHERE "sourceNoteId" = $1',
    [SOURCE_ID],
  );
  assert.deepEqual(link.rows, [{ targetNoteId: TARGET_ID, sourceBlockId: SOURCE_BLOCK_ID }]);

  const alias = await pool.query(
    'SELECT content, "contentText", version FROM notes WHERE id = $1',
    [ALIAS_ID],
  );
  assert.equal(alias.rows[0].contentText, "Pinned alias");
  assert.equal(alias.rows[0].version, 1);
  assert.equal(JSON.parse(alias.rows[0].content).content[0].content[0].text, "Pinned alias");

  await cleanAll(pool);
  await closePgPool(pool);
});
