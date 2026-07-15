import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-ai-settings-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let closeDb: () => void;

test.before(async () => {
  const [schema, routes, settings] = await Promise.all([
    import("../src/db/schema"),
    import("../src/routes/tasks"),
    import("../src/services/user-ai-settings"),
  ]);
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/tasks", routes.default);
  const db = schema.getDb();
  for (const userId of ["task-ai-a", "task-ai-b"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  }
  db.prepare("INSERT INTO tasks (id, userId, title) VALUES (?, ?, ?)").run("task-a", "task-ai-a", "Plan A");
  db.prepare("INSERT INTO tasks (id, userId, title) VALUES (?, ?, ?)").run("task-b", "task-ai-b", "Plan B");
  settings.setUserAISettings("task-ai-a", [
    { key: "ai_provider", value: "openai" },
    { key: "ai_api_url", value: "https://chat-a.example/v1" },
    { key: "ai_api_key", value: "chat-key-a" },
    { key: "ai_model", value: "chat-model-a" },
  ]);
  settings.setUserAISettings("task-ai-b", [
    { key: "ai_provider", value: "deepseek" },
    { key: "ai_api_url", value: "https://chat-b.example/v1" },
    { key: "ai_api_key", value: "chat-key-b" },
    { key: "ai_model", value: "chat-model-b" },
  ]);
});

test.after(async () => {
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

test("task breakdown uses the requesting user's AI configuration", async () => {
  const requests: Array<{ url: string; authorization: string; model: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") || "",
      model: body.model,
    });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ subtasks: [{ title: "First step", priority: 2, dueDate: null }] }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    for (const [taskId, userId] of [["task-a", "task-ai-a"], ["task-b", "task-ai-b"]]) {
      const response = await app.request(`/tasks/${taskId}/ai-breakdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": userId },
        body: JSON.stringify({ lang: "en" }),
      });
      assert.equal(response.status, 200);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { url: "https://chat-a.example/v1/chat/completions", authorization: "Bearer chat-key-a", model: "chat-model-a" },
    { url: "https://chat-b.example/v1/chat/completions", authorization: "Bearer chat-key-b", model: "chat-model-b" },
  ]);
});
