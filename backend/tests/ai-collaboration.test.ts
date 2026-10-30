import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ai-collaboration-"));
process.env.DB_PATH = path.join(directory, "qa.db");
process.env.ELECTRON_USER_DATA = directory;
let app: Hono;
let db: ReturnType<typeof import("../src/db/schema").getDb>;
let closeDb: () => void;
let originalFetch: typeof fetch;
let calls: Array<{ body: { messages: Array<{ role: string; content: string }>; model: string }; headers: Headers }>;
const headers = { "X-User-Id": "collab-a", "Content-Type": "application/json" };
const compose = (patch: Record<string, unknown> = {}, suffix = "") => app.request(`/ai/collaboration/compose${suffix}`, {
  method: "POST", headers, body: JSON.stringify({ input: "Draft the project plan", intent: "draft", ...patch }),
});

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const schema = await import("../src/db/schema"); db = schema.getDb(); closeDb = schema.closeDb;
  const settings = await import("../src/services/user-ai-settings");
  for (const id of ["collab-a", "collab-b"]) db.prepare("INSERT INTO users (id,username,passwordHash) VALUES (?,?,?)").run(id, id, "hash");
  for (const [id, user, parent] of [["project", "collab-a", null], ["project-child", "collab-a", "project"], ["skills", "collab-a", null], ["foreign", "collab-b", null], ["locked-folder", "collab-a", "project"]]) {
    db.prepare("INSERT INTO notebooks (id,userId,name,parentId) VALUES (?,?,?,?)").run(id, user, id, parent);
  }
  const insert = db.prepare("INSERT INTO notes (id,userId,notebookId,title,content,contentText,contentFormat,isTrashed) VALUES (?,?,?,?,?,?,?,?)");
  for (const [id, owner, folder, text, format, trashed] of [
    ["current", "collab-a", "project", "PROJECT VERIFIED STATE", "markdown", 0],
    ["child", "collab-a", "project-child", "PROJECT CHILD STATE", "markdown", 0],
    ["skill", "collab-a", "skills", "SKILL: describe goals and open questions", "markdown", 0],
    ["private", "collab-b", "foreign", "FOREIGN SECRET", "markdown", 0],
    ["trashed", "collab-a", "project", "TRASH SECRET", "markdown", 1],
    ["encrypted", "collab-a", "project", "ENCRYPTED SECRET", "encrypted-note-v1", 0],
    ["locked", "collab-a", "locked-folder", "PASSWORD SECRET", "markdown", 0],
  ] as const) {
    const encrypted = format === "encrypted-note-v1";
    const envelope = encrypted ? JSON.stringify(JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8")).envelope) : text;
    insert.run(id, owner, folder, id, envelope, encrypted ? "" : text, format, trashed);
  }
  db.prepare("INSERT INTO notebook_passwords(notebookId,passwordHash,passwordVersion) VALUES ('locked-folder','hash',1)").run();
  db.prepare("INSERT INTO ai_custom_prompts(id,userId,name,prompt) VALUES ('personal','collab-a','Plan skill','PERSONAL INSTRUCTION'),('foreign-personal','collab-b','Secret skill','PRIVATE PROMPT')").run();
  settings.setUserAISettings("collab-a", [{ key: "ai_api_url", value: "https://collaboration.example/v1" }, { key: "ai_api_key", value: "collab-key" }, { key: "ai_model", value: "collab-model" }]);
  app = new Hono(); app.route("/ai", (await import("../src/routes/ai-reliable")).default);
  originalFetch = globalThis.fetch;
});
test.beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "# Draft\n\nProposed work." } }] }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => { closeDb?.(); fs.rmSync(directory, { recursive: true, force: true }); });

test("collaboration requires authentication before listing or generation", async () => {
  assert.equal((await app.request("/ai/collaboration/skills?notebookId=skills")).status, 401);
  assert.equal((await app.request("/ai/collaboration/compose", { method: "POST", body: "{}" })).status, 401);
  assert.equal(calls.length, 0);
});
test("quick capture sends only explicit input and creates no notes", async () => {
  const count = (db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
  const response = await compose({ intent: "capture", input: "An idea about a new feature", skill: { kind: "personal", id: "personal" } });
  assert.equal(response.status, 200);
  const result = await response.json() as { content: string; references: unknown[] };
  assert.ok(result.content.includes("Draft")); assert.deepEqual(result.references, []);
  assert.equal(calls[0].body.model, "collab-model"); assert.equal(calls[0].headers.get("Authorization"), "Bearer collab-key");
  const sent = JSON.stringify(calls[0].body);
  assert.ok(sent.includes("PERSONAL INSTRUCTION")); assert.ok(!sent.includes("PROJECT VERIFIED STATE"));
  assert.ok(!sent.includes("SECRET"));
  assert.equal((db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n, count);
});
test("project generation reads selected descendants and separates Skill from references", async () => {
  const response = await compose({ notebookId: "project", skill: { kind: "note", id: "skill", notebookId: "skills" } });
  assert.equal(response.status, 200);
  const result = await response.json() as { references: Array<{ id: string }>; skillName: string };
  assert.deepEqual(result.references.map(ref => ref.id).sort(), ["child", "current"]);
  assert.equal(result.skillName, "skill");
  const sent = JSON.stringify(calls[0].body);
  assert.ok(sent.includes("SKILL: describe")); assert.ok(sent.includes("PROJECT VERIFIED STATE")); assert.ok(sent.includes("PROJECT CHILD STATE"));
  for (const secret of ["FOREIGN SECRET", "TRASH SECRET", "ENCRYPTED SECRET", "PASSWORD SECRET", "PRIVATE PROMPT"]) assert.ok(!sent.includes(secret), secret);
  assert.equal(calls[0].body.messages[0].role, "system");
  assert.ok(!calls[0].body.messages[0].content.includes("PROJECT VERIFIED STATE"));
});
test("library listing filters trash, encryption, password folders and other owners", async () => {
  const res = await app.request("/ai/collaboration/skills?notebookId=project", { headers });
  assert.equal(res.status, 200);
  const result = await res.json() as { items: Array<{ id: string }>; limited: boolean };
  assert.deepEqual(result.items.map(item => item.id).sort(), ["child", "current"]);
  assert.equal((await app.request("/ai/collaboration/skills?notebookId=foreign", { headers })).status, 403);
});
test("forged Skill IDs, wrong library and foreign workspace never reach the provider", async () => {
  for (const patch of [
    { notebookId: "foreign" },
    { skill: { kind: "personal", id: "foreign-personal" } },
    { skill: { kind: "note", id: "private", notebookId: "skills" } },
    { skill: { kind: "note", id: "current", notebookId: "skills" } },
    { skill: { kind: "note", id: "encrypted", notebookId: "project" } },
    { skill: { kind: "note", id: "locked", notebookId: "project" } },
  ]) assert.equal((await compose(patch)).status, 403, JSON.stringify(patch));
  assert.equal((await compose({}, "?workspaceId=foreign-space")).status, 403);
  assert.equal(calls.length, 0);
});
test("malformed and oversized input is rejected without sending source text", async () => {
  for (const patch of [{ input: "" }, { input: "a".repeat(8001) }, { intent: "execute" }, { skill: { kind: "prompt", name: "skill", prompt: "x".repeat(64001) } }]) {
    assert.equal((await compose(patch)).status, 400);
  }
  assert.equal(calls.length, 0);
});
test("provider failure and empty responses do not write notes or return a fake draft", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })) as typeof fetch;
  assert.equal((await compose()).status, 502);
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }))) as typeof fetch;
  assert.equal((await compose()).status, 502);
});
test("disabled AI cannot be bypassed by collaboration", async () => {
  db.prepare("INSERT INTO user_ai_settings(userId,key,value) VALUES ('collab-a','ai_manual_enabled','false') ON CONFLICT(userId,key) DO UPDATE SET value='false'").run();
  try { assert.equal((await compose()).status, 409); assert.equal(calls.length, 0); }
  finally { db.prepare("DELETE FROM user_ai_settings WHERE userId='collab-a' AND key='ai_manual_enabled'").run(); }
});
