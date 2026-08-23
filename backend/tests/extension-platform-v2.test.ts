import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { parsePluginManifest } from "../src/plugins/manifest";
import { canonicalJson, verifyArtifactSignature, verifySignedDocument } from "../src/plugins/signatures";
import { SandboxRunner } from "../src/plugins/sandboxRunner";
import { ExecutionLogTail } from "../src/plugins/logs";
import { HostApiBroker } from "../src/plugins/hostApiBroker";
import type { PluginManifestV2, PluginRegistryRecord } from "../src/plugins/types";

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-extension-v2-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(databaseDirectory, "extension-v2.test.db");

const manifest: PluginManifestV2 = {
  id: "acme.hello", publisher: "acme", name: "Hello", description: "V2 test", version: "1.0.0", apiVersion: 2,
  engines: { nowen: ">=1.5.0 <2.0.0" }, runtime: "sandbox-js", main: "index.js", categories: ["productivity"],
  repository: "https://github.com/acme/hello", license: "MIT", permissions: [],
  actions: [{ id: "hello", name: "Hello", input: { name: { type: "string" } } }],
  contributes: { commands: [{ id: "acme.hello.run", title: "Run", action: "hello" }], menus: [{ location: "commandPalette", command: "acme.hello.run" }] },
};

test("Manifest V2 is strict, namespace-bound and contribution-safe while V1 remains supported", () => {
  assert.equal(parsePluginManifest(manifest).apiVersion, 2);
  assert.throws(() => parsePluginManifest({ ...manifest, id: "other.hello" }), /Publisher namespace/);
  assert.throws(() => parsePluginManifest({ ...manifest, unknown: true }), /unrecognized/i);
  assert.throws(() => parsePluginManifest({ ...manifest, contributes: { commands: [{ id: "acme.hello.bad", title: "Bad", action: "missing" }] } }), /Action 不存在/);
  assert.equal(parsePluginManifest({ id: "com.example.legacy", name: "Legacy", description: "", version: "1.0.0", apiVersion: 1, engines: { nowen: ">=1.5.0 <2.0.0" }, runtime: "node-action", main: "index.mjs", permissions: [], actions: [{ id: "run", name: "Run" }] }).apiVersion, 1);
});

test("Ed25519 verifies canonical registry documents and artifact digests and rejects tampering", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const bytes = Buffer.from("signed artifact"); const digest = crypto.createHash("sha256").update(bytes).digest();
  const artifactSignature = crypto.sign(null, digest, privateKey).toString("base64");
  assert.equal(verifyArtifactSignature(bytes, artifactSignature, publicKey.export({ type: "spki", format: "pem" }).toString()), true);
  assert.equal(verifyArtifactSignature(Buffer.from("tampered"), artifactSignature, publicKey.export({ type: "spki", format: "pem" }).toString()), false);
  const document = { protocolVersion: 2, extensions: [{ id: "acme.hello", version: "1.0.0" }] };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(document)), privateKey).toString("base64");
  assert.equal(verifySignedDocument({ ...document, signature }, signature, publicKey.export({ type: "spki", format: "pem" }).toString()), true);
  assert.equal(verifySignedDocument({ ...document, extensions: [], signature }, signature, publicKey.export({ type: "spki", format: "pem" }).toString()), false);
});

function record(directory: string): PluginRegistryRecord {
  return { id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: 2, runtime: "sandbox-js", main: "index.js", source: "dev", trustLevel: "developer", status: "enabled", checksum: "test", manifestJson: JSON.stringify(manifest), installedPath: directory, installedBy: null, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, previousVersion: null };
}

test("QuickJS sandbox hides Node/browser globals and bridges only the broker", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sandbox-v2-"));
  fs.writeFileSync(path.join(directory, "index.js"), `globalThis.__nowenPluginModule={actions:{hello:async({input,nowen})=>({success:true,data:{name:input.name,globals:[typeof process,typeof require,typeof fetch],caps:await nowen.runtime.capabilities()}})}}`);
  const runner = new SandboxRunner(record(directory), async (_context, call) => call.method === "runtime.capabilities" ? { runtime: "sandbox-js" } : null);
  try {
    await runner.preflight();
    const result = await runner.execute({ executionId: "sandbox-one", pluginId: manifest.id, actionId: "hello", userId: "u", workspaceId: null }, { name: "Nowen" }, 2000, new ExecutionLogTail());
    assert.deepEqual(result, { success: true, data: { name: "Nowen", globals: ["undefined", "undefined", "undefined"], caps: { runtime: "sandbox-js" } } });
  } finally { await runner.terminate(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("QuickJS sandbox interrupts infinite loops", async () => {
  const QuickJS = await getQuickJS(); const runtime = QuickJS.newRuntime(); const vm = runtime.newContext();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 50));
  try { const result = vm.evalCode("while(true){}"); assert.ok(result.error); if (result.error) { assert.match(String((vm.dump(result.error) as any).message), /interrupted/); result.error.dispose(); } }
  finally { vm.dispose(); runtime.dispose(); }
});

test("sandbox enforces the recursive Host API call ceiling", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sandbox-calls-"));
  fs.writeFileSync(path.join(directory, "index.js"), `globalThis.__nowenPluginModule={actions:{hello:async({nowen})=>{for(let i=0;i<1001;i++)await nowen.runtime.capabilities();return {success:true}}}}`);
  const runner = new SandboxRunner(record(directory), async () => ({ runtime: "sandbox-js" }));
  try { await assert.rejects(() => runner.execute({ executionId: "sandbox-calls", pluginId: manifest.id, actionId: "hello", userId: "u", workspaceId: null }, {}, 5000, new ExecutionLogTail()), /调用次数超过限制/); }
  finally { await runner.terminate(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("external.fetch rejects raw/private network targets before network access", async () => {
  const permissions = { require: () => ({ configJson: JSON.stringify({ hosts: ["localhost", "169.254.169.254"] }) }) };
  const broker = new HostApiBroker(permissions as any);
  const context = { executionId: "ssrf", pluginId: manifest.id, actionId: "hello", userId: "u", workspaceId: null };
  await assert.rejects(() => broker.call(context, { method: "external.fetch", args: { url: "http://localhost/" } }), (error: any) => error.code === "EXTERNAL_FETCH_DENIED");
  await assert.rejects(() => broker.call(context, { method: "external.fetch", args: { url: "https://169.254.169.254/latest/meta-data" } }), (error: any) => error.code === "EXTERNAL_FETCH_DENIED");
});

test("schema v96 and enterprise policy default community V2 to sandbox", async () => {
  const { getDb, getDbSchemaVersion, closeDb } = await import("../src/db/schema");
  const { ExtensionPolicy } = await import("../src/plugins/extensionPolicy");
  assert.equal(getDbSchemaVersion(), 96);
  assert.ok(getDb().prepare("SELECT 1 FROM plugin_sources").all());
  const policy = new ExtensionPolicy();
  assert.throws(() => policy.assertAllowed({ ...manifest, runtime: "node-action", main: "index.mjs" }, "community", "registry"), (error: any) => error.code === "PLUGIN_POLICY_DENIED");
  policy.set({ allowNodeRuntime: false }, "admin");
  assert.throws(() => policy.assertAllowed({ ...manifest, runtime: "node-action", main: "index.mjs" }, "verified", "registry"), /禁止 Node Runtime/);
  closeDb(); fs.rmSync(databaseDirectory, { recursive: true, force: true });
});
