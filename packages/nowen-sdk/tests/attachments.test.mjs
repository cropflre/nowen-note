import test from "node:test";
import assert from "node:assert/strict";
import { NowenClient } from "../dist/index.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("NowenClient uploads and lists attachments through the public REST contract", async () => {
  const calls = [];
  const fetchMock = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/auth/login")) return json({ token: "token-1" });
    if (url.endsWith("/api/attachments")) {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer token-1");
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("noteId"), "note-1");
      const file = init.body.get("file");
      assert.ok(file instanceof File);
      assert.equal(file.name, "chart.png");
      return json({
        id: "att-1",
        url: "/api/attachments/att-1",
        mimeType: "image/png",
        size: 3,
        filename: "chart.png",
        category: "image",
      }, 201);
    }
    if (url.includes("/api/files?")) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("notebookId"), "book-1");
      assert.equal(parsed.searchParams.get("category"), "image");
      assert.equal(parsed.searchParams.get("pageSize"), "25");
      return json({ items: [], total: 0, page: 1, pageSize: 25 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new NowenClient({
    baseUrl: "http://nowen.test",
    username: "admin",
    password: "secret",
    fetch: fetchMock,
  });

  const uploaded = await client.uploadAttachment({
    file: new Uint8Array([1, 2, 3]),
    filename: "chart.png",
    mimeType: "image/png",
    noteId: "note-1",
  });
  assert.equal(uploaded.id, "att-1");

  const listed = await client.listAttachments({
    notebookId: "book-1",
    category: "image",
    pageSize: 25,
  });
  assert.equal(listed.total, 0);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
});

test("attachToNote inserts Markdown and preserves optimistic-lock version", async () => {
  const calls = [];
  const fetchMock = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/auth/login")) return json({ token: "token-2" });
    if (url.endsWith("/api/files/att-2")) {
      return json({
        id: "att-2",
        url: "/api/attachments/att-2",
        filename: "diagram.png",
        mimeType: "image/png",
        category: "image",
        size: 10,
        createdAt: "2026-07-16T00:00:00Z",
        hash: null,
        folderId: null,
        folderName: null,
        primaryNote: null,
      });
    }
    if (url.endsWith("/api/notes/note-2") && (!init.method || init.method === "GET")) {
      return json({
        id: "note-2",
        title: "Architecture",
        content: "Intro",
        contentFormat: "markdown",
        version: 7,
      });
    }
    if (url.endsWith("/api/notes/note-2") && init.method === "PUT") {
      const body = JSON.parse(init.body);
      assert.equal(body.version, 7);
      assert.equal(body.contentFormat, "markdown");
      assert.equal(body.content, "Intro\n\n![System diagram](/api/attachments/att-2)");
      return json({ id: "note-2", title: "Architecture", version: 8 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const client = new NowenClient({
    baseUrl: "http://nowen.test",
    username: "admin",
    password: "secret",
    fetch: fetchMock,
  });

  const updated = await client.attachToNote({
    noteId: "note-2",
    attachmentId: "att-2",
    alt: "System diagram",
  });
  assert.equal(updated.version, 8);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
});
