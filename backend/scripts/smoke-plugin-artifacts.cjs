const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function smoke(backendRoot = path.resolve(__dirname, "..")) {
  for (const entry of ["runner-child.mjs", "sandbox-child.mjs"]) {
    assert.ok(fs.existsSync(path.join(backendRoot, "dist/plugins", entry)), `Missing plugin artifact: ${entry}`);
  }
  const { PluginRunner } = require(path.join(backendRoot, "dist/plugins/runner.js"));
  const { SandboxRunner } = require(path.join(backendRoot, "dist/plugins/sandboxRunner.js"));
  const { ExecutionLogTail } = require(path.join(backendRoot, "dist/plugins/logs.js"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-plugin-artifact-smoke-"));
  try {
    for (const [runtime, Runner] of [["node-action", PluginRunner], ["sandbox-js", SandboxRunner]]) {
      const main = runtime === "node-action" ? "node.mjs" : "sandbox.js";
      const actions = "{ probe: async ({ nowen }) => ({ success: true, data: await nowen.runtime.capabilities() }) }";
      fs.writeFileSync(path.join(directory, main), runtime === "node-action"
        ? `export const actions = ${actions};`
        : `globalThis.__nowenPluginModule = { actions: ${actions} };`);
      const record = {
        id: `smoke.${runtime}`, name: "Artifact smoke", version: "1.0.0", apiVersion: 2,
        runtime, main, installedPath: directory,
        manifestJson: JSON.stringify({ actions: [{ id: "probe", name: "Probe" }] }),
      };
      let hostCalls = 0;
      const runner = new Runner(record, async (_context, call) => {
        assert.equal(call.method, "runtime.capabilities");
        hostCalls += 1;
        return { runtime, artifact: true };
      });
      try {
        await runner.preflight();
        const result = await runner.execute({
          executionId: `smoke-${runtime}`, pluginId: record.id, actionId: "probe",
          userId: "smoke", workspaceId: null,
        }, {}, 5000, new ExecutionLogTail());
        assert.deepEqual(result, { success: true, data: { runtime, artifact: true } });
        assert.equal(hostCalls, 1);
        console.log(`${runtime}: preflight, execution and Host API passed`);
      } finally {
        await runner.terminate();
      }
    }
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

smoke(process.argv[2] && path.resolve(process.argv[2])).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
