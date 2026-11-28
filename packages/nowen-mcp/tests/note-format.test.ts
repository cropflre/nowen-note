import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateNotePayload,
  buildReadNoteResult,
  buildUpdateNotePayload,
  buildUpdateNotePayloadWithCurrentVersion,
} from "../src/note-format.js";

const markdown = [
  "# 标题",
  "",
  "- 第一条",
  "- 第二条",
  "",
  "| A | B |",
  "| - | - |",
  "| 1 | 2 |",
].join("\n");

test("MCP create note defaults to markdown source content", () => {
  const payload = buildCreateNotePayload({
    notebookId: "nb-1",
    title: "Markdown 笔记",
    content: markdown,
  });

  assert.equal(payload.contentFormat, "markdown");
  assert.equal(payload.content, markdown);
  assert.equal(payload.contentText, markdown);
  assert.ok(!String(payload.content).includes('"type":"doc"'));
});

test("MCP update note carries current version and synchronizes Markdown into Yjs", () => {
  const payload = buildUpdateNotePayload({
    currentNote: { version: 12 },
    title: "新标题",
    content: markdown,
  });

  assert.equal(payload.version, 12);
  assert.equal(payload.title, "新标题");
  assert.equal(payload.contentFormat, "markdown");
  assert.equal(payload.content, markdown);
  assert.equal(payload.contentText, markdown);
  assert.equal(payload.syncToYjs, true);
});

test("MCP update does not route non-Markdown content through Markdown Yjs", () => {
  const payload = buildUpdateNotePayload({
    currentNote: { version: 8 },
    content: '{"type":"doc","content":[]}',
    contentFormat: "tiptap-json",
  });

  assert.equal(payload.contentFormat, "tiptap-json");
  assert.equal("syncToYjs" in payload, false);
});

test("MCP title-only update does not mutate an active Yjs document", () => {
  const payload = buildUpdateNotePayload({
    currentNote: { version: 9 },
    title: "仅修改标题",
  });

  assert.equal(payload.version, 9);
  assert.equal(payload.title, "仅修改标题");
  assert.equal("syncToYjs" in payload, false);
});

test("MCP update note reads current note version before building payload", async () => {
  const calls: string[] = [];
  const payload = await buildUpdateNotePayloadWithCurrentVersion({
    getNote: async (noteId: string) => {
      calls.push(noteId);
      return { version: 21 };
    },
  }, {
    noteId: "note-1",
    content: markdown,
  });

  assert.deepEqual(calls, ["note-1"]);
  assert.equal(payload.version, 21);
  assert.equal(payload.contentFormat, "markdown");
  assert.equal(payload.syncToYjs, true);
});

test("MCP read note result includes contentFormat", () => {
  const result = buildReadNoteResult({
    id: "note-1",
    title: "Markdown 笔记",
    notebookId: "nb-1",
    content: markdown,
    contentText: markdown,
    contentFormat: "markdown",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    version: 3,
    tags: [{ id: "tag-1", name: "标签" }],
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  });

  assert.equal(result.contentFormat, "markdown");
  assert.equal(result.contentText, markdown);
  assert.equal(result.noteType, "normal");
});

test("MCP create note supports word, plaintext and ppt types with proper default formats", () => {
  const wordPayload = buildCreateNotePayload({
    notebookId: "nb-1",
    title: "需求 Word 文档",
    noteType: "word",
  });
  assert.equal(wordPayload.noteType, "word");
  assert.equal(wordPayload.contentFormat, "tiptap-json");

  const txtPayload = buildCreateNotePayload({
    notebookId: "nb-1",
    title: "纯文本草稿",
    content: "hello\nworld",
    contentFormat: "plaintext",
  });
  assert.equal(txtPayload.contentFormat, "plaintext");
  assert.equal(txtPayload.noteType, undefined);

  const pptPayload = buildCreateNotePayload({
    notebookId: "nb-1",
    title: "季度汇报",
    noteType: "ppt",
  });
  assert.equal(pptPayload.noteType, "ppt");
  assert.equal(pptPayload.contentFormat, "ppt-json");
  const deck = JSON.parse(String(pptPayload.content));
  assert.equal(deck.title, "季度汇报");
  assert.ok(Array.isArray(deck.slides) && deck.slides.length === 1);
});

test("MCP update note preserves existing non-markdown contentFormat when omitted", () => {
  for (const format of ["tiptap-json", "html", "plaintext", "ppt-json"] as const) {
    const payload = buildUpdateNotePayload({
      currentNote: { version: 4, contentFormat: format, noteType: format === "ppt-json" ? "ppt" : "normal" },
      content: "updated body",
    });
    assert.equal(payload.contentFormat, format);
    assert.equal("syncToYjs" in payload, false);
  }
});

test("MCP update note refuses plaintext mutation of encrypted notes and excel workbook bodies", () => {
  assert.throws(
    () => buildUpdateNotePayload({
      currentNote: { version: 2, contentFormat: "encrypted-note-v1", noteType: "normal" },
      content: "plaintext leak",
    }),
    /加密笔记/,
  );

  assert.throws(
    () => buildUpdateNotePayload({
      currentNote: { version: 3, contentFormat: "tiptap-json", noteType: "excel" },
      content: "overwrite excel",
    }),
    /nowen_update_excel/,
  );

  // Excel 仅修改标题仍允许
  const renameExcel = buildUpdateNotePayload({
    currentNote: { version: 3, contentFormat: "tiptap-json", noteType: "excel" },
    title: "财务汇总表",
  });
  assert.equal(renameExcel.title, "财务汇总表");
  assert.equal("content" in renameExcel, false);
});
