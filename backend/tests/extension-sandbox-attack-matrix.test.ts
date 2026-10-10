import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutionLogTail } from "../src/plugins/logs";
import { SandboxRunner } from "../src/plugins/sandboxRunner";
import type { PluginManifestV2, PluginRegistryRecord } from "../src/plugins/types";

function makeRunner(source: string, hostCall: (method: string, args: unknown) => Promise<unknown> | unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sandbox-attack-"));
  const manifest: PluginManifestV2 = {
    id: "rc1.attack-matrix",
    publisher: "rc1",
    name: "Attack Matrix",
    description: "RC1 sandbox attack fixture",
    version: "1.0.0",
    apiVersion: 2,
    engines: { nowen: ">=1.5.0 <2.0.0" },
    runtime: "sandbox-js",
    main: "index.js",
    categories: ["productivity"],
    repository: "https://github.com/example/attack-matrix",
    license: "MIT",
    permissions: [],
    actions: [{ id: "probe", name: "Probe" }],
  };
  fs.writeFileSync(path.join(directory, "index.js"), source);
  const record: PluginRegistryRecord = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: 2,
    runtime: "sandbox-js",
    main: "index.js",
    source: "dev",
    trustLevel: "developer",
    status: "enabled",
    checksum: "attack-matrix",
    manifestJson: JSON.stringify(manifest),
    installedPath: directory,
    installedBy: null,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: null,
    previousVersion: null,
  } as PluginRegistryRecord;
  const runner = new SandboxRunner(record, async (_context, call) => hostCall(call.method, call.args));
  return { runner, directory, manifest };
}

async function execute(runner: SandboxRunner, manifest: PluginManifestV2, timeoutMs = 2500) {
  await runner.preflight();
  return runner.execute({
    executionId: `attack-${Date.now()}-${Math.random()}`,
    pluginId: manifest.id,
    actionId: "probe",
    userId: "u",
    workspaceId: null,
  }, {}, timeoutMs, new ExecutionLogTail());
}

test("sandbox prototype pollution cannot cross the QuickJS process boundary", async () => {
  const { runner, directory, manifest } = makeRunner(
    `globalThis.__nowenPluginModule={actions:{probe:async()=>{Object.prototype.__nowenPolluted='yes';return {success:true,data:({}).__nowenPolluted}}}}`,
    () => null,
  );
  try {
    const result = await execute(runner, manifest);
    assert.deepEqual(result, { success: true, data: "yes" });
    assert.equal((Object.prototype as any).__nowenPolluted, undefined);
  } finally {
    await runner.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sandbox rejects Host API arguments above 256KB before broker dispatch", async () => {
  let brokerCalls = 0;
  const { runner, directory, manifest } = makeRunner(
    `globalThis.__nowenPluginModule={actions:{probe:async({nowen})=>{await nowen.runtime.capabilities({payload:'x'.repeat(300000)});return {success:true}}}}`,
    () => { brokerCalls += 1; return {}; },
  );
  try {
    await assert.rejects(() => execute(runner, manifest), /256KB|HOST_ARGS_TOO_LARGE|参数超过/);
    assert.equal(brokerCalls, 0);
  } finally {
    await runner.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sandbox rejects more than 32 concurrent pending Host API calls", async () => {
  const { runner, directory, manifest } = makeRunner(
    `globalThis.__nowenPluginModule={actions:{probe:async({nowen})=>{await Promise.all(Array.from({length:33},()=>nowen.runtime.capabilities()));return {success:true}}}}`,
    () => new Promise(() => {}),
  );
  try {
    await assert.rejects(() => execute(runner, manifest), /并发 Host API 调用超过 32|LIMIT_EXCEEDED/);
  } finally {
    await runner.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sandbox rejects progress event floods above the protocol budget", async () => {
  const { runner, directory, manifest } = makeRunner(
    `globalThis.__nowenPluginModule={actions:{probe:async({nowen})=>{for(let i=0;i<101;i++)nowen.progress({current:i,total:101,message:'p'});return {success:true}}}}`,
    () => null,
  );
  try {
    await assert.rejects(() => execute(runner, manifest), /进度事件超过 100|LIMIT_EXCEEDED/);
  } finally {
    await runner.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sandbox fails closed when an execution result exceeds the IPC envelope", async () => {
  const { runner, directory, manifest } = makeRunner(
    `globalThis.__nowenPluginModule={actions:{probe:async()=>({success:true,data:'x'.repeat(3*1024*1024)})}}`,
    () => null,
  );
  try {
    await assert.rejects(() => execute(runner, manifest), /超过协议限制|MESSAGE_TOO_LARGE|SANDBOX_FAILED/);
  } finally {
    await runner.terminate();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
