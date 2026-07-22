import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Hono } from "hono";

import { getDb } from "../src/db/schema.ts";
import {
  buildTiptapSplitSource,
  planTiptapNoteSplit,
  serializeTiptapSection,
  validateTiptapSplitPlan,
} from "../src/lib/tiptapNoteSplit.ts";
import { installTiptapNoteSplitRoutes } from "../src/runtime/note-split-tiptap.ts";

function paragraph(blockId: string, text: string, marks?: Array<Record<string, unknown>>) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text, ...(marks ? { marks } : {}) }] : [],
  };
}

function heading(level: 1 | 2, blockId: string, text: string) {
  return {
    type: "heading",
    attrs: { level, blockId },
    content: [{ type: "text", text }],
  };
}

test("plans only root Tiptap headings and preserves marks, nested headings and unknown nodes", () => {
  const document = {
    type: "doc",
    attrs: { source: "test" },
    content: [
      paragraph("blk_preamble1", "Preface"),
      heading(1, "blk_alpha_heading", "Alpha"),
      paragraph("blk_alpha_body", "Bold body", [{ type: "bold" }]),
      {
        type: "blockquote",
        attrs: { custom: true },
        content: [heading(1, "blk_nested_heading", "Nested heading")],
      },
      { type: "customWidget", attrs: { payload: { keep: true } } },
      heading(1, "blk_beta_heading", "Beta"),
      paragraph("blk_beta_body", "Beta body"),
    ],
  };
  const serialized = JSON.stringify(document);
  const plan = planTiptapNoteSplit(serialized, 1);
  assert.equal(validateTiptapSplitPlan(plan), null);
  assert.deepEqual(plan.sections.map((section) => section.title), ["Alpha", "Beta"]);
  assert.equal(plan.preambleNodes.length, 1);
  assert.equal(plan.sections[0].contentNodes[1].type, "blockquote");
  assert.equal(plan.sections[0].contentNodes[2].type, "customWidget");

  const child = JSON.parse(serializeTiptapSection(plan, plan.sections[0]));
  assert.equal(child.attrs.source, "test");
  assert.equal(child.content[0].content[0].marks[0].type, "bold");
  assert.equal(child.content[2].attrs.payload.keep, true);
  assert.notEqual(child.content[0].type, "heading");

  const source = JSON.parse(buildTiptapSplitSource({
    plan,
    preservePreamble: true,
    operationId: "op-test",
    sections: [{ index: 0, id: "11111111-1111-4111-8111-111111111111", title: "Alpha" }],
  }));
  assert.ok(source.content.some((node: any) => node.type === "orderedList"));
  const list = source.content.find((node: any) => node.type === "orderedList");
  assert.equal(list.content[0].content[0].content[0].marks[0].attrs.href, "note:11111111-1111-4111-8111-111111111111");
  assert.ok(source.content.some((node: any) => node.type === "heading" && node.attrs?.blockId === "blk_beta_heading"));
  assert.ok(!source.content.some((node: any) => node.type === "heading" && node.attrs?.blockId === "blk_alpha_heading"));
});

test("transactionally splits selected Tiptap sections, requires block-link confirmation and restores JSON", async () => {
  const db = getDb();
  const userId = crypto.randomUUID();
  const notebookId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const backlinkSourceId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();

  const sourceDocument = {
    type: "doc",
    content: [
      paragraph("blk_preamble2", "Preface"),
      heading(1, "blk_alpha_heading2", "Alpha"),
      paragraph("blk_alpha_body2", "Alpha body"),
      {
        type: "image",
        attrs: { src: `/api/attachments/${attachmentId}`, alt: "shared" },
      },
      { type: "customWidget", attrs: { keep: "alpha" } },
      heading(1, "blk_beta_heading2", "Beta"),
      paragraph("blk_beta_body2", "Beta body"),
      {
        type: "image",
        attrs: { src: `/api/attachments/${attachmentId}`, alt: "shared retained" },
      },
      heading(1, "blk_gamma_heading2", "Gamma"),
      paragraph("blk_gamma_body2", "Gamma body"),
    ],
  };
  const sourceContent = JSON.stringify(sourceDocument);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, `tiptap-split-${userId}`, "test");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, userId, "Tiptap Split Test");
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json')
  `).run(sourceId, userId, notebookId, "Rich Book", sourceContent, "Preface Alpha Beta Gamma");
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json')
  `).run(
    backlinkSourceId,
    userId,
    notebookId,
    "Backlink Source",
    JSON.stringify({ type: "doc", content: [paragraph("blk_link_source", "Link source")] }),
    "Link source",
  );
  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES (?, ?, ?, 'shared-rich.png', 'image/png', 12, 'shared-rich-test.png')
  `).run(attachmentId, sourceId, userId);
  db.prepare(`
    INSERT INTO note_links (
      id, userId, sourceNoteId, targetNoteId, targetBlockId, sourceBlockId,
      linkType, linkText, excerpt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, 'block', 'Alpha body', 'external reference', datetime('now'), datetime('now'))
  `).run(
    crypto.randomUUID(),
    userId,
    backlinkSourceId,
    sourceId,
    "blk_alpha_body2",
    "blk_link_source",
  );

  const app = new Hono();
  installTiptapNoteSplitRoutes(app);
  const requestBody = {
    version: 1,
    headingLevel: 1,
    sectionIndexes: [0, 2],
    preservePreamble: true,
  };
  const warningResponse = await app.request(`/${sourceId}/split`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify(requestBody),
  });
  assert.equal(warningResponse.status, 409);
  const warning = await warningResponse.json() as { code: string; blockLinkCount: number };
  assert.equal(warning.code, "BLOCK_LINKS_REQUIRE_CONFIRMATION");
  assert.equal(warning.blockLinkCount, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM note_split_operations WHERE sourceNoteId = ?").get(sourceId) as { count: number }).count, 0);

  const splitResponse = await app.request(`/${sourceId}/split`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify({ ...requestBody, acknowledgeBlockLinkRisk: true }),
  });
  assert.equal(splitResponse.status, 201);
  const split = await splitResponse.json() as {
    operationId: string;
    sourceNote: { content: string; version: number; contentFormat: string };
    createdNotes: Array<{ id: string; title: string; content: string; contentFormat: string }>;
    retainedSectionCount: number;
    blockLinkWarningCount: number;
  };
  assert.equal(split.createdNotes.length, 2);
  assert.equal(split.retainedSectionCount, 1);
  assert.equal(split.blockLinkWarningCount, 1);
  assert.equal(split.sourceNote.contentFormat, "tiptap-json");
  const sourceAfter = JSON.parse(split.sourceNote.content);
  assert.ok(sourceAfter.content.some((node: any) => node.type === "heading" && node.attrs?.blockId === "blk_beta_heading2"));
  assert.ok(!sourceAfter.content.some((node: any) => node.type === "heading" && node.attrs?.blockId === "blk_alpha_heading2"));
  assert.ok(!sourceAfter.content.some((node: any) => node.type === "heading" && node.attrs?.blockId === "blk_gamma_heading2"));

  const alpha = split.createdNotes.find((note) => note.title === "Alpha");
  assert.ok(alpha);
  const alphaDoc = JSON.parse(alpha!.content);
  assert.equal(alphaDoc.content[0].attrs.blockId, "blk_alpha_body2");
  assert.ok(alphaDoc.content.some((node: any) => node.type === "customWidget" && node.attrs.keep === "alpha"));
  assert.ok(!alphaDoc.content.some((node: any) => node.type === "heading"));

  const sourceAttachment = db.prepare("SELECT id, noteId, path FROM attachments WHERE id = ?")
    .get(attachmentId) as { id: string; noteId: string; path: string };
  assert.equal(sourceAttachment.noteId, sourceId);
  const alphaAttachments = db.prepare("SELECT id, noteId, path FROM attachments WHERE noteId = ?")
    .all(alpha!.id) as Array<{ id: string; noteId: string; path: string }>;
  assert.equal(alphaAttachments.length, 1);
  assert.notEqual(alphaAttachments[0].id, attachmentId);
  assert.equal(alphaAttachments[0].path, "shared-rich-test.png");

  const directoryLinks = db.prepare(`
    SELECT targetNoteId FROM note_links WHERE sourceNoteId = ? AND targetBlockId IS NULL ORDER BY targetNoteId
  `).all(sourceId) as Array<{ targetNoteId: string }>;
  assert.deepEqual(new Set(directoryLinks.map((row) => row.targetNoteId)), new Set(split.createdNotes.map((note) => note.id)));

  const undoResponse = await app.request(`/${sourceId}/split/${split.operationId}/undo`, {
    method: "POST",
    headers: { "X-User-Id": userId },
  });
  assert.equal(undoResponse.status, 200);
  const undone = await undoResponse.json() as {
    sourceNote: { content: string; version: number; contentFormat: string };
    removedNoteIds: string[];
  };
  assert.equal(undone.sourceNote.content, sourceContent);
  assert.equal(undone.sourceNote.contentFormat, "tiptap-json");
  assert.equal(undone.sourceNote.version, 3);
  assert.deepEqual(new Set(undone.removedNoteIds), new Set(split.createdNotes.map((note) => note.id)));
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes WHERE id IN (?, ?)").get(...split.createdNotes.map((note) => note.id)) as { count: number }).count, 0);
  const restoredAttachment = db.prepare("SELECT noteId, path FROM attachments WHERE id = ?")
    .get(attachmentId) as { noteId: string; path: string };
  assert.equal(restoredAttachment.noteId, sourceId);
  assert.equal(restoredAttachment.path, "shared-rich-test.png");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE path = 'shared-rich-test.png'").get() as { count: number }).count, 1);
});
