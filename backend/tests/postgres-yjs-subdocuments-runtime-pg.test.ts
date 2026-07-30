import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import {
  createPostgresYjsSubdocumentContentUpdate,
  createPostgresYjsSubdocumentRuntime,
  PostgresYjsSubdocumentRuntimeError,
} from "../src/services/postgres-yjs-subdocuments-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-yjs-subdoc-user";
const NOTEBOOK = "pg-yjs-subdoc-notebook";
const NOTE = "f5555555-5555-4555-8555-555555555555";

function text(value: string) {
  return { type: "text", text: value };
}

function heading(blockId: string, value: string, level = 2) {
  return {
    type: "heading",
    attrs: { level, blockId },
    content: [text(value)],
  };
}

function paragraph(blockId: string, value: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [text(value)],
  };
}

function documentContent(secondParagraph = "Beta", appendNode: unknown = null): string {
  const content: unknown[] = [
    heading("blk_heading_one", "One", 1),
    paragraph("blk_paragraph_one", "Alpha"),
    heading("blk_heading_two", "Two", 2),
    paragraph("blk_paragraph_two", secondParagraph),
  ];
  if (appendNode) content.push(appendNode);
  return JSON.stringify({ type: "doc", content });
}

function sectionContent(secondParagraph = "Beta", appendNode: unknown = null): string {
  const content: unknown[] = [
    heading("blk_heading_two", "Two", 2),
    paragraph("blk_paragraph_two", secondParagraph),
  ];
  if (appendNode) content.push(appendNode);
  return JSON.stringify({ type: "doc", content });
}

test("PostgreSQL Yjs subdocuments prepare idempotently and commit stable-section updates atomically", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled")
     VALUES ($1, $1, 'hash', 0, false)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Yjs subdocuments')`,
    [NOTEBOOK, USER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, 'Subdocuments', $4, 'One Alpha Two Beta', 'tiptap-json', 1)`,
    [NOTE, USER, NOTEBOOK, documentContent()],
  );

  const adapter = new PostgresAdapter(pool);
  const runtime = createPostgresYjsSubdocumentRuntime(adapter);

  try {
    const prepared = await runtime.prepare(NOTE);
    assert.ok(prepared);
    assert.equal(prepared.generation, 1);
    assert.equal(prepared.structureVersion, 1);
    assert.equal(prepared.sections.length, 2);

    const preparedAgain = await runtime.prepare(NOTE);
    assert.deepEqual(preparedAgain, prepared);

    const target = prepared.sections[1]!;
    const state = await runtime.getState(NOTE, target.id);
    assert.ok(state);
    assert.equal(state.guid, target.guid);

    await pool.query(
      `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo")
       VALUES ($1, $2, 0)`,
      [NOTE, Buffer.from([0, 0])],
    );
    await pool.query(
      `INSERT INTO note_yupdates ("noteId", "userId", update_blob, clock)
       VALUES ($1, $2, $3, 1)`,
      [NOTE, USER, Buffer.from([0, 0])],
    );

    const update = createPostgresYjsSubdocumentContentUpdate(
      state.guid,
      state.snapshot,
      sectionContent("Beta updated"),
    );
    const applied = await runtime.applyUpdate(NOTE, target.id, update, USER, prepared.generation);
    assert.equal(applied.version, 2);
    assert.equal(applied.generation, 1);
    assert.equal(applied.structureVersion, 1);
    assert.equal(applied.sectionGuid, target.guid);
    assert.equal(applied.content, documentContent("Beta updated"));
    assert.match(applied.contentText, /Beta updated/u);

    const note = (await pool.query(
      `SELECT content, "contentText", version FROM notes WHERE id = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(note.content, documentContent("Beta updated"));
    assert.match(note.contentText, /Beta updated/u);
    assert.equal(Number(note.version), 2);

    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocument_updates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 1);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_blocks_index WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 4);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_versions WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 1);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_ysnapshots WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 0);

    await assert.rejects(
      runtime.applyUpdate(NOTE, target.id, update, USER, 0),
      (error: unknown) => (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && error.code === "SUBDOCUMENT_GENERATION_CONFLICT"
      ),
    );

    const latestState = await runtime.getState(NOTE, target.id);
    assert.ok(latestState);
    const structureChangingUpdate = createPostgresYjsSubdocumentContentUpdate(
      latestState.guid,
      latestState.snapshot,
      sectionContent("Beta updated", paragraph("blk_paragraph_three", "Gamma")),
    );
    await assert.rejects(
      runtime.applyUpdate(
        NOTE,
        target.id,
        structureChangingUpdate,
        USER,
        prepared.generation,
      ),
      (error: unknown) => (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && error.code === "SUBDOCUMENT_STRUCTURE_CHANGE_PENDING"
      ),
    );

    assert.equal(Number((await pool.query(
      `SELECT version FROM notes WHERE id = $1`,
      [NOTE],
    )).rows[0].version), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocument_updates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 1);
  } finally {
    await closePgPool(pool);
  }
});
