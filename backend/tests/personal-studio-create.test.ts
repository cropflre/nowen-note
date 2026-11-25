import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { getDb } from "../src/db/schema.js";
import { setUserAISettings } from "../src/services/user-ai-settings.js";
import { createPersonalStudioApp, parsePersonalAppSpec } from "../src/plugins/personalStudioApps.js";
import pluginsRouter from "../src/routes/plugins.js";
// The create page's template library is front-end data; import it directly so this contract can't drift.
import { newStudioSpec, STUDIO_TEMPLATES } from "../../frontend/src/lib/personalApps.js";
import { enExtensionCenterTranslations, zhCNExtensionCenterTranslations } from "../../frontend/src/i18n/extensionCenterTranslations.js";

// Create-app entry (Extension Platform Phase 4): the page asks whether Studio AI can run before it
// offers an AI prompt, so users without a model get templates instead of a request that can only fail.
const secretKey = "studio-status-fake-key-never-use";
const secretUrl = "http://127.0.0.1:9/studio-status-private-endpoint";

test("ai-status reports only whether Studio AI can run, with the same rule the preview enforces", async () => {
  const db = getDb();
  for (const user of ["status-alice", "status-bob", "status-carol", "status-dave"]) {
    db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,?)").run(user, user, "hash", "user");
  }
  setUserAISettings("status-alice", [
    { key: "ai_provider", value: "openai" }, { key: "ai_api_url", value: secretUrl },
    { key: "ai_api_key", value: secretKey }, { key: "ai_model", value: "status-private-model" },
  ]);
  // Local providers need no key.
  setUserAISettings("status-carol", [
    { key: "ai_provider", value: "ollama" }, { key: "ai_api_url", value: secretUrl }, { key: "ai_model", value: "status-private-model" },
  ]);
  setUserAISettings("status-dave", [
    { key: "ai_provider", value: "openai" }, { key: "ai_api_url", value: secretUrl },
    { key: "ai_api_key", value: secretKey }, { key: "ai_model", value: "status-private-model" }, { key: "ai_manual_enabled", value: "false" },
  ]);
  const app = new Hono();
  app.route("/api/plugins", pluginsRouter);
  const headers = (user?: string, authMode?: string) => ({
    ...(user ? { "X-User-Id": user } : {}), ...(authMode ? { "X-Auth-Mode": authMode } : {}), "Content-Type": "application/json",
  });
  const status = (user?: string, authMode?: string) => app.request("/api/plugins/personal-apps/ai-status", { headers: headers(user, authMode) });

  const available = await status("status-alice");
  assert.equal(available.status, 200, await available.clone().text());
  assert.equal(available.headers.get("Cache-Control"), "no-store");
  const body = await available.text();
  assert.deepEqual(JSON.parse(body), { available: true });
  for (const secret of [secretKey, secretUrl, "status-private-model", "openai"]) assert.ok(!body.includes(secret), `must not reveal ${secret}`);

  assert.deepEqual(await (await status("status-bob")).json(), { available: false, code: "STUDIO_AI_NOT_CONFIGURED" });
  assert.deepEqual(await (await status("status-carol")).json(), { available: true });
  assert.deepEqual(await (await status("status-dave")).json(), { available: false, code: "STUDIO_AI_UNAVAILABLE" });

  // The preview refuses exactly the users the status reports as unavailable.
  const preview = (user: string) => app.request("/api/plugins/personal-apps/ai-preview", { method: "POST", headers: headers(user), body: JSON.stringify({ instruction: "A reading log" }) });
  assert.equal(((await (await preview("status-bob")).json()) as { code: string }).code, "STUDIO_AI_NOT_CONFIGURED");
  assert.equal(((await (await preview("status-dave")).json()) as { code: string }).code, "STUDIO_AI_UNAVAILABLE");

  // Same actor rules as every Personal Studio route: no API tokens, no anonymous callers.
  assert.equal((await status("status-alice", "api-token")).status, 403);
  assert.notEqual((await status()).status, 200);
});

test("ai-status is not read as an app id, and app routes still resolve", async () => {
  const db = getDb();
  db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,?)").run("status-erin", "status-erin", "hash", "user");
  const app = new Hono();
  app.route("/api/plugins", pluginsRouter);
  const headers = { "X-User-Id": "status-erin", "Content-Type": "application/json" };
  const created = await app.request("/api/plugins/personal-apps", { method: "POST", headers, body: JSON.stringify({
    schemaVersion: 1, name: "Reading log", description: "", layout: "list", fields: [{ id: "title", label: "Title", type: "text" }], items: [],
  }) });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json() as { id: string };
  assert.deepEqual(await (await app.request("/api/plugins/personal-apps/ai-status", { headers })).json(), { available: false, code: "STUDIO_AI_NOT_CONFIGURED" });
  const loaded = await app.request(`/api/plugins/personal-apps/${id}`, { headers });
  assert.equal(loaded.status, 200);
  assert.equal(((await loaded.json()) as { spec: { name: string } }).spec.name, "Reading log");
});

test("every template of the create page is a valid, savable Studio app in both languages", () => {
  const db = getDb();
  db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,?)").run("status-templates", "status-templates", "hash", "user");
  const translator = (tree: Record<string, unknown>) => (key: string) => {
    const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
    if (typeof value !== "string") throw new Error(`missing translation ${key}`);
    return value;
  };
  const languages = [["zh-CN", zhCNExtensionCenterTranslations], ["en", enExtensionCenterTranslations]] as const;
  assert.equal(STUDIO_TEMPLATES.length, 7);
  for (const [language, tree] of languages) {
    for (const { id } of STUDIO_TEMPLATES) {
      const spec = newStudioSpec(id, translator(tree));
      // The server accepts the draft exactly as the editor shows it: nothing trimmed, renamed or dropped.
      assert.deepEqual(parsePersonalAppSpec(spec), spec, `${language}/${id}`);
      assert.deepEqual(createPersonalStudioApp(db, "status-templates", spec).spec, spec, `${language}/${id}`);
    }
  }
});
