import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-embedding-user-settings-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let closeDb: () => void;
let embedQuery: typeof import("../src/services/embedding-worker").embedQuery;
let startEmbeddingWorker: typeof import("../src/services/embedding-worker").startEmbeddingWorker;
let stopEmbeddingWorker: typeof import("../src/services/embedding-worker").stopEmbeddingWorker;
let setUserAISettings: typeof import("../src/services/user-ai-settings").setUserAISettings;
let getDb: typeof import("../src/db/schema").getDb;

test.before(async () => {
  const [schema, worker, settings] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/embedding-worker"),
    import("../src/services/user-ai-settings"),
  ]);
  closeDb = schema.closeDb;
  getDb = schema.getDb;
  embedQuery = worker.embedQuery;
  startEmbeddingWorker = worker.startEmbeddingWorker;
  stopEmbeddingWorker = worker.stopEmbeddingWorker;
  setUserAISettings = settings.setUserAISettings;
  schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("embed-a", "embed-a", "hash");
  schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("embed-b", "embed-b", "hash");
  schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("embed-default", "embed-default", "hash");
});

test.after(async () => {
  stopEmbeddingWorker?.();
  closeDb?.();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== "EBUSY" || attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("embedQuery uses the requested user's URL, key, and model", async () => {
  setUserAISettings("embed-a", [
    { key: "ai_provider", value: "openai" },
    { key: "ai_embedding_url", value: "https://embed-a.example/v1" },
    { key: "ai_embedding_key", value: "embed-key-a" },
    { key: "ai_embedding_model", value: "embed-model-a" },
  ]);
  setUserAISettings("embed-b", [
    { key: "ai_provider", value: "openai" },
    { key: "ai_embedding_url", value: "https://embed-b.example/v1" },
    { key: "ai_embedding_key", value: "embed-key-b" },
    { key: "ai_embedding_model", value: "embed-model-b" },
  ]);

  const requests: Array<{ url: string; authorization: string; model: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") || "",
      model: JSON.parse(String(init?.body)).model,
    });
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await embedQuery("embed-a", "alpha question");
    await embedQuery("embed-b", "beta question");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { url: "https://embed-a.example/v1/embeddings", authorization: "Bearer embed-key-a", model: "embed-model-a" },
    { url: "https://embed-b.example/v1/embeddings", authorization: "Bearer embed-key-b", model: "embed-model-b" },
  ]);
});

test("background queue uses the same default URL semantics as embedQuery", async () => {
  setUserAISettings("embed-default", [
    { key: "ai_api_key", value: "default-key" },
    { key: "ai_embedding_model", value: "default-model" },
  ]);
  getDb().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run("embed-default-notebook", "embed-default", "Notebook");
  getDb().prepare("INSERT INTO notes (id, userId, notebookId, title, contentText) VALUES (?, ?, ?, ?, ?)")
    .run("embed-default-note", "embed-default", "embed-default-notebook", "Long enough title", "Long enough body for embedding");

  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests += 1;
    assert.equal(String(input), "https://api.openai.com/v1/embeddings");
    return new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [0.3, 0.4] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    startEmbeddingWorker();
    for (let attempt = 0; attempt < 20 && requests === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    stopEmbeddingWorker();
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests, 1);
  assert.equal(
    (getDb().prepare("SELECT status FROM embedding_queue WHERE noteId = ?").get("embed-default-note") as { status: string }).status,
    "done",
  );
});
