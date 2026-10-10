import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-update-recovery-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "update-recovery.db");
process.env.ELECTRON_USER_DATA = path.join(root, "user-data");

const stages = [
  "downloaded",
  "verified",
  "staged",
  "preflight",
  "switching",
  "probation",
  "rollback_pending",
  "rolling_back",
] as const;

test("startup recovery converges every interrupted update stage to stable, probation, or safe failure", async () => {
  const [
    { PluginRegistry },
    { PluginLifecycle },
    { recoverPluginUpdates },
    { getDb, closeDb },
  ] = await Promise.all([
    import("../src/plugins/registry"),
    import("../src/plugins/pluginLifecycle"),
    import("../src/plugins/pluginUpdateRecovery"),
    import("../src/db/schema"),
  ]);
  const registry = new PluginRegistry();
  const lifecycle = new PluginLifecycle();
  const db = getDb();

  function manifest(id: string, version: string) {
    return {
      id,
      publisher: "rc1",
      name: `Recovery ${id}`,
      description: "fault injection fixture",
      version,
      apiVersion: 2 as const,
      engines: { nowen: ">=1.5.0 <2.0.0" },
      runtime: "sandbox-js" as const,
      main: "index.js",
      categories: ["productivity"],
      repository: "https://github.com/example/recovery",
      license: "MIT",
      permissions: [],
      actions: [{ id: "run", name: "Run" }],
    };
  }

  function versionDirectory(pluginId: string, version: string): string {
    const directory = path.join(root, "fixtures", pluginId, version);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "index.js"), "globalThis.__nowenPluginModule={actions:{run:async()=>({success:true})}};");
    return directory;
  }

  function makeStable(pluginId: string): void {
    registry.upsert({
      manifest: manifest(pluginId, "1.0.0"),
      source: "package",
      trustLevel: "community",
      status: "enabled",
      checksum: `${pluginId}-v1`,
      installedPath: versionDirectory(pluginId, "1.0.0"),
      installedBy: "test",
    });
    lifecycle.beginInstalledPreflight(pluginId);
    lifecycle.activateInstalled(pluginId, 1);
    lifecycle.completeProbationExecution(pluginId);
    assert.equal(registry.get(pluginId)?.lifecycleState, "stable");
  }

  function prepare(stage: typeof stages[number]): { pluginId: string; operationId: string } {
    const pluginId = `rc1.recovery-${stage.replaceAll("_", "-")}`;
    makeStable(pluginId);
    const candidate = manifest(pluginId, "2.0.0");
    const checksum = `${pluginId}-v2`;
    registry.registerVersion({
      manifest: candidate,
      checksum,
      installedPath: versionDirectory(pluginId, "2.0.0"),
      source: "registry",
      trustLevel: "community",
      status: "installed",
    });
    const operationId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO plugin_update_operations
      (id,pluginId,fromVersion,targetVersion,stage,targetChecksum,requestedBy,createdAt,updatedAt)
      VALUES (?,?,?,?,'downloaded',?,?,?,?)`)
      .run(operationId, pluginId, "1.0.0", "2.0.0", checksum, "test", at, at);

    if (stage !== "downloaded") lifecycle.transitionOperation(operationId, "verified");
    if (!["downloaded", "verified"].includes(stage)) lifecycle.transitionOperation(operationId, "staged");
    if (["preflight", "switching", "probation", "rollback_pending", "rolling_back"].includes(stage)) {
      lifecycle.beginPreflight(pluginId, operationId);
    }
    if (stage === "switching") {
      db.prepare("UPDATE plugin_update_operations SET stage='switching' WHERE id=?").run(operationId);
    }
    if (["probation", "rollback_pending", "rolling_back"].includes(stage)) {
      lifecycle.activateCandidate(pluginId, operationId, 5);
    }
    if (stage === "rollback_pending") {
      db.prepare("UPDATE plugin_registry SET lifecycleState='rollback_pending' WHERE id=?").run(pluginId);
      db.prepare("UPDATE plugin_update_operations SET stage='rollback_pending' WHERE id=?").run(operationId);
    }
    if (stage === "rolling_back") {
      db.prepare("UPDATE plugin_registry SET lifecycleState='rolling_back' WHERE id=?").run(pluginId);
      db.prepare("UPDATE plugin_update_operations SET stage='rolling_back' WHERE id=?").run(operationId);
    }
    return { pluginId, operationId };
  }

  const fixtures = new Map(stages.map((stage) => [stage, prepare(stage)]));
  const result = recoverPluginUpdates();
  assert.equal(result.recovered, stages.length);
  assert.equal(result.disabled, 0);

  for (const stage of stages) {
    const fixture = fixtures.get(stage)!;
    const record = registry.get(fixture.pluginId)!;
    const operation = db.prepare("SELECT stage,errorCode FROM plugin_update_operations WHERE id=?")
      .get(fixture.operationId) as { stage: string; errorCode: string | null };
    if (stage === "probation") {
      assert.equal(record.version, "2.0.0", `probation should retain candidate for ${stage}`);
      assert.equal(record.lifecycleState, "probation");
      assert.equal(operation.stage, "probation");
      continue;
    }
    assert.equal(record.version, "1.0.0", `recovery must restore stable version for ${stage}`);
    assert.equal(record.lifecycleState, "stable", `recovery must converge lifecycle for ${stage}`);
    assert.equal(record.activeOperationId, null, `recovery must clear active operation for ${stage}`);
    if (["downloaded", "verified", "staged"].includes(stage)) {
      assert.equal(operation.stage, "failed");
      assert.equal(operation.errorCode, "PLUGIN_UPDATE_INTERRUPTED");
    } else {
      assert.equal(operation.stage, "rolled_back");
      assert.equal(operation.errorCode, "PLUGIN_UPDATE_INTERRUPTED");
    }
  }

  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
