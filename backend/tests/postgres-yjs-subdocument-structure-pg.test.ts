import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import {
  createPostgresYjsSubdocumentRuntime,
  PostgresYjsSubdocumentRuntimeError,
} from "../src/services/postgres-yjs-subdocuments-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-yjs-structure-user";
const NOTEBOOK = "pg-yjs-structure-notebook";
const NOTE = "f8888888-8888-4888-8888-888888888888";

function text(value: string) {
  return { type: "text", text: value };
}

function heading(blockId: string, value: string, level = 2) {
  return { type: "heading", attrs: { level, blockId }, content: [text(value)] };
}

function paragraph(blockId: string, value: string) {
  return { type: "paragraph", attrs: { blockId }, content: [text(value)] };
}

function document(nodes: unknown[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

const baseContent = document([
  heading("blk_structure_one", "One", 1),
  paragraph("blk_structure_alpha", "Alpha"),
  heading("blk_structure_two", "Two", 2),
  paragraph("blk_structure_beta", "Beta"),
]);

const expandedContent = document([
  heading("blk_structure_one", "One", 1),
  paragraph("blk_structure_alpha", "Alpha"),
  heading("blk_structure_two", "Two", 2),
  paragraph("blk_structure_beta", "Beta"),
  heading("blk_structure_three", "Three", 2),
  paragraph("blk_structure_gamma", "Gamma"),
]);

const movedAndMergedContent = document([
  heading("blk_structure_three", "Three", 1),
  paragraph("blk_structure_gamma", "Gamma"),
  heading("blk_structure_one", "One", 2),
  paragraph("blk_structure_alpha", "Alpha"),
]);

test("PostgreSQL Yjs subdocument structure changes rebuild atomically and retry idempotently", { skip: !hasPg }, async () => {
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
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Yjs structure')`,
    [NOTEBOOK, USER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, 'Structure', $4, 'One Alpha Two Beta', 'tiptap-json', 1)`,
    [NOTE, USER, NOTEBOOK, baseContent],
  );

  const runtime = createPostgresYjsSubdocumentRuntime(new PostgresAdapter(pool));
  try {
    const initial = await runtime.prepare(NOTE);
    assert.ok(initial);
    assert.equal(initial.generation, 1);
    assert.equal(initial.structureVersion, 1);
    assert.equal(initial.sections.length, 2);

    const expanded = await runtime.applyStructureChange(
      NOTE,
      expandedContent,
      USER,
      initial.generation,
      "structure-add-third",
    );
    assert.equal(expanded.replayed, false);
    assert.equal(expanded.version, 2);
    assert.equal(expanded.generation, 2);
    assert.equal(expanded.structureVersion, 2);
    assert.equal(expanded.manifest.sections.length, 3);
    assert.deepEqual(
      expanded.manifest.sections.map((section) => section.id),
      [
        "section-blk_structure_one",
        "section-blk_structure_two",
        "section-blk_structure_three",
      ],
    );

    const firstManifest = (await pool.query(
      `SELECT generation, "structureVersion", "sectionCount", octet_length("rootSnapshot") AS bytes
         FROM note_y_subdocument_manifests WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(Number(firstManifest.generation), 2);
    assert.equal(Number(firstManifest.structureVersion), 2);
    assert.equal(Number(firstManifest.sectionCount), 3);
    assert.ok(Number(firstManifest.bytes) > 0);

    const replayed = await runtime.applyStructureChange(
      NOTE,
      expandedContent,
      USER,
      initial.generation,
      "structure-add-third",
    );
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.version, 2);
    assert.equal(replayed.generation, 2);
    assert.equal(replayed.manifest.sections.length, 3);

    await assert.rejects(
      runtime.applyStructureChange(
        NOTE,
        movedAndMergedContent,
        USER,
        2,
        "structure-add-third",
      ),
      (error: unknown) => (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && error.code === "SUBDOCUMENT_OPERATION_REUSED"
      ),
    );

    await assert.rejects(
      runtime.applyStructureChange(
        NOTE,
        movedAndMergedContent,
        USER,
        1,
        "structure-stale-generation",
      ),
      (error: unknown) => (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && error.code === "SUBDOCUMENT_GENERATION_CONFLICT"
      ),
    );

    const moved = await runtime.applyStructureChange(
      NOTE,
      movedAndMergedContent,
      USER,
      expanded.generation,
      "structure-move-delete-merge",
    );
    assert.equal(moved.replayed, false);
    assert.equal(moved.version, 3);
    assert.equal(moved.generation, 3);
    assert.equal(moved.structureVersion, 3);
    assert.deepEqual(
      moved.manifest.sections.map((section) => section.id),
      ["section-blk_structure_three", "section-blk_structure_one"],
    );

    const persisted = (await pool.query(
      `SELECT content, "contentText", version FROM notes WHERE id = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(persisted.content, movedAndMergedContent);
    assert.match(persisted.contentText, /Three/u);
    assert.equal(Number(persisted.version), 3);

    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocuments WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocument_updates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocument_structure_operations WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_versions WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_blocks_index WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 4);
  } finally {
    await closePgPool(pool);
  }
});
