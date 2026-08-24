import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-extension-rc1-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(databaseDirectory, "extension-rc1.test.db");

function signDocument(document: Record<string, unknown>, privateKey: crypto.KeyObject, canonicalJson: (value: unknown) => string) {
  const signature = crypto.sign(null, Buffer.from(canonicalJson(document)), privateKey).toString("base64");
  return { ...document, signature };
}

test("RC1 sandbox hides executable host globals and constructor escape paths", async () => {
  const [{ SandboxRunner }, { ExecutionLogTail }] = await Promise.all([
    import("../src/plugins/sandboxRunner"),
    import("../src/plugins/logs"),
  ]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-rc1-sandbox-"));
  const manifest = {
    id: "rc1.escape", publisher: "rc1", name: "Escape", description: "RC1", version: "1.0.0", apiVersion: 2 as const,
    engines: { nowen: ">=1.5.0 <2.0.0" }, runtime: "sandbox-js" as const, main: "index.js", categories: ["productivity"],
    repository: "https://github.com/example/escape", license: "MIT", permissions: [],
    actions: [{ id: "probe", name: "Probe" }],
  };
  fs.writeFileSync(path.join(directory, "index.js"), `globalThis.__nowenPluginModule={actions:{probe:async()=>({success:true,data:[typeof process,typeof require,typeof fetch,typeof Buffer,typeof WebSocket,typeof XMLHttpRequest,typeof module,typeof exports,typeof eval,typeof Function,typeof (()=>{}).constructor,typeof (async()=>{}).constructor]})}}`);
  const record = {
    id: manifest.id, name: manifest.name, version: manifest.version, apiVersion: 2 as const, runtime: "sandbox-js" as const,
    main: "index.js", source: "dev" as const, trustLevel: "developer" as const, status: "enabled" as const,
    checksum: "test", manifestJson: JSON.stringify(manifest), installedPath: directory, installedBy: null,
    installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, previousVersion: null,
  };
  const runner = new SandboxRunner(record as any, async () => null);
  try {
    await runner.preflight();
    const result = await runner.execute({ executionId: "rc1-escape", pluginId: manifest.id, actionId: "probe", userId: "u", workspaceId: null }, {}, 2000, new ExecutionLogTail());
    assert.deepEqual(result, { success: true, data: Array(12).fill("undefined") });
  } finally {
    await runner.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("RC1 external.fetch blocks local, metadata, IPv6 and credential-confusion targets before I/O", async () => {
  const { secureExternalFetch } = await import("../src/plugins/secureExternalFetch");
  const options = {
    allowedHosts: ["127.0.0.1", "169.254.169.254", "[::1]", "[::ffff:127.0.0.1]"],
    timeoutMs: 500,
    maxRedirects: 2,
    maxResponseBytes: 1024,
  };
  const denied = [
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
  ];
  for (const url of denied) {
    await assert.rejects(() => secureExternalFetch({ url }, options), (error: any) => error?.code === "EXTERNAL_FETCH_DENIED");
  }
  await assert.rejects(
    () => secureExternalFetch({ url: "https://user@127.0.0.1/" }, options),
    (error: any) => error?.code === "EXTERNAL_FETCH_INVALID_URL",
  );
  await assert.rejects(
    () => secureExternalFetch({ url: "https://127.0.0.1/#secret" }, options),
    (error: any) => error?.code === "EXTERNAL_FETCH_INVALID_URL",
  );
});

test("RC1 Registry metadata rejects rollback, equivocation and time rollback", async () => {
  const [{ RegistryMetadataGuard }, { canonicalJson }, { getDb }] = await Promise.all([
    import("../src/plugins/registryMetadataGuard"),
    import("../src/plugins/signatures"),
    import("../src/db/schema"),
  ]);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const sourceId = `rc1-${crypto.randomUUID()}`;
  const guard = new RegistryMetadataGuard();
  const base = {
    protocolVersion: 2,
    sequence: 10,
    generatedAt: "2026-08-24T06:00:00.000Z",
    expiresAt: "2030-08-24T06:00:00.000Z",
    signerKeyId: "root-1",
    extensions: [],
  };
  const current = signDocument(base, privateKey, canonicalJson);
  const verified = guard.validate(sourceId, current as any, publicPem, Date.parse("2026-08-24T07:00:00.000Z"));
  guard.persist(verified, "2026-08-24T07:00:00.000Z");
  assert.ok(getDb().prepare("SELECT 1 FROM plugin_registry_metadata_state WHERE sourceId=?").get(sourceId));

  const rollback = signDocument({ ...base, sequence: 9 }, privateKey, canonicalJson);
  assert.throws(() => guard.validate(sourceId, rollback as any, publicPem, Date.parse("2026-08-24T07:00:00.000Z")),
    (error: any) => error?.code === "REGISTRY_METADATA_ROLLBACK");

  const equivocation = signDocument({ ...base, extensions: [{ id: "evil.changed" }] }, privateKey, canonicalJson);
  assert.throws(() => guard.validate(sourceId, equivocation as any, publicPem, Date.parse("2026-08-24T07:00:00.000Z")),
    (error: any) => error?.code === "REGISTRY_METADATA_EQUIVOCATION");

  const timeRollback = signDocument({ ...base, sequence: 11, generatedAt: "2026-08-24T05:59:59.000Z" }, privateKey, canonicalJson);
  assert.throws(() => guard.validate(sourceId, timeRollback as any, publicPem, Date.parse("2026-08-24T07:00:00.000Z")),
    (error: any) => error?.code === "REGISTRY_METADATA_TIME_ROLLBACK");
});

test("RC1 unknown Official Registry fails closed without compiled trust root", async () => {
  const { RegistryTrust } = await import("../src/plugins/registryTrust");
  const trust = new RegistryTrust();
  assert.throws(() => trust.assertSourceConfigured({
    id: `unknown-official-${crypto.randomUUID()}`,
    official: true,
    registryKeyId: null,
    registryPublicKey: null,
  }), (error: any) => error?.code === "OFFICIAL_REGISTRY_TRUST_ROOT_MISSING");
});

test.after(async () => {
  try {
    const { closeDb } = await import("../src/db/schema");
    closeDb();
  } finally {
    fs.rmSync(databaseDirectory, { recursive: true, force: true });
  }
});
