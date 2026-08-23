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

test("runner isolates execution and kills a timed-out worker", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-plugin-runner-"));
  const mainPath = path.join(directory, "index.mjs");
  fs.writeFileSync(mainPath, `export default { actions: { hello: async ({input}) => ({text:'Hello '+input.name}), hang: async () => new Promise(()=>{}) } };`);
  const record: PluginRegistryRecord = {
    id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: 1,
    runtime: "node-action", main: "index.mjs", source: "dev", trustLevel: "developer",
    status: "enabled", checksum: "test", manifestJson: JSON.stringify(manifest), installedPath: directory,
    installedBy: null, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null,
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

test("schema v93 creates the five isolated plugin tables", async () => {
  const { getDb, closeDb, getDbSchemaVersion } = await import("../src/db/schema");
  const db = getDb();
  assert.equal(getDbSchemaVersion(), 93);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_%' ORDER BY name").all() as Array<{ name: string }>;
  assert.deepEqual(names.map((row) => row.name), ["plugin_executions", "plugin_permissions", "plugin_registry", "plugin_secrets", "plugin_storage"]);
  closeDb();
  fs.rmSync(databaseDirectory, { recursive: true, force: true });
});
