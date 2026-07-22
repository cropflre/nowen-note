import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Hono } from "hono";

import { getDb } from "../src/db/schema.ts";
import {
  buildMarkdownPartialSplitSource,
  buildMarkdownSplitDirectory,
  planMarkdownNoteSplit,
  validateMarkdownSplitPlan,
} from "../src/lib/noteSplit.ts";
import { installNoteSplitRoutes } from "../src/runtime/note-split.ts";
import { installPartialNoteSplitRoutes } from "../src/runtime/note-split-selection.ts";

function stripRuntimeBlockIds(markdown: string): string {
  return markdown
    .replace(/[ \t]+\^blk_[A-Za-z0-9_-]{6,}[ \t]*$/gm, "")
    .replace(/^\^blk_[A-Za-z0-9_-]{6,}[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function installSplitRoutes(app: Hono): void {
  installPartialNoteSplitRoutes(app);
  installNoteSplitRoutes(app);
}

test("splits exact H1 boundaries and preserves the preamble", () => {
  const source = [
    "Intro paragraph.",
    "",
    "# Alpha",
    "Alpha body",
    "## Nested",
    "nested body",
    "# Beta",
    "Beta body",
  ].join("\n");
  const plan = planMarkdownNoteSplit(source, 1);
  assert.equal(plan.preamble, "Intro paragraph.");
  assert.deepEqual(plan.sections.map((section) => section.title), ["Alpha", "Beta"]);
  assert.match(plan.sections[0].content, /## Nested/);
  assert.equal(validateMarkdownSplitPlan(plan), null);
});

test("ignores heading-shaped lines inside fenced code blocks", () => {
  const source = [
    "# One",
    "```md",
    "# not a section",
    "```",
    "# Two",
  ].join("\n");
  const plan = planMarkdownNoteSplit(source, 1);
  assert.deepEqual(plan.sections.map((section) => section.title), ["One", "Two"]);
  assert.match(plan.sections[0].content, /# not a section/);
});

test("uses exact H2 boundaries instead of flattening H1 headings", () => {
  const source = [
    "# Book",
    "intro",
    "## Chapter A",
    "A",
    "## Chapter B",
    "B",
  ].join("\n");
  const plan = planMarkdownNoteSplit(source, 2);
  assert.equal(plan.preamble, "# Book\nintro");
  assert.deepEqual(plan.sections.map((section) => section.title), ["Chapter A", "Chapter B"]);
});

test("builds a directory with stable note ids and escaped aliases", () => {
  const directory = buildMarkdownSplitDirectory({
    sourceTitle: "Book",
    operationId: "op-1",
    headingLevel: 1,
    preamble: "Intro",
    preservePreamble: true,
    sections: [
      { id: "note-a", title: "Alpha | A" },
      { id: "note-b", title: "Beta ] B" },
    ],
  });
  assert.match(directory, /Intro/);
  assert.match(directory, /nowen-note-split:op-1/);
  assert.match(directory, /\[\[note:note-a\|Alpha ｜ A\]\]/);
  assert.match(directory, /\[\[note:note-b\|Beta ］ B\]\]/);
});

test("partial source keeps exact unselected ranges and uses a lower directory heading", () => {
  const source = [
    "# Book",
    "intro",
    "## Alpha",
    "A",
    "## Beta",
    "B",
    "## Gamma",
    "G",
  ].join("\n");
  const plan = planMarkdownNoteSplit(source, 2);
  const partial = buildMarkdownPartialSplitSource({
    sourceMarkdown: source,
    sourceTitle: "Book",
    operationId: "op-partial",
    plan,
    preservePreamble: true,
    sections: [{ index: 1, id: "note-beta", title: "Beta" }],
  });
  assert.match(partial, /### 目录/);
  assert.doesNotMatch(partial, /^## 目录$/m);
  assert.match(partial, /\[\[note:note-beta\|Beta\]\]/);
  assert.match(partial, /## Alpha\nA/);
  assert.match(partial, /## Gamma\nG/);
  assert.doesNotMatch(partial, /^## Beta$/m);
});

test("requires at least two sections", () => {
  const plan = planMarkdownNoteSplit("# Only\nbody", 1);
  assert.equal(validateMarkdownSplitPlan(plan), "至少需要两个同级标题才能拆分");
});

test("transactionally splits, shares attachment bytes, inherits tags and restores on undo", async () => {
  const db = getDb();
  const userId = crypto.randomUUID();
  const notebookId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const tagId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const source = [
    "Preface",
    "",
    "# Alpha",
    `![shared](/api/attachments/${attachmentId})`,
    "Alpha body",
    "# Beta",
    `![shared again](/api/attachments/${attachmentId})`,
    "Beta body",
  ].join("\n");

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, `split-${userId}`, "test");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, userId, "Split Test");
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, 'markdown')
  `).run(noteId, userId, notebookId, "Book", source, source);
  db.prepare("INSERT INTO tags (id, userId, name) VALUES (?, ?, ?)")
    .run(tagId, userId, `tag-${tagId}`);
  db.prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)").run(noteId, tagId);
  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES (?, ?, ?, 'shared.png', 'image/png', 12, 'shared-test.png')
  `).run(attachmentId, noteId, userId);

  const app = new Hono();
  installSplitRoutes(app);
  // No sectionIndexes: this verifies the selected-section route passes legacy clients through.
  const splitResponse = await app.request(`/${noteId}/split`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
    },
    body: JSON.stringify({ version: 1, headingLevel: 1, preservePreamble: true }),
  });
  assert.equal(splitResponse.status, 201);
  const splitResult = await splitResponse.json() as {
    operationId: string;
    sourceNote: { content: string; version: number };
    createdNotes: Array<{ id: string; title: string; content: string }>;
  };
  assert.equal(splitResult.createdNotes.length, 2);
  assert.equal(splitResult.sourceNote.version, 2);
  assert.match(splitResult.sourceNote.content, /## 目录/);
  assert.match(splitResult.sourceNote.content, /Preface/);

  const childIds = splitResult.createdNotes.map((note) => note.id);
  const childTags = db.prepare(
    `SELECT noteId, tagId FROM note_tags WHERE noteId IN (?, ?) ORDER BY noteId`,
  ).all(...childIds) as Array<{ noteId: string; tagId: string }>;
  assert.equal(childTags.length, 2);
  assert.ok(childTags.every((row) => row.tagId === tagId));

  const directoryLinks = db.prepare(`
    SELECT targetNoteId FROM note_links
    WHERE sourceNoteId = ? ORDER BY targetNoteId
  `).all(noteId) as Array<{ targetNoteId: string }>;
  assert.deepEqual(
    directoryLinks.map((row) => row.targetNoteId).sort(),
    [...childIds].sort(),
  );

  const attachmentRows = db.prepare(`
    SELECT id, noteId, path FROM attachments
    WHERE noteId IN (?, ?)
    ORDER BY id
  `).all(...childIds) as Array<{ id: string; noteId: string; path: string }>;
  assert.equal(attachmentRows.length, 2);
  assert.ok(attachmentRows.some((row) => row.id === attachmentId));
  assert.ok(attachmentRows.every((row) => row.path === "shared-test.png"));
  assert.notEqual(splitResult.createdNotes[0].content, splitResult.createdNotes[1].content);

  const undoResponse = await app.request(
    `/${noteId}/split/${splitResult.operationId}/undo`,
    { method: "POST", headers: { "X-User-Id": userId } },
  );
  assert.equal(undoResponse.status, 200);
  const undoResult = await undoResponse.json() as {
    sourceNote: { content: string; version: number };
    removedNoteIds: string[];
  };
  assert.equal(stripRuntimeBlockIds(undoResult.sourceNote.content), source);
  assert.equal(undoResult.sourceNote.version, 3);
  assert.deepEqual(new Set(undoResult.removedNoteIds), new Set(childIds));

  const remainingChildren = db.prepare(
    "SELECT COUNT(*) AS count FROM notes WHERE id IN (?, ?)",
  ).get(...childIds) as { count: number };
  assert.equal(remainingChildren.count, 0);
  const restoredAttachment = db.prepare(
    "SELECT id, noteId, path FROM attachments WHERE id = ?",
  ).get(attachmentId) as { id: string; noteId: string; path: string };
  assert.equal(restoredAttachment.noteId, noteId);
  assert.equal(restoredAttachment.path, "shared-test.png");
  const attachmentCount = db.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE path = 'shared-test.png'",
  ).get() as { count: number };
  assert.equal(attachmentCount.count, 1);
});

test("selected chapter split retains unselected content and keeps shared original attachment on source", async () => {
  const db = getDb();
  const userId = crypto.randomUUID();
  const notebookId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const sharedPath = `partial-${attachmentId}.png`;
  const source = [
    "Preface",
    "",
    "# Alpha",
    `![shared](/api/attachments/${attachmentId})`,
    "Alpha body",
    "# Beta",
    `![still needed](/api/attachments/${attachmentId})`,
    "Beta body",
    "# Gamma",
    "Gamma body",
  ].join("\n");

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, `partial-${userId}`, "test");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, userId, "Partial Split Test");
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, 'markdown')
  `).run(noteId, userId, notebookId, "Partial Book", source, source);
  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES (?, ?, ?, 'partial.png', 'image/png', 20, ?)
  `).run(attachmentId, noteId, userId, sharedPath);

  const app = new Hono();
  installSplitRoutes(app);
  const splitResponse = await app.request(`/${noteId}/split`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
    },
    body: JSON.stringify({
      version: 1,
      headingLevel: 1,
      sectionIndexes: [0],
      preservePreamble: true,
    }),
  });
  assert.equal(splitResponse.status, 201);
  const splitResult = await splitResponse.json() as {
    operationId: string;
    sourceNote: { content: string; version: number };
    createdNotes: Array<{ id: string; title: string; content: string }>;
    selectedSectionIndexes: number[];
    retainedSectionCount: number;
    totalSectionCount: number;
  };
  assert.deepEqual(splitResult.selectedSectionIndexes, [0]);
  assert.equal(splitResult.createdNotes.length, 1);
  assert.equal(splitResult.createdNotes[0].title, "Alpha");
  assert.equal(splitResult.retainedSectionCount, 2);
  assert.equal(splitResult.totalSectionCount, 3);
  assert.match(splitResult.sourceNote.content, /# Beta/);
  assert.match(splitResult.sourceNote.content, /# Gamma/);
  assert.doesNotMatch(splitResult.sourceNote.content, /^# Alpha(?:\s|$)/m);

  const childId = splitResult.createdNotes[0].id;
  const directoryLink = db.prepare(`
    SELECT targetNoteId FROM note_links
    WHERE sourceNoteId = ? AND targetNoteId = ?
  `).get(noteId, childId) as { targetNoteId: string } | undefined;
  assert.equal(directoryLink?.targetNoteId, childId);

  const attachmentRows = db.prepare(`
    SELECT id, noteId, path, uploadSource FROM attachments
    WHERE path = ? ORDER BY id
  `).all(sharedPath) as Array<{
    id: string;
    noteId: string;
    path: string;
    uploadSource: string | null;
  }>;
  assert.equal(attachmentRows.length, 2);
  const original = attachmentRows.find((row) => row.id === attachmentId);
  const copy = attachmentRows.find((row) => row.id !== attachmentId);
  assert.equal(original?.noteId, noteId);
  assert.equal(copy?.noteId, childId);
  assert.equal(copy?.uploadSource, "note-split");
  assert.match(splitResult.sourceNote.content, new RegExp(attachmentId));
  assert.ok(copy);
  assert.match(splitResult.createdNotes[0].content, new RegExp(copy.id));
  assert.doesNotMatch(splitResult.createdNotes[0].content, new RegExp(attachmentId));

  const undoResponse = await app.request(
    `/${noteId}/split/${splitResult.operationId}/undo`,
    { method: "POST", headers: { "X-User-Id": userId } },
  );
  assert.equal(undoResponse.status, 200);
  const undoResult = await undoResponse.json() as {
    sourceNote: { content: string; version: number };
    removedNoteIds: string[];
  };
  assert.equal(stripRuntimeBlockIds(undoResult.sourceNote.content), source);
  assert.deepEqual(undoResult.removedNoteIds, [childId]);
  const remainingAttachmentRows = db.prepare(
    "SELECT id, noteId, path FROM attachments WHERE path = ?",
  ).all(sharedPath) as Array<{ id: string; noteId: string; path: string }>;
  assert.deepEqual(remainingAttachmentRows, [{ id: attachmentId, noteId, path: sharedPath }]);
});
