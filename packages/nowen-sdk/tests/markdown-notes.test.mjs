import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NowenClient } from "../dist/index.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("SDK declarations expose note contentFormat contracts", async () => {
  const declarations = await readFile(new URL("../dist/types.d.ts", import.meta.url), "utf8");

  assert.match(
    declarations,
    /export type NoteContentFormat = "markdown" \| "tiptap-json" \| "html";/,
  );
  assert.match(declarations, /interface Note[\s\S]*contentFormat: NoteContentFormat;/);
  assert.match(declarations, /interface CreateNoteParams[\s\S]*contentFormat\?: NoteContentFormat;/);
  assert.match(declarations, /interface UpdateNoteParams[\s\S]*contentFormat\?: NoteContentFormat;/);
});

test("NowenClient creates and updates Markdown source content", async () => {
  const calls = [];
  const fetchMock = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/api/auth/login")) {
      return json({ token: "token-markdown" });
    }

    if (url.endsWith("/api/notes") && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, {
        notebookId: "notebook-1",
        title: "Markdown note",
        content: "# Title\n\nBody **bold**",
        contentFormat: "markdown",
      });
      assert.equal("contentText" in body, false);
      return json({
        id: "note-1",
        userId: "user-1",
        notebookId: "notebook-1",
        title: body.title,
        content: body.content,
        contentText: "Title Body bold",
        contentFormat: body.contentFormat,
        isPinned: 0,
        isFavorite: 0,
        isLocked: 0,
        isTrashed: 0,
        version: 1,
        createdAt: "2026-07-24T00:00:00Z",
        updatedAt: "2026-07-24T00:00:00Z",
      }, 201);
    }

    if (url.endsWith("/api/notes/note-1") && init.method === "PUT") {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, {
        content: "# Updated\n\nNew body",
        contentFormat: "markdown",
        version: 1,
      });
      return json({
        id: "note-1",
        userId: "user-1",
        notebookId: "notebook-1",
        title: "Markdown note",
        content: body.content,
        contentText: "Updated New body",
        contentFormat: body.contentFormat,
        isPinned: 0,
        isFavorite: 0,
        isLocked: 0,
        isTrashed: 0,
        version: 2,
        createdAt: "2026-07-24T00:00:00Z",
        updatedAt: "2026-07-24T00:01:00Z",
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new NowenClient({
    baseUrl: "http://nowen.test",
    username: "admin",
    password: "secret",
    fetch: fetchMock,
  });

  const created = await client.createNote({
    notebookId: "notebook-1",
    title: "Markdown note",
    content: "# Title\n\nBody **bold**",
    contentFormat: "markdown",
  });
  assert.equal(created.contentFormat, "markdown");
  assert.equal(created.version, 1);

  const updated = await client.updateNote(created.id, {
    content: "# Updated\n\nNew body",
    contentFormat: "markdown",
    version: created.version,
  });
  assert.equal(updated.contentFormat, "markdown");
  assert.equal(updated.version, 2);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
});
