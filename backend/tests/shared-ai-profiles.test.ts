import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import Database from "better-sqlite3";
import type * as Service from "../src/services/shared-ai-profiles.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-shared-ai-"));
process.env.DB_PATH = path.join(directory, "test.db");
let db: Database.Database;
let closeDb: () => void;
let service: typeof Service;
let app: Hono;
let sharedRouter: Hono;
const draft = { name: "Team model", provider: "openai", apiUrl: "https://team.example/v1", apiKey: "shared-secret", customHeaders: { "x-session": "private-session" }, model: "chat-model", memberIds: ["member-a"] };

test.before(async () => {
  const schema = await import("../src/db/schema.js");
  db = schema.getDb(); closeDb = schema.closeDb;
  service = await import("../src/services/shared-ai-profiles.js");
  sharedRouter = (await import("../src/routes/shared-ai-profiles.js")).default;
  app = new Hono().route("/ai", sharedRouter);
});
test.beforeEach(() => {
  db.exec("DELETE FROM shared_ai_profiles; DELETE FROM user_ai_settings; DELETE FROM users WHERE id IN ('admin','member-a','member-b');");
  for (const id of ["admin", "member-a", "member-b"]) db.prepare("INSERT INTO users (id,username,passwordHash,role) VALUES (?,?,?,?)").run(id, id, "hash", id === "admin" ? "admin" : "user");
});
test.after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

async function request(method: string, url: string, body?: unknown, userId = "admin", mode?: string) {
  const response = await app.request(`/ai${url}`, { method,
    headers: { ...(userId ? { "X-User-Id": userId } : {}), ...(mode ? { "X-Auth-Mode": mode } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}

test("shared administration requires a login administrator; role claims and PATs cannot grant access", async () => {
  assert.equal((await request("POST", "/shared-profiles", draft, "")).status, 401);
  assert.equal((await request("POST", "/shared-profiles", draft, "member-a")).status, 403);
  assert.equal((await request("POST", "/shared-profiles", draft, "admin", "api-token")).status, 403);
  assert.equal((await request("GET", "/shared-profiles", undefined, "member-a")).status, 403);
  assert.equal(service.listAdminSharedAIProfiles().length, 0);
});

test("shared middleware does not intercept legacy chat PATs or cap unrelated request bodies", async () => {
  const combined = new Hono().route("/ai", sharedRouter);
  combined.post("/ai/chat", async (c) => c.json({ mode: c.req.header("X-Auth-Mode"), length: (await c.req.text()).length }));
  const response = await combined.request("/ai/chat", { method: "POST", headers: { "X-Auth-Mode": "api-token" }, body: "x".repeat(300_000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mode: "api-token", length: 300_000 });
});

test("member invocation accepts validated contexts larger than 256 KB within the model channel limit", async () => {
  const profile = service.saveSharedAIProfile("admin", draft);
  const originalFetch = globalThis.fetch;
  let length = 0;
  globalThis.fetch = async (_url, init) => {
    length = JSON.parse(String(init?.body)).messages[0].content.length;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  };
  try {
    const response = await request("POST", `/shared-profiles/${profile.id}/invoke`, { messages: [{ role: "user", content: "x".repeat(300_000) }] }, "member-a");
    assert.equal(response.status, 200);
    assert.equal(length, 300_000);
    assert.equal(response.body.choices[0].message.content, "ok");
  } finally { globalThis.fetch = originalFetch; }
});

test("DCC-006: only granted members see and select shared metadata, without connection fields or copied secrets", async () => {
  const created = await request("POST", "/shared-profiles", draft);
  assert.equal(created.status, 201);
  const id = created.body.profile.id;
  assert.equal(created.body.profile.apiKey, "****");
  assert.equal(created.body.profile.customHeaders["x-session"], "****");
  const allowed = await request("GET", "/profiles/available", undefined, "member-a");
  const denied = await request("GET", "/profiles/available", undefined, "member-b");
  assert.equal(allowed.body.sharedProfiles.length, 1);
  assert.equal(denied.body.sharedProfiles.length, 0);
  for (const key of ["apiUrl", "apiKey", "apiKeySet", "customHeaders", "customHeadersJson", "memberIds"]) assert.equal(key in allowed.body.sharedProfiles[0], false);
  assert.equal((await request("PUT", "/profiles/active", { scope: "shared", id }, "member-b")).status, 403);
  assert.equal((await request("PUT", "/profiles/active", { scope: "shared", id }, "member-a")).status, 200);
  const saved = db.prepare("SELECT key,value FROM user_ai_settings WHERE userId='member-a'").all() as Array<{ key: string; value: string }>;
  assert.equal(saved.find((row) => row.key === service.ACTIVE_SHARED_AI_KEY)?.value, id);
  assert.equal(JSON.stringify(saved).includes("shared-secret"), false);
  assert.equal(JSON.stringify(saved).includes("private-session"), false);
  assert.equal(service.resolveSharedChatSettings("member-a")!.ai_api_key, "shared-secret");
  assert.throws(() => service.resolveSharedProfileSettings("member-b", id), { code: "AI_SHARED_PROFILE_UNAVAILABLE" });
});

test("rotation, revoke, pause and delete are checked on each resolution without personal fallback", async () => {
  let profile = service.saveSharedAIProfile("admin", draft);
  service.activateSharedAIProfile("member-a", profile.id);
  profile = service.saveSharedAIProfile("admin", { apiKey: "rotated-secret", model: "new-chat-model", revision: profile.revision }, profile.id);
  assert.equal(service.resolveSharedChatSettings("member-a")!.ai_api_key, "rotated-secret");
  assert.equal(service.resolveSharedChatSettings("member-a")!.ai_model, "new-chat-model");
  profile = service.saveSharedAIProfile("admin", { enabled: false, revision: profile.revision }, profile.id);
  assert.throws(() => service.resolveSharedChatSettings("member-a"), { code: "AI_SHARED_PROFILE_UNAVAILABLE" });
  profile = service.saveSharedAIProfile("admin", { enabled: true, memberIds: [], revision: profile.revision }, profile.id);
  assert.throws(() => service.resolveSharedChatSettings("member-a"), { code: "AI_SHARED_PROFILE_UNAVAILABLE" });
  const state = await request("GET", "/profiles/available", undefined, "member-a");
  assert.equal(state.body.unavailable, true);
  assert.equal(state.body.active.id, profile.id);
  service.deleteSharedAIProfile(profile.id, profile.revision);
  assert.throws(() => service.resolveSharedChatSettings("member-a"), { code: "AI_SHARED_PROFILE_UNAVAILABLE" });
});

test("concurrent edits conflict and grant persistence failures roll back configuration and revision", async () => {
  const profile = service.saveSharedAIProfile("admin", draft);
  assert.throws(() => service.saveSharedAIProfile("admin", { name: "stale", revision: 2 }, profile.id), { code: "AI_SHARED_PROFILE_CONFLICT" });
  assert.throws(() => service.deleteSharedAIProfile(profile.id, 2), { code: "AI_SHARED_PROFILE_CONFLICT" });
  db.exec("CREATE TRIGGER fail_shared_grant BEFORE INSERT ON shared_ai_profile_grants WHEN NEW.userId='member-b' BEGIN SELECT RAISE(ABORT, 'injected grant failure'); END;");
  try {
    assert.throws(() => service.saveSharedAIProfile("admin", { name: "must rollback", revision: 1, memberIds: ["member-b"] }, profile.id));
    const stored = service.getSharedAIProfile(profile.id)!;
    assert.equal(stored.name, draft.name);
    assert.equal(stored.revision, 1);
    assert.equal(service.listSharedAIProfiles("member-a").length, 1);
  } finally { db.exec("DROP TRIGGER fail_shared_grant"); }
});

test("publication reads only the administrator's personal profile and produces an independent resource", async () => {
  const insert = db.prepare("INSERT INTO user_ai_settings (userId,key,value) VALUES (?,?,?)");
  const source = { id: "private-id", ...draft };
  insert.run("member-a", "ai_profiles_v1", JSON.stringify([source]));
  assert.equal((await request("POST", "/shared-profiles", { sourceProfileId: source.id, memberIds: ["member-a"] })).status, 404);
  insert.run("admin", "ai_profiles_v1", JSON.stringify([source]));
  const result = await request("POST", "/shared-profiles", { sourceProfileId: source.id, memberIds: ["member-a"] });
  assert.equal(result.status, 201);
  db.prepare("UPDATE user_ai_settings SET value='[]' WHERE userId='admin'").run();
  assert.equal(service.getSharedAIProfile(result.body.profile.id)!.apiKey, draft.apiKey);
  assert.equal((await request("PUT", `/shared-profiles/${result.body.profile.id}`, { revision: 1, apiUrl: "https://steal.example" }, "member-a")).status, 403);
});

test("member deletion removes grants while deleting the publishing administrator retains shared resources", () => {
  const profile = service.saveSharedAIProfile("admin", draft);
  db.prepare("DELETE FROM users WHERE id='admin'").run();
  assert.equal(service.getSharedAIProfile(profile.id)!.createdBy, null);
  assert.equal(service.listSharedAIProfiles("member-a").length, 1);
  db.prepare("DELETE FROM users WHERE id='member-a'").run();
  assert.equal((db.prepare("SELECT count(*) AS count FROM shared_ai_profile_grants").get() as { count: number }).count, 0);
});

test("DCC-008: SQLite backup preserves shared credentials, grants and selection on reopen", async () => {
  const profile = service.saveSharedAIProfile("admin", draft);
  service.activateSharedAIProfile("member-a", profile.id);
  const snapshot = path.join(directory, "snapshot.db");
  await db.backup(snapshot);
  const restored = new Database(snapshot);
  try {
    assert.equal((restored.prepare("SELECT apiKey FROM shared_ai_profiles WHERE id=?").get(profile.id) as { apiKey: string }).apiKey, draft.apiKey);
    assert.equal((restored.prepare("SELECT userId FROM shared_ai_profile_grants WHERE profileId=?").get(profile.id) as { userId: string }).userId, "member-a");
    assert.equal((restored.prepare("SELECT value FROM user_ai_settings WHERE userId=? AND key=?").get("member-a", service.ACTIVE_SHARED_AI_KEY) as { value: string }).value, profile.id);
    assert.deepEqual(restored.pragma("foreign_key_check"), []);
  } finally { restored.close(); }
});

test("invalid drafts and invalid recipients cannot create a shared resource", async () => {
  for (const body of [{ ...draft, apiUrl: "file:///tmp/model" }, { ...draft, model: "text-embedding-3-small" }, { ...draft, memberIds: ["missing"] }, { ...draft, customHeaders: { Host: "bad" } }]) {
    assert.equal((await request("POST", "/shared-profiles", body)).status, 400);
  }
  assert.equal(service.listAdminSharedAIProfiles().length, 0);
});

test("administrators can identify and remove disabled recipients before saving a shared profile", async () => {
  const profile = service.saveSharedAIProfile("admin", draft);
  db.prepare("UPDATE users SET isDisabled=1 WHERE id='member-a'").run();
  const result = await request("GET", "/shared-profiles");
  assert.equal(result.body.members.find((member: {id:string}) => member.id === "member-a").isDisabled,1);
  assert.throws(() => service.resolveSharedProfileSettings("member-a",profile.id), {code:"AI_SHARED_PROFILE_UNAVAILABLE"});
  const updated = await request("PUT", `/shared-profiles/${profile.id}`, {revision:profile.revision,memberIds:[]});
  assert.equal(updated.status,200);
  assert.deepEqual(updated.body.profile.memberIds,[]);
});
