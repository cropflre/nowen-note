import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-blocks-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let db: Database.Database;
let closeDb: () => void;
let blocksApp: Hono;
let syncNoteBlocks: typeof import("../src/lib/noteBlocks").syncNoteBlocks;
let syncNoteLinks: typeof import("../src/lib/noteLinks").syncNoteLinks;
let syncAutomaticNoteLinkTitles: typeof import("../src/lib/noteLinkTitles").syncAutomaticNoteLinkTitles;

const owner = "knowledge-owner";
const viewer = "knowledge-viewer";
const notebookId = "knowledge-notebook";
const sourceId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

function tiptap(blockId: string, text: string, href?: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { blockId },
      content: [{
        type: "text",
        text,
        ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}),
      }],
    }],
  });
}

test.before(async () => {
  const [schema, blocks, blockRoute, noteLinks, noteLinkTitles] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/noteBlocks"),
    import("../src/routes/blocks"),
    import("../src/lib/noteLinks"),
    import("../src/lib/noteLinkTitles"),
  ]);
  db = schema.getDb();
  closeDb = schema.closeDb;
  syncNoteBlocks = blocks.syncNoteBlocks;
  syncNoteLinks = noteLinks.syncNoteLinks;
  syncAutomaticNoteLinkTitles = noteLinkTitles.syncAutomaticNoteLinkTitles;
  blocksApp = new Hono();
  blocksApp.route("/blocks", blockRoute.default);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(owner, owner, "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(viewer, viewer, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(notebookId, owner, "Knowledge");
  db.prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status, invitedBy) VALUES (?, ?, ?, ?, 'active', ?)")
    .run("knowledge-notebook-member", notebookId, viewer, "viewer", owner);
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(targetId, owner, notebookId, "Target", tiptap("blk_target", "Target paragraph"), "Target paragraph", "tiptap-json");
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(sourceId, owner, notebookId, "Source", tiptap("blk_source", "See target", `note:${targetId}#blk:blk_target`), "See target", "tiptap-json");
  db.prepare("INSERT INTO note_acl (noteId, userId, permission) VALUES (?, ?, ?)").run(targetId, viewer, "read");
  db.prepare("INSERT INTO note_acl (noteId, userId, permission) VALUES (?, ?, ?)").run(sourceId, viewer, "read");
  syncNoteBlocks(db, targetId, tiptap("blk_target", "Target paragraph"), "tiptap-json");
  syncNoteBlocks(db, sourceId, tiptap("blk_source", "See target", `note:${targetId}#blk:blk_target`), "tiptap-json");
  syncNoteLinks(db, owner, sourceId, tiptap("blk_source", "See target", `note:${targetId}#blk:blk_target`));
});

test.after(async () => {
  if (closeDb) closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("universal block indexing adds stable IDs to supported Tiptap nodes", () => {
  const content = JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
      { type: "paragraph", content: [{ type: "text", text: "Paragraph" }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quote" }] }] },
    ],
  });
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("33333333-3333-4333-8333-333333333333", owner, notebookId, "Blocks", content, "", "tiptap-json");
  const first = syncNoteBlocks(db, "33333333-3333-4333-8333-333333333333", content, "tiptap-json");
  assert.ok(first.blocks.some((block) => block.blockType === "heading"));
  assert.ok(first.blocks.some((block) => block.blockType === "paragraph"));
  assert.ok(first.blocks.some((block) => block.blockType === "blockquote"));
  assert.ok(first.blocks.every((block) => block.blockId.startsWith("blk_")));
  const second = syncNoteBlocks(db, "33333333-3333-4333-8333-333333333333", first.content, "tiptap-json");
  assert.deepEqual(second.blocks.map((block) => block.blockId), first.blocks.map((block) => block.blockId));
});

test("Markdown blocks receive persisted block markers", () => {
  const noteId = "44444444-4444-4444-8444-444444444444";
  const content = "# Markdown heading\n\nA paragraph\n\n- [ ] Task\n";
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(noteId, owner, notebookId, "Markdown", content, "", "markdown");
  const first = syncNoteBlocks(db, noteId, content, "markdown");
  assert.match(first.content, /\^blk_/);
  const second = syncNoteBlocks(db, noteId, first.content, "markdown");
  assert.equal(second.changed, false);
  assert.deepEqual(second.blocks.map((block) => block.blockId), first.blocks.map((block) => block.blockId));
});

test("block backlinks are visible to another user with note ACL", async () => {
  const response = await blocksApp.request(
    `/blocks/${targetId}/blk_target/backlinks`,
    { headers: { "X-User-Id": viewer } },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.backlinks.length, 1);
  assert.equal(payload.backlinks[0].sourceBlockId, "blk_source");
});

test("block update enforces note version and operation idempotency", async () => {
  const note = db.prepare("SELECT version FROM notes WHERE id = ?").get(targetId) as { version: number };
  const body = {
    expectedNoteVersion: note.version,
    operationId: "knowledge-op-update-1",
    text: "Updated target paragraph",
  };
  const first = await blocksApp.request(`/blocks/${targetId}/blk_target`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify(body),
  });
  assert.equal(first.status, 200);
  const firstPayload = await first.json() as any;
  assert.equal(firstPayload.version, note.version + 1);

  const replay = await blocksApp.request(`/blocks/${targetId}/blk_target`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify(body),
  });
  assert.equal(replay.status, 200);
  const replayPayload = await replay.json() as any;
  assert.equal(replayPayload.idempotentReplay, true);
});

test("Markdown backlinks retain the source block ID", () => {
  const noteId = "55555555-5555-4555-8555-555555555555";
  const content = `Paragraph [[note:${targetId}#blk:blk_target|Target paragraph]]\n`;
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(noteId, owner, notebookId, "Markdown link", content, "", "markdown");
  const synced = syncNoteBlocks(db, noteId, content, "markdown");
  syncNoteLinks(db, owner, noteId, synced.content);
  const row = db.prepare(`
    SELECT sourceBlockId, targetBlockId FROM note_links
    WHERE sourceNoteId = ? AND targetNoteId = ?
  `).get(noteId, targetId) as { sourceBlockId: string | null; targetBlockId: string | null } | undefined;
  assert.ok(row);
  assert.equal(row?.sourceBlockId, synced.blocks[0].blockId);
  assert.equal(row?.targetBlockId, "blk_target");
});

test("HTML notes are never rewritten as Markdown blocks", () => {
  const noteId = "66666666-6666-4666-8666-666666666666";
  const content = "<!doctype html><html><body><p>Clipped article</p></body></html>";
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(noteId, owner, notebookId, "HTML clip", content, "Clipped article", "html");
  const synced = syncNoteBlocks(db, noteId, content, "html");
  assert.equal(synced.changed, false);
  assert.equal(synced.content, content);
  assert.equal(synced.blocks.length, 0);
  const stored = db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId) as { content: string };
  assert.equal(stored.content, content);
});



test("automatic note titles follow rename while aliases remain fixed", () => {
  const autoId = "77777777-7777-4777-8777-777777777777";
  const aliasId = "88888888-8888-4888-8888-888888888888";
  const autoContent = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { blockId: "blk_auto_title" },
      content: [{
        type: "text",
        text: "Target",
        marks: [{ type: "link", attrs: { href: `note:${targetId}`, rel: "noopener nowen-title-auto" } }],
      }],
    }],
  });
  const aliasContent = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { blockId: "blk_alias_title" },
      content: [{
        type: "text",
        text: "Fixed alias",
        marks: [{ type: "link", attrs: { href: `note:${targetId}`, rel: "noopener nowen-title-alias" } }],
      }],
    }],
  });
  const insert = db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json')`);
  insert.run(autoId, owner, notebookId, "Auto source", autoContent, "Target");
  insert.run(aliasId, owner, notebookId, "Alias source", aliasContent, "Fixed alias");
  syncNoteBlocks(db, autoId, autoContent, "tiptap-json");
  syncNoteBlocks(db, aliasId, aliasContent, "tiptap-json");
  syncNoteLinks(db, owner, autoId, autoContent);
  syncNoteLinks(db, owner, aliasId, aliasContent);

  const updated = syncAutomaticNoteLinkTitles(db, targetId, "Target", "Renamed target");
  assert.ok(updated.includes(autoId));
  assert.ok(!updated.includes(aliasId));
  const autoStored = db.prepare("SELECT content FROM notes WHERE id = ?").get(autoId) as { content: string };
  const aliasStored = db.prepare("SELECT content FROM notes WHERE id = ?").get(aliasId) as { content: string };
  assert.equal(JSON.parse(autoStored.content).content[0].content[0].text, "Renamed target");
  assert.equal(JSON.parse(aliasStored.content).content[0].content[0].text, "Fixed alias");
});

test("link resolver returns ACL-safe preview metadata", async () => {
  const response = await blocksApp.request(
    `/blocks/resolve?link=${encodeURIComponent(`note:${targetId}#blk:blk_target`)}`,
    { headers: { "X-User-Id": viewer } },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.note.id, targetId);
  assert.equal(payload.note.notebookName, "Knowledge");
  assert.equal(typeof payload.note.updatedAt, "string");
  assert.equal(payload.block.blockId, "blk_target");
});
