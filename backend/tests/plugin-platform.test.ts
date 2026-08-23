import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { parsePluginManifest, validateActionInput } from "../src/plugins/manifest";
import { validatePluginPackage } from "../src/plugins/packageValidator";
import { ExecutionLogTail } from "../src/plugins/logs";
import { PluginRunner } from "../src/plugins/runner";
import type { PluginRegistryRecord } from "../src/plugins/types";

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-plugin-platform-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(databaseDirectory, "plugin-platform.test.db");

const manifest = {
  id: "com.example.hello",
  name: "Hello",
  description: "test",
  version: "1.0.0",
  apiVersion: 1 as const,
  engines: { nowen: ">=1.5.0 <2.0.0" },
  runtime: "node-action" as const,
  main: "dist/index.mjs",
  permissions: [],
  actions: [{ id: "hello", name: "Hello", input: { name: { type: "string" as const, required: true } } }],
};

test("Manifest V1 rejects main path escape and undeclared permissions", () => {
  assert.throws(() => parsePluginManifest({ ...manifest, main: "../index.mjs" }), /main/);
  assert.throws(() => parsePluginManifest({ ...manifest, permissions: ["database:write"] }), /Invalid enum value/);
});

test("Action input validates required, type and unknown fields", () => {
  const parsed = parsePluginManifest(manifest);
  assert.throws(() => validateActionInput(parsed.actions[0], {}), /缺少必填参数/);
  assert.throws(() => validateActionInput(parsed.actions[0], { name: 1 }), /应为 string/);
  assert.throws(() => validateActionInput(parsed.actions[0], { name: "A", extra: true }), /未知参数/);
  assert.deepEqual(validateActionInput(parsed.actions[0], { name: "A" }), { name: "A" });
});

test("community registry validates metadata and rejects checksum mismatch", async () => {
  const { validateRegistryCatalog, verifyRegistryChecksum } = await import("../src/plugins/communityRegistry");
  const catalog = validateRegistryCatalog({ plugins: [{
    id: "com.example.hello", name: "Hello", latestVersion: "1.0.0", versions: [{
      version: "1.0.0", download: "https://example.com/hello.nowen-plugin", sha256: "a".repeat(64), nowen: ">=1.5.0 <2.0.0",
    }],
  }] });
  assert.equal(catalog[0].trustLevel, "community");
  assert.throws(() => verifyRegistryChecksum(Buffer.from("different"), "a".repeat(64)), (error: any) => error.code === "REGISTRY_CHECKSUM_MISMATCH");
});

test("package validation rejects Zip Slip and native addons", async () => {
  const slipping = new JSZip();
  slipping.file("../evil.mjs", "export default {};");
  slipping.file("manifest.json", JSON.stringify(manifest));
  slipping.file("dist/index.mjs", "export default {actions:{hello(){}}};");
  const slippingBytes = Buffer.from(await slipping.generateAsync({ type: "uint8array" }));
  await assert.rejects(() => validatePluginPackage(slippingBytes), /非法 ZIP 路径|路径穿越/);

  const native = new JSZip();
  native.file("manifest.json", JSON.stringify(manifest));
  native.file("dist/index.mjs", "export default {actions:{hello(){}}};");
  native.file("dist/addon.node", "binary");
  const nativeBytes = Buffer.from(await native.generateAsync({ type: "uint8array" }));
  await assert.rejects(() => validatePluginPackage(nativeBytes), /禁止文件/);
});

test("streaming validation rejects a ZIP bomb before JSZip extraction", async () => {
  const bomb = new JSZip();
  bomb.file("manifest.json", JSON.stringify(manifest));
  bomb.file("dist/index.mjs", "export default {actions:{hello(){}}};");
  bomb.file("payload.txt", Buffer.alloc(51 * 1024 * 1024));
  const bytes = Buffer.from(await bomb.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } }));
  assert.ok(bytes.length < 1024 * 1024);
  await assert.rejects(() => validatePluginPackage(bytes), /超过 50MB|压缩比异常/);
});

test("preflight rejects Manifest actions missing from runtime", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-plugin-preflight-"));
  fs.writeFileSync(path.join(directory, "index.mjs"), "export default {actions:{hello(){return {text:'ok'}}}};");
  const mismatchManifest = { ...manifest, main: "index.mjs", actions: [...manifest.actions, { id: "missing", name: "Missing", input: {} }] };
  const record: PluginRegistryRecord = {
    id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: 1, runtime: "node-action", main: "index.mjs",
    source: "dev", trustLevel: "developer", status: "quarantined", checksum: "test", manifestJson: JSON.stringify(mismatchManifest),
    installedPath: directory, installedBy: null, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, previousVersion: null,
  };
  const runner = new PluginRunner(record, async () => null);
  try { await assert.rejects(() => runner.preflight(), /Manifest Action 未实现/); }
  finally { await runner.terminate(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("runner isolates execution and kills a timed-out worker", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-plugin-runner-"));
  const mainPath = path.join(directory, "index.mjs");
  fs.writeFileSync(mainPath, `export default { actions: { hello: async ({input}) => ({text:'Hello '+input.name}), hang: async () => new Promise(()=>{}) } };`);
  const record: PluginRegistryRecord = {
    id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: 1,
    runtime: "node-action", main: "index.mjs", source: "dev", trustLevel: "developer",
    status: "enabled", checksum: "test", manifestJson: JSON.stringify(manifest), installedPath: directory,
    installedBy: null, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, previousVersion: null,
  };
  const runner = new PluginRunner(record, async () => null);
  try {
    const result = await runner.execute({ executionId: "one", pluginId: record.id, actionId: "hello", userId: "u", workspaceId: null }, { name: "Nowen" }, 2000, new ExecutionLogTail());
    assert.deepEqual(result, { text: "Hello Nowen" });
    await assert.rejects(() => runner.execute({ executionId: "two", pluginId: record.id, actionId: "hang", userId: "u", workspaceId: null }, {}, 100, new ExecutionLogTail()), /执行超时/);
    const recovered = await runner.execute({ executionId: "three", pluginId: record.id, actionId: "hello", userId: "u", workspaceId: null }, { name: "Again" }, 2000, new ExecutionLogTail());
    assert.deepEqual(recovered, { text: "Hello Again" });
  } finally {
    await runner.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v96 creates versioned plugin, automation and ecosystem tables", async () => {
  const { getDb, closeDb, getDbSchemaVersion } = await import("../src/db/schema");
  const { PluginExecutionManager } = await import("../src/plugins/executionManager");
  const { HostApiBroker } = await import("../src/plugins/hostApiBroker");
  const db = getDb();
  assert.equal(getDbSchemaVersion(), 96);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_%' ORDER BY name").all() as Array<{ name: string }>;
  assert.deepEqual(names.map((row) => row.name), ["plugin_executions", "plugin_permissions", "plugin_policy", "plugin_registry", "plugin_secrets", "plugin_security_state", "plugin_settings", "plugin_sources", "plugin_storage", "plugin_trust_records", "plugin_update_state", "plugin_versions"]);
  const executionColumns = db.prepare("PRAGMA table_info(plugin_executions)").all() as Array<{ name: string }>;
  assert.ok(executionColumns.some((column) => column.name === "progressCurrent"));
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO plugin_registry(id,name,version,apiVersion,runtime,main,source,trustLevel,status,checksum,manifestJson,installedPath,installedAt,updatedAt)
    VALUES ('com.example.recovery','Recovery','1.0.0',1,'node-action','index.mjs','dev','developer','enabled','x',?,'x',?,?)`)
    .run(JSON.stringify(manifest), timestamp, timestamp);
  const insertExecution = db.prepare(`INSERT INTO plugin_executions(id,pluginId,actionId,userId,status,startedAt,inputBytes,outputBytes,logTail)
    VALUES (?,'com.example.recovery','hello','u',?,?,0,0,'[]')`);
  insertExecution.run("queued-before-restart", "queued", timestamp);
  insertExecution.run("running-before-restart", "running", timestamp);
  const manager = new PluginExecutionManager(new HostApiBroker());
  assert.equal((manager.get("queued-before-restart") as any).errorCode, "HOST_RESTARTED");
  assert.equal((manager.get("running-before-restart") as any).status, "interrupted");
  insertExecution.run("queued-cancel", "queued", timestamp);
  assert.equal(manager.cancel("queued-cancel"), true);
  assert.equal((manager.get("queued-cancel") as any).status, "cancelled");
  closeDb();
  fs.rmSync(databaseDirectory, { recursive: true, force: true });
});
