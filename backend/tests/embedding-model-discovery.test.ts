import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type Database from "better-sqlite3";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-embedding-discovery-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let setUserAISettings: typeof import("../src/services/user-ai-settings").setUserAISettings;
const USER_ID = "embedding-discovery-user";

async function request(pathname: string, body: unknown) {
  const response = await app.request(pathname, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": USER_ID,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

test.before(async () => {
  const [schema, routes, settings] = await Promise.all([
    import("../src/db/schema"),
    import("../src/routes/ai"),
    import("../src/services/user-ai-settings"),
  ]);
  db = schema.getDb();
  closeDb = schema.closeDb;
  setUserAISettings = settings.setUserAISettings;
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  app = new Hono();
  app.route("/ai", routes.default);
});

test.beforeEach(() => {
  db.prepare("DELETE FROM user_ai_settings WHERE userId = ?").run(USER_ID);
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("discovers models with a saved profile and filters obvious chat/image/audio models", async () => {
  setUserAISettings(USER_ID, [{
    key: "ai_profiles_v1",
    value: JSON.stringify([{
      id: "profile-embed",
      name: "Embedding Provider",
      provider: "openai",
      apiUrl: "https://models.example/v1",
      apiKey: "profile-secret",
      model: "chat-model",
    }]),
  }]);

  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let authorization = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify({
      data: [
        { id: "text-embedding-3-small" },
        { id: "bge-m3", task: "feature-extraction" },
        { id: "acme-semantic-v1" },
        { id: "gpt-4o" },
        { id: "dall-e-3" },
        { id: "whisper-1" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await request("/ai/embeddings/models", {
      source: "profile",
      profileId: "profile-embed",
    });
    assert.equal(result.status, 200);
    assert.equal(requestedUrl, "https://models.example/v1/models");
    assert.equal(authorization, "Bearer profile-secret");
    assert.deepEqual(result.body.models.map((model: any) => model.id), [
      "bge-m3",
      "text-embedding-3-small",
      "acme-semantic-v1",
    ]);
    assert.equal(result.body.models[0].recommended, true);
    assert.equal(result.body.models[2].recommended, false);
    assert.equal(result.body.filteredCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Ollama native tags and excludes obvious chat models", async () => {
  setUserAISettings(USER_ID, [
    { key: "ai_provider", value: "ollama" },
    { key: "ai_api_url", value: "http://ollama.local:11434/v1" },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "http://ollama.local:11434/api/tags");
    return new Response(JSON.stringify({
      models: [
        { name: "nomic-embed-text:latest" },
        { name: "mxbai-embed-large" },
        { name: "llama3.2:latest" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await request("/ai/embeddings/models", { source: "chat" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.models.map((model: any) => model.id), [
      "mxbai-embed-large",
      "nomic-embed-text:latest",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tests /embeddings and returns vector dimension and duration", async () => {
  setUserAISettings(USER_ID, [
    { key: "ai_provider", value: "openai" },
    { key: "ai_embedding_url", value: "https://embedding.example/v1" },
    { key: "ai_embedding_key", value: "stored-secret" },
  ]);
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://embedding.example/v1/embeddings");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer stored-secret");
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await request("/ai/embeddings/test", {
      source: "custom",
      url: "https://embedding.example/v1",
      model: "text-embedding-3-small",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.dimension, 4);
    assert.equal(result.body.model, "text-embedding-3-small");
    assert.ok(result.body.durationMs >= 0);
    assert.deepEqual(requestBody, {
      model: "text-embedding-3-small",
      input: ["Nowen Note embedding connectivity test."],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports authentication and endpoint errors with explicit codes", async () => {
  setUserAISettings(USER_ID, [
    { key: "ai_provider", value: "openai" },
    { key: "ai_api_url", value: "https://errors.example/v1" },
    { key: "ai_api_key", value: "bad-key" },
  ]);
  const originalFetch = globalThis.fetch;
  let status = 401;
  globalThis.fetch = (async () => new Response("upstream error", { status })) as typeof fetch;

  try {
    const auth = await request("/ai/embeddings/test", {
      source: "chat",
      model: "text-embedding-3-small",
    });
    assert.equal(auth.status, 502);
    assert.equal(auth.body.code, "EMBEDDING_AUTH_FAILED");
    assert.equal(auth.body.upstreamStatus, 401);

    status = 404;
    const missing = await request("/ai/embeddings/test", {
      source: "chat",
      model: "text-embedding-3-small",
    });
    assert.equal(missing.status, 502);
    assert.equal(missing.body.code, "EMBEDDING_ENDPOINT_NOT_FOUND");
    assert.equal(missing.body.upstreamStatus, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports timeouts and malformed embedding responses", async () => {
  setUserAISettings(USER_ID, [
    { key: "ai_provider", value: "openai" },
    { key: "ai_api_url", value: "https://timeout.example/v1" },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }) as typeof fetch;

  try {
    const timeout = await request("/ai/embeddings/test", {
      source: "chat",
      model: "text-embedding-3-small",
    });
    assert.equal(timeout.status, 504);
    assert.equal(timeout.body.code, "EMBEDDING_TEST_TIMEOUT");
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ index: 0 }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const malformed = await request("/ai/embeddings/test", {
      source: "chat",
      model: "text-embedding-3-small",
    });
    assert.equal(malformed.status, 502);
    assert.equal(malformed.body.code, "EMBEDDING_RESPONSE_INVALID");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
