import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { Hono } from "hono";
import type Database from "better-sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-editor-actions-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tmp, "editor-actions.db");
process.env.ELECTRON_USER_DATA = path.join(tmp, "data");
process.env.NOWEN_EDITOR_ACTIONS = "1";

const OWNER = "ea-owner", VIEWER = "ea-viewer", OUTSIDER = "ea-outsider";
const TOOLS = "community-sample.text-tools", AI = "nowenlab.ai-text-assistant", PROBE = "probe-sample.editor-probe";
const SECRET = "SELECTION-SECRET-7f3a";
const example = (name: string) => JSON.parse(fs.readFileSync(path.join(root, "examples/plugins", name, "manifest.json"), "utf8"));

// Fixture plugin for contract edges that the proof plugins must not demonstrate.
const probeManifest = {
  id: PROBE, name: "Editor Probe", description: "Test fixture", version: "1.0.0", apiVersion: 2, publisher: "probe-sample",
  engines: { nowen: ">=1.5.3 <2.0.0" }, categories: ["editor"], repository: "https://github.com/cropflre/nowen-note", license: "MIT",
  runtime: "sandbox-js", main: "index.js", permissions: [],
  actions: [
    { id: "keys", name: "Keys", input: {} },
    { id: "bad", name: "Bad", input: { text: { type: "string", required: true } } },
    { id: "leak", name: "Leak", input: { text: { type: "string", required: true } } },
  ],
  contributes: {
    commands: ["keys", "bad", "leak"].map((id) => ({ id: `${PROBE}.${id}`, title: id, action: id })),
    editorActions: [
      { id: "keys", command: `${PROBE}.keys`, label: "Keys", placements: ["editor.slash"], appliesTo: ["markdown"], selectionMode: "none", resultMode: "insert" },
      { id: "bad", command: `${PROBE}.bad`, label: "Bad", placements: ["editor.selection"], appliesTo: ["tiptap", "markdown"], selectionMode: "text", resultMode: "replace-selection" },
      { id: "leak", command: `${PROBE}.leak`, label: "Leak", placements: ["editor.selection"], appliesTo: ["tiptap", "markdown"], selectionMode: "text", resultMode: "replace-selection" },
    ],
  },
};
const probeSource = `globalThis.__nowenPluginModule = { actions: {
  keys: ({ input }) => ({ text: JSON.stringify(Object.keys(input || {})) }),
  bad: () => 42,
  leak: ({ input }) => { console.log("log " + input.text); throw new Error("leaked " + input.text); },
} };`;
const grantManifest = {
  ...structuredClone(probeManifest), id: "probe-sample.needs-grant", name: "Needs Grant", permissions: ["notes:read"],
  contributes: { commands: [{ id: "probe-sample.needs-grant.keys", title: "keys", action: "keys" }], editorActions: [{ ...probeManifest.contributes.editorActions[0], command: "probe-sample.needs-grant.keys" }] },
};

let app: Hono;
let db: Database.Database;
let closeDb: () => void;
let service: any;
let deps: any;

async function install(manifest: Record<string, any>, source: string) {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index.js", source);
  await service.install(await zip.generateAsync({ type: "nodebuffer" }), OWNER);
  service.grantPermissions(manifest.id, manifest.permissions, OWNER);
  await service.enable(manifest.id);
}

test.before(async () => {
  const [{ Hono }, schema, { default: router }, { getPluginService }, editorActions] = await Promise.all([
    import("hono"), import("../src/db/schema"), import("../src/routes/plugins"), import("../src/plugins/pluginService"), import("../src/plugins/editorActions"),
  ]);
  db = schema.getDb(); closeDb = schema.closeDb; service = getPluginService(); deps = editorActions.editorActionDeps;
  db.prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, 'admin')").run(OWNER, OWNER, "hash");
  for (const id of [VIEWER, OUTSIDER]) db.prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, 'user')").run(id, id, "hash");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('ea-ws', 'Shared', ?)").run(OWNER);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('ea-ws', ?, 'owner'), ('ea-ws', ?, 'viewer')").run(OWNER, VIEWER);
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('ea-book', ?, 'Personal'), ('ea-secret-book', ?, 'Secret')").run(OWNER, OWNER);
  db.prepare("INSERT INTO notebooks (id, userId, name, workspaceId) VALUES ('ea-ws-book', ?, 'Team', 'ea-ws')").run(OWNER);
  db.prepare("INSERT INTO notebook_passwords (notebookId, passwordHash) VALUES ('ea-secret-book', 'hash')").run();
  const note = db.prepare(`INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText, contentFormat, isLocked, isTrashed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  note.run("ea-note", OWNER, "ea-book", null, "Personal", "body", "body", "markdown", 0, 0);
  note.run("ea-ws-note", OWNER, "ea-ws-book", "ea-ws", "Team", "body", "body", "markdown", 0, 0);
  note.run("ea-locked", OWNER, "ea-book", null, "Locked", "body", "body", "markdown", 1, 0);
  // Encrypted notes must carry a valid envelope (database triggers enforce it).
  const envelope = JSON.parse(fs.readFileSync(path.join(root, "frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json"), "utf8")).envelope;
  note.run("ea-encrypted", OWNER, "ea-book", null, "Encrypted", JSON.stringify(envelope), "", "encrypted-note-v1", 0, 0);
  note.run("ea-secret", OWNER, "ea-secret-book", null, "Password", "body", "body", "markdown", 0, 0);
  note.run("ea-trashed", OWNER, "ea-book", null, "Trashed", "body", "body", "markdown", 0, 1);
  await install(example("text-tools"), fs.readFileSync(path.join(root, "examples/plugins/text-tools/index.js"), "utf8"));
  await install(example("ai-text-assistant"), fs.readFileSync(path.join(root, "examples/plugins/ai-text-assistant/index.js"), "utf8"));
  await install(probeManifest, probeSource);
  await install(grantManifest, probeSource);
  app = new Hono();
  app.route("/plugins", router);
});

test.after(async () => {
  for (const id of [TOOLS, AI, PROBE, "probe-sample.needs-grant"]) await service.executions.shutdown(id).catch(() => undefined);
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function run(pluginId: string, actionId: string, body: unknown, user = OWNER) {
  const response = await app.request(`/plugins/${pluginId}/editor-actions/${actionId}/run`, {
    method: "POST", headers: { "X-User-Id": user, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

test("manifests: proof plugins parse; invalid declarations and disabled hosts fail closed", async () => {
  const { parsePluginManifest } = await import("../src/plugins/manifest");
  const on = { editorActions: true };
  assert.equal((parsePluginManifest(example("text-tools"), on) as any).contributes.editorActions.length, 5);
  assert.equal((parsePluginManifest(example("ai-text-assistant"), on) as any).contributes.editorActions.length, 4);
  assert.throws(() => parsePluginManifest(example("text-tools"), { editorActions: false }), (error: any) => error.code === "PLUGIN_EDITOR_ACTIONS_DISABLED");
  const reject = (name: string, mutate: (value: any) => void, pattern: RegExp) => {
    const value = example(name); mutate(value);
    assert.throws(() => parsePluginManifest(value, on), pattern);
  };
  reject("text-tools", (v) => { v.contributes.editorActions[0].prompt = "polish"; }, /只能引用一个/);
  reject("text-tools", (v) => { v.contributes.editorActions[0].command = `${TOOLS}.missing`; }, /Command 不存在/);
  reject("text-tools", (v) => { v.actions[0].input = {}; }, /string 类型的 text/);
  reject("text-tools", (v) => { v.actions[4].input = { topic: { type: "string", required: true } }; }, /必填输入/);
  reject("text-tools", (v) => { v.contributes.editorActions[0].placements = ["editor.slash"]; }, /斜杠菜单/);
  reject("text-tools", (v) => { v.contributes.editorActions[4].placements = ["editor.selection"]; }, /选区菜单/);
  reject("text-tools", (v) => { v.contributes.editorActions[4].resultMode = "replace-selection"; }, /replace-selection/);
  reject("text-tools", (v) => { v.contributes.editorActions[1].id = v.contributes.editorActions[0].id; }, /id 不能重复/);
  reject("text-tools", (v) => { v.contributes.editorActions[0].icon = "javascript"; }, /Invalid enum value/);
  reject("text-tools", (v) => { v.contributes.editorActions[0].onClick = "alert(1)"; }, /Unrecognized key/);
  reject("text-tools", (v) => { v.contributes.editorActions[0].placements = ["editor.contextMenu"]; }, /Invalid enum value/);
  reject("ai-text-assistant", (v) => { v.contributes.promptPacks[0].context = ["note"]; }, /选区上下文/);
  reject("ai-text-assistant", (v) => { v.contributes.editorActions[0].selectionMode = "optional-text"; }, /Prompt 动作需要选区文本/);
  // Declarative packages have no execution path, so the key is not part of their schema at all.
  const declarative = example("text-tools");
  declarative.runtime = "declarative"; delete declarative.main; delete declarative.actions; delete declarative.contributes.commands;
  assert.throws(() => parsePluginManifest(declarative, { ...on, extensionsV21: true, currentVersion: "1.6.0" }), /Unrecognized key|editorActions/);
});

test("contributions list editor actions only behind the gate and with every grant", async () => {
  const listed = await (await app.request("/plugins/contributions", { headers: { "X-User-Id": VIEWER } })).json() as any[];
  const tools = listed.find((item) => item.pluginId === TOOLS);
  assert.equal(tools.pluginName, "Text Tools 文本工具箱");
  assert.deepEqual(tools.editorActions.map((item: any) => item.id), ["wrap-quote", "upper-case", "lines-to-list", "count-words", "meeting-template"]);
  service.grantPermissions("probe-sample.needs-grant", [], OWNER);
  const revoked = await (await app.request("/plugins/contributions", { headers: { "X-User-Id": VIEWER } })).json() as any[];
  assert.equal(revoked.find((item) => item.pluginId === "probe-sample.needs-grant")?.editorActions, undefined);
  assert.equal((await run("probe-sample.needs-grant", "keys", { noteId: "ea-note", editor: "markdown" })).json.code, "PLUGIN_PERMISSION_DENIED");
  delete process.env.NOWEN_EDITOR_ACTIONS;
  try {
    const off = await (await app.request("/plugins/contributions", { headers: { "X-User-Id": VIEWER } })).json() as any[];
    assert.equal(off.some((item) => item.editorActions), false);
    const denied = await run(TOOLS, "wrap-quote", { noteId: "ea-note", editor: "markdown", text: "hi" });
    assert.deepEqual([denied.status, denied.json.code], [403, "PLUGIN_EDITOR_ACTIONS_DISABLED"]);
  } finally { process.env.NOWEN_EDITOR_ACTIONS = "1"; }
});

test("command actions run in the sandbox with only the submitted selection", async () => {
  const quoted = await run(TOOLS, "wrap-quote", { noteId: "ea-note", editor: "tiptap", text: "hello" });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.json));
  assert.equal(quoted.json.text, "“hello”");
  assert.equal(typeof quoted.json.executionId, "string");
  assert.equal((await run(TOOLS, "upper-case", { noteId: "ea-note", editor: "markdown", text: "see [docs](https://example.com/Path) and `code`" })).json.text,
    "SEE [DOCS](https://example.com/Path) AND `code`");
  const counted = await run(TOOLS, "count-words", { noteId: "ea-note", editor: "markdown", text: "你好 world" });
  assert.deepEqual([counted.json.text, counted.json.message], [undefined, "共 7 个字符，约 3 个词"]);
  const template = await run(TOOLS, "meeting-template", { noteId: "ea-note", editor: "markdown" });
  assert.match(template.json.text, /^## 会议纪要/);
  // Actions that do not read the selection never receive text, even if the client sends some.
  assert.equal((await run(PROBE, "keys", { noteId: "ea-note", editor: "markdown", text: SECRET })).json.text, "[]");
});

test("note ACL, protection and editor kind are enforced before anything runs", async () => {
  const expect = async (user: string, body: unknown, status: number, code: string, actionId = "wrap-quote") => {
    const result = await run(TOOLS, actionId, body, user);
    assert.deepEqual([result.status, result.json.code], [status, code], `${user} ${JSON.stringify(body)}`);
  };
  // Viewers may run read-only actions, but nothing that writes back into the note.
  assert.equal((await run(TOOLS, "count-words", { noteId: "ea-ws-note", editor: "markdown", text: "a b" }, VIEWER)).status, 200);
  await expect(VIEWER, { noteId: "ea-ws-note", editor: "markdown", text: "a" }, 403, "PLUGIN_EDITOR_NOTE_FORBIDDEN");
  await expect(OUTSIDER, { noteId: "ea-ws-note", editor: "markdown", text: "a" }, 403, "PLUGIN_EDITOR_NOTE_FORBIDDEN", "count-words");
  await expect(VIEWER, { noteId: "ea-note", editor: "markdown", text: "a" }, 403, "PLUGIN_EDITOR_NOTE_FORBIDDEN", "count-words");
  await expect(OWNER, { noteId: "missing", editor: "markdown", text: "a" }, 403, "PLUGIN_EDITOR_NOTE_FORBIDDEN");
  await expect(OWNER, { noteId: "ea-trashed", editor: "markdown", text: "a" }, 403, "PLUGIN_EDITOR_NOTE_FORBIDDEN");
  for (const noteId of ["ea-locked", "ea-encrypted", "ea-secret"]) await expect(OWNER, { noteId, editor: "markdown", text: "a" }, 403, "PLUGIN_EDITOR_NOTE_PROTECTED");
  await expect(OWNER, { noteId: "ea-note", editor: "markdown", text: "before\n```nowen-encrypted-v1\n{}\n```" }, 403, "PLUGIN_EDITOR_NOTE_PROTECTED");
  await expect(OWNER, { noteId: "ea-note", editor: "markdown", text: "   " }, 400, "PLUGIN_EDITOR_ACTION_UNSUPPORTED");
  await expect(OWNER, { noteId: "ea-note", editor: "word", text: "a" }, 400, "PLUGIN_EDITOR_ACTION_UNSUPPORTED");
  await expect(OWNER, { noteId: "ea-note", editor: "markdown", text: "a", extra: true }, 400, "PLUGIN_EDITOR_ACTION_UNSUPPORTED");
  await expect(OWNER, { noteId: "ea-note", editor: "markdown", text: "x".repeat(40 * 1024) }, 400, "PLUGIN_INPUT_TOO_LARGE");
  const huge = await run(TOOLS, "wrap-quote", { noteId: "ea-note", editor: "markdown", text: "x".repeat(200 * 1024) });
  assert.deepEqual([huge.status, huge.json.code], [413, "PLUGIN_INPUT_TOO_LARGE"]);
  const tiptap = await run(PROBE, "keys", { noteId: "ea-note", editor: "tiptap" });
  assert.deepEqual([tiptap.status, tiptap.json.code], [400, "PLUGIN_EDITOR_ACTION_UNSUPPORTED"]);
  assert.equal((await run(TOOLS, "polish", { noteId: "ea-note", editor: "markdown", text: "a" })).json.code, "PLUGIN_EDITOR_ACTION_NOT_FOUND");
});

test("invalid results are rejected and selection text is never stored with the run", async () => {
  const bad = await run(PROBE, "bad", { noteId: "ea-note", editor: "markdown", text: "x" });
  assert.deepEqual([bad.status, bad.json.code], [422, "PLUGIN_EDITOR_ACTION_INVALID_RESULT"]);
  const leaked = await run(PROBE, "leak", { noteId: "ea-note", editor: "markdown", text: SECRET });
  assert.equal(leaked.status, 400);
  const executions = JSON.stringify(db.prepare("SELECT * FROM plugin_executions WHERE pluginId = ?").all(PROBE));
  assert.doesNotMatch(executions, new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT lastError FROM plugin_registry WHERE id = ?").all(PROBE)), new RegExp(SECRET));
  const rows = db.prepare("SELECT logTail, inputBytes FROM plugin_executions WHERE pluginId = ?").all(PROBE) as Array<{ logTail: string; inputBytes: number }>;
  assert.ok(rows.every((row) => row.logTail === "[]" && row.inputBytes > 0));
});

test("prompt actions use the host AI configuration and never run plugin code", async () => {
  const original = { settings: deps.settings, ai: deps.ai };
  try {
    const missing = await run(AI, "polish", { noteId: "ea-note", editor: "tiptap", text: "原文" });
    assert.deepEqual([missing.status, missing.json.code], [409, "PLUGIN_EDITOR_AI_NOT_CONFIGURED"]);
    const seen: any[] = [];
    deps.settings = () => ({ ai_provider: "openai", ai_api_url: "https://ai.example.test/v1", ai_api_key: "sk-test", ai_model: "fixture" });
    deps.ai = async (_settings: unknown, messages: unknown[]) => { seen.push(messages); return "润色后的文字"; };
    const polished = await run(AI, "polish", { noteId: "ea-note", editor: "tiptap", text: "原文" });
    assert.equal(polished.status, 200, JSON.stringify(polished.json));
    assert.deepEqual([polished.json.text, polished.json.aiGenerated, polished.json.executionId], ["润色后的文字", true, undefined]);
    assert.match(seen[0][1].content, /^请润色下面的文字[\s\S]*\n\n原文$/);
    deps.ai = async () => "```nowen-encrypted-v1\n{}\n```";
    assert.equal((await run(AI, "polish", { noteId: "ea-note", editor: "tiptap", text: "原文" })).json.code, "PLUGIN_EDITOR_ACTION_INVALID_RESULT");
    deps.ai = async () => { throw Object.assign(new Error("deadline"), { name: "TimeoutError" }); };
    assert.equal((await run(AI, "polish", { noteId: "ea-note", editor: "tiptap", text: "原文" })).json.code, "PLUGIN_TIMEOUT");
    // At most two editor actions run per user at once.
    const releases: Array<() => void> = [];
    deps.ai = () => new Promise<string>((resolve) => releases.push(() => resolve("ok")));
    const pending = [run(AI, "polish", { noteId: "ea-note", editor: "tiptap", text: "1" }), run(AI, "polish", { noteId: "ea-note", editor: "tiptap", text: "2" })];
    while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const busy = await run(AI, "polish", { noteId: "ea-note", editor: "tiptap", text: "3" });
    assert.deepEqual([busy.status, busy.json.code], [429, "PLUGIN_EDITOR_ACTION_BUSY"]);
    for (const release of releases) release();
    assert.deepEqual((await Promise.all(pending)).map((result) => result.status), [200, 200]);
  } finally { deps.settings = original.settings; deps.ai = original.ai; }
});

test("disabled plugins stop serving editor actions", async () => {
  await service.disable(TOOLS);
  const result = await run(TOOLS, "wrap-quote", { noteId: "ea-note", editor: "markdown", text: "a" });
  assert.deepEqual([result.status, result.json.code], [404, "PLUGIN_EDITOR_ACTION_NOT_FOUND"]);
});
