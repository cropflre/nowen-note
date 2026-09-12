import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-declarative-extension-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(databaseDirectory, "declarative-extension.test.db");
delete process.env.NOWEN_EXTENSIONS_V21;

const declarativeManifest = {
  id: "acme.productivity-pack",
  publisher: "acme",
  name: "Productivity Pack",
  description: "Zero-code V2.1 contribution pack",
  version: "1.0.0",
  apiVersion: 2 as const,
  engines: { nowen: ">=1.6.0 <2.0.0" },
  runtime: "declarative" as const,
  categories: ["productivity"],
  repository: "https://github.com/acme/productivity-pack",
  license: "MIT",
  permissions: [] as [],
  contributes: {
    automationTemplates: [{ id: "daily-review", title: "Daily Review", file: "templates/daily-review.json" }],
  },
};

const parseOptions = { extensionsV21: true, currentVersion: "1.6.0" } as const;

async function modules() {
  const [manifestModule, validatorModule, registryModule, lifecycleModule, executionModule, brokerModule, schemaModule] = await Promise.all([
    import("../src/plugins/manifest"),
    import("../src/plugins/packageValidator"),
    import("../src/plugins/registry"),
    import("../src/plugins/pluginLifecycle"),
    import("../src/plugins/executionManager"),
    import("../src/plugins/hostApiBroker"),
    import("../src/db/schema"),
  ]);
  return { manifestModule, validatorModule, registryModule, lifecycleModule, executionModule, brokerModule, schemaModule };
}

test("declarative manifest is feature-gated, engine-gated and executable-field-free", async () => {
  const { manifestModule } = await modules();
  assert.throws(
    () => manifestModule.parsePluginManifest(declarativeManifest, { extensionsV21: false, currentVersion: "1.6.0" }),
    (error: any) => error?.code === "PLUGIN_V21_FEATURE_DISABLED",
  );

  const parsed = manifestModule.parsePluginManifest(declarativeManifest, parseOptions);
  assert.equal(parsed.apiVersion, 2);
  assert.equal(parsed.runtime, "declarative");
  assert.equal("main" in parsed, false);
  assert.equal("actions" in parsed, false);
  assert.deepEqual(parsed.permissions, []);

  assert.throws(
    () => manifestModule.parsePluginManifest({ ...declarativeManifest, engines: { nowen: ">=1.5.0 <2.0.0" } }, parseOptions),
    (error: any) => error?.code === "PLUGIN_NOWEN_INCOMPATIBLE",
  );
  for (const extra of [
    { main: "index.js" },
    { actions: [{ id: "run", name: "Run" }] },
    { connections: [{ id: "api", name: "API", type: "bearer" }] },
    { events: ["note.created"] },
    { eventHandlers: [{ event: "note.created", action: "run" }] },
  ]) {
    assert.throws(() => manifestModule.parsePluginManifest({ ...declarativeManifest, ...extra }, parseOptions));
  }
  assert.throws(() => manifestModule.parsePluginManifest({ ...declarativeManifest, permissions: ["notes:read"] }, parseOptions));
  assert.throws(
    () => manifestModule.parsePluginManifest({ ...declarativeManifest, permissionConfig: { externalFetchHosts: ["example.com"] } }, parseOptions),
    /权限配置/,
  );
  assert.throws(
    () => manifestModule.parsePluginManifest({
      ...declarativeManifest,
      contributes: { settings: [{ key: "token", title: "Token", type: "string", secret: true }] },
    }, parseOptions),
    /Secret Setting/,
  );
});

test("declarative package needs no main and rejects executable code assets", async () => {
  const { validatorModule } = await modules();
  const clean = new JSZip();
  clean.file("manifest.json", JSON.stringify(declarativeManifest));
  clean.file("templates/daily-review.json", JSON.stringify({ name: "Daily Review", definition: { steps: [] } }));
  const cleanBytes = Buffer.from(await clean.generateAsync({ type: "uint8array" }));
  const validated = await validatorModule.validatePluginPackage(cleanBytes, parseOptions);
  assert.equal(validated.manifest.runtime, "declarative");
  assert.equal(validated.fileCount, 2);

  const executable = new JSZip();
  executable.file("manifest.json", JSON.stringify(declarativeManifest));
  executable.file("templates/daily-review.json", JSON.stringify({ name: "Daily Review", definition: { steps: [] } }));
  executable.file("index.js", "globalThis.__nowenPluginModule = {};");
  const executableBytes = Buffer.from(await executable.generateAsync({ type: "uint8array" }));
  await assert.rejects(
    () => validatorModule.validatePluginPackage(executableBytes, parseOptions),
    (error: any) => error?.code === "PLUGIN_CONTRIBUTION_INVALID" && /禁止可执行代码资源/.test(error.message),
  );
});

test("declarative registry persists an internal empty main and reaches stable without a runner action", async () => {
  const { manifestModule, registryModule, lifecycleModule, executionModule, brokerModule, schemaModule } = await modules();
  const parsed = manifestModule.parsePluginManifest(declarativeManifest, parseOptions);
  const installedPath = fs.mkdtempSync(path.join(databaseDirectory, "installed-"));
  fs.writeFileSync(path.join(installedPath, "manifest.json"), JSON.stringify(parsed));

  const registry = new registryModule.PluginRegistry();
  const record = registry.upsert({
    manifest: parsed,
    source: "dev",
    trustLevel: "developer",
    status: "quarantined",
    checksum: "declarative-checksum",
    installedPath,
    installedBy: "admin",
  });
  assert.equal(record.runtime, "declarative");
  assert.equal(record.main, "");
  const persistedManifest = JSON.parse(record.manifestJson);
  assert.equal("main" in persistedManifest, false);
  assert.equal("actions" in persistedManifest, false);
  assert.deepEqual(persistedManifest.permissions, []);

  const executions = new executionModule.PluginExecutionManager(new brokerModule.HostApiBroker(), registry);
  await assert.rejects(
    () => executions.execute({
      pluginId: record.id,
      actionId: "anything",
      userId: "u1",
      workspaceId: null,
      actionInput: {},
      timeoutMs: 1000,
    }),
    (error: any) => error?.code === "PLUGIN_DECLARATIVE_NOT_EXECUTABLE",
  );
  assert.equal(executions.list(record.id).length, 0, "declarative rejection must not create an execution row");

  const lifecycle = new lifecycleModule.PluginLifecycle();
  lifecycle.beginInstalledPreflight(record.id);
  lifecycle.activateInstalled(record.id, 1);
  lifecycle.completeProbationExecution(record.id);
  const stable = registry.get(record.id)!;
  assert.equal(stable.status, "enabled");
  assert.equal(stable.lifecycleState, "stable");
  assert.equal(stable.probationRemaining, 0);

  schemaModule.closeDb();
  fs.rmSync(databaseDirectory, { recursive: true, force: true });
});
