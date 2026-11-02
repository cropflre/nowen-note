import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-shared-chat-"));
process.env.DB_PATH = path.join(directory, "test.db");
let app: Hono;
let schema: typeof import("../src/db/schema");
let settings: typeof import("../src/services/user-ai-settings");
let chat: typeof import("../src/services/user-chat-settings");
let client: typeof import("../src/services/ai-client");
let embedding: typeof import("../src/services/embedding-config");
let sharedId: string;
const originalFetch = globalThis.fetch;
const requests: Array<{url: string; init?: RequestInit}> = [];

async function request(route: string, method = "GET", body?: unknown, user = "member") {
  return app.request(route, { method, headers: { "X-User-Id": user, "Content-Type": "application/json" }, ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
}
async function selectShared() {
  const response = await request("/ai/profiles/active", "PUT", {scope: "shared", id: sharedId});
  assert.equal(response.status, 200, await response.text());
}
test.before(async () => {
  const [s, a, c, e, routes, personal, ai, reliable] = await Promise.all([
    import("../src/db/schema"), import("../src/services/user-ai-settings"), import("../src/services/user-chat-settings"),
    import("../src/services/embedding-config"), import("../src/routes/shared-ai-profiles"),
    import("../src/routes/user-preferences-legacy"), import("../src/routes/ai"), import("../src/routes/ai-reliable"),
  ]);
  schema = s; settings = a; chat = c; embedding = e; client = await import("../src/services/ai-client");
  for (const id of ["admin", "member", "outsider"]) schema.getDb().prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,?)").run(id,id,"hash",id === "admin" ? "admin" : "user");
  settings.setUserAISettings("member", [
    {key:"ai_api_url",value:"https://personal.example/v1"}, {key:"ai_api_key",value:"personal-key"}, {key:"ai_model",value:"personal-model"},
    {key:"ai_embedding_model",value:"personal-embedding"},
  ]);
  app = new Hono();
  const { handleUnhandledRequestError } = await import("../src/middleware/request-error");
  app.onError(handleUnhandledRequestError);
  app.route("/ai", routes.default); app.route("/ai", ai.default); app.route("/personal", personal.default); app.route("/reliable", reliable.default);
  const created = await request("/ai/shared-profiles", "POST", {name:"Team", provider:"openai", apiUrl:"https://team.example/v1", apiKey:"team-secret", customHeaders:{"x-team-token":"team-header-secret"}, model:"team-model",memberIds:["member"]}, "admin");
  assert.equal(created.status, 201, await created.clone().text());
  sharedId = (await created.json() as any).profile.id;
  globalThis.fetch = async (url, init) => {
    requests.push({url:String(url),init});
    return new Response(JSON.stringify({choices:[{message:{content:"hello from shared"}}]}), {headers:{"content-type":"application/json"}});
  };
});
test.after(() => { globalThis.fetch = originalFetch; schema?.closeDb(); fs.rmSync(directory,{recursive:true,force:true}); });

test("selected shared chat uses server credentials without changing personal or embedding settings", async () => {
  await selectShared();
  const before = settings.getUserAISettings("member");
  const selected = chat.resolveUserChatSettings("member");
  assert.equal(await client.callAIChat(selected,[{role:"user",content:"Hi"}]), "hello from shared");
  const sent = requests.at(-1)!;
  assert.equal(sent.url,"https://team.example/v1/chat/completions");
  assert.equal(new Headers(sent.init?.headers).get("authorization"),"Bearer team-secret");
  assert.equal(new Headers(sent.init?.headers).get("x-team-token"),"team-header-secret");
  assert.equal(JSON.parse(String(sent.init?.body)).model,"team-model");
  assert.deepEqual(settings.getUserAISettings("member"),before);
  const vector = embedding.resolveEmbeddingConfig("member");
  assert.equal(vector.config?.url,"https://personal.example/v1");
  assert.equal(vector.config?.apiKey,"personal-key");
  const response = await request("/ai/settings");
  assert.equal((await response.text()).includes("team-secret"),false);
  const stored = schema.getDb().prepare("SELECT value FROM user_ai_settings WHERE userId='member'").all();
  assert.equal(JSON.stringify(stored).includes("team-secret"),false);
  assert.equal(JSON.stringify(stored).includes("team-header-secret"),false);
});

test("shared rotation is re-resolved for each outbound call, including saved snapshots", async () => {
  const snapshot = chat.resolveUserChatSettings("member");
  schema.getDb().prepare("UPDATE shared_ai_profiles SET apiKey='rotated-secret',model='rotated-model' WHERE id=?").run(sharedId);
  await client.callAIChat(snapshot,[{role:"user",content:"Hi"}]);
  assert.equal(new Headers(requests.at(-1)?.init?.headers).get("authorization"),"Bearer rotated-secret");
  assert.equal(JSON.parse(String(requests.at(-1)?.init?.body)).model,"rotated-model");
});

test("DCC-006: revoked authorization rejects stale calls without falling back to personal credentials", async () => {
  const snapshot = chat.resolveUserChatSettings("member");
  const count = requests.length;
  schema.getDb().prepare("DELETE FROM shared_ai_profile_grants WHERE profileId=? AND userId='member'").run(sharedId);
  await assert.rejects(() => client.callAIChat(snapshot,[{role:"user",content:"Hi"}]), /共享配置/);
  assert.equal(requests.length,count);
  const status = await request("/reliable/status");
  assert.equal(status.status,200);
  assert.ok((await status.json() as any).configurationError);
  schema.getDb().prepare("INSERT INTO shared_ai_profile_grants(profileId,userId) VALUES (?,'member')").run(sharedId);
});

test("AI total switch blocks shared calls and restoring it preserves shared selection without saving its secrets", async () => {
  await selectShared();
  assert.equal((await request("/reliable/config-enabled","PUT",{enabled:false})).status,200);
  assert.throws(() => chat.resolveUserChatSettings("member"), /AI 已关闭/);
  assert.equal(settings.getUserAISetting("member","ai_active_shared_profile_id"),sharedId);
  assert.equal(JSON.stringify(schema.getDb().prepare("SELECT value FROM user_ai_settings WHERE userId='member'").all()).includes("rotated-secret"),false);
  assert.equal((await request("/reliable/config-enabled","PUT",{enabled:true})).status,200);
  assert.equal(chat.resolveUserChatSettings("member").ai_model,"rotated-model");
});

test("legacy personal activation exits shared mode but embedding-only edits keep it selected", async () => {
  assert.equal((await request("/ai/settings","PUT",{ai_embedding_model:"other-embedding"})).status,200);
  assert.equal(settings.getUserAISetting("member","ai_active_shared_profile_id"),sharedId);
  const personal = await request("/personal/ai-profiles");
  const id = (await personal.json() as any).profiles[0].id;
  assert.equal((await request(`/personal/ai-profiles/${id}/activate`,"PUT")).status,200);
  assert.equal(settings.getUserAISetting("member","ai_active_shared_profile_id"),"");
  await selectShared();
  assert.equal((await request("/ai/settings","PUT",{ai_model:"my-new-model"})).status,200);
  assert.equal(settings.getUserAISetting("member","ai_active_shared_profile_id"),"");
  assert.equal(chat.resolveUserChatSettings("member").ai_model,"my-new-model");
});

test("shared IDs cannot be used in personal draft probes to redirect credentials", async () => {
  await selectShared();
  const count = requests.length;
  for (const suffix of ["test-draft","discover-models"]) {
    const response = await request(`/personal/ai-profiles/${suffix}`,"POST",{profileId:sharedId,apiUrl:"https://attacker.example/v1",model:"anything"});
    assert.equal(response.status,404);
  }
  assert.equal(requests.length,count);
});

test("editor and collaboration entrypoints use the member's selected shared model", async () => {
  await selectShared();
  const editor = await request("/ai/chat", "POST", {action:"summarize",text:"Member supplied text"});
  assert.equal(editor.status,200);
  assert.ok((await editor.text()).includes("hello from shared"));
  assert.equal(JSON.parse(String(requests.at(-1)?.init?.body)).model,"rotated-model");
  const collaboration = await request("/reliable/collaboration/compose", "POST", {intent:"capture",input:"Plan the member's work"});
  assert.equal(collaboration.status,200, await collaboration.clone().text());
  assert.equal(JSON.parse(String(requests.at(-1)?.init?.body)).model,"rotated-model");
});

test("shared model access does not grant the member access to another user's notebook", async () => {
  schema.getDb().prepare("INSERT INTO notebooks(id,userId,name) VALUES ('admin-private','admin','Admin secrets')").run();
  const count = requests.length;
  const response = await request("/reliable/collaboration/compose", "POST", {intent:"draft",input:"Read the admin's notes",notebookId:"admin-private"});
  assert.equal(response.status,403);
  assert.equal(requests.length,count);
});
