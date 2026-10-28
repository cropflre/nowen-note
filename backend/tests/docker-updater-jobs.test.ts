import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

test("DCC-008: Docker upgrade lifecycle refuses unsafe rollback", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-updater-"));
  const socket = path.join(directory, "docker.sock");
  const digest = `cropflre/nowen-note@sha256:${"a".repeat(64)}`;
  const targetVersion = "1.5.3";
  const originalEnv = { ...process.env };
  process.env.NOWEN_DOCKER_SOCKET = socket;
  process.env.NOWEN_UPDATER_STATE_DIR = directory;
  process.env.NOWEN_UPDATER_HEALTH_TIMEOUT_MS = "30000";
  process.env.NOWEN_UPDATER_STABILITY_WINDOW_MS = "5000";

  let now = 1_000_000;
  const realTimeout = globalThis.setTimeout;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 2_000) {
      now += delay;
      return realTimeout(callback, 0, ...args);
    }
    return realTimeout(callback, delay, ...args);
  });

  let operations: string[];
  let payload: any;
  let old: any;
  let replacement: any;
  let targetImage: any;
  let runtimeVersion: any;
  let sourceMetadata: any;
  let failure: "create" | "start" | "stop" | "remove" | undefined;
  let createdImageId: string | undefined;
  let targetUnavailable: boolean;
  let inspectCount: number;
  let onInspect: (() => void) | undefined;
  let oldStarted: boolean;
  let onVersionRead: (() => void) | undefined;
  let versionReads: number;
  function reset() {
    operations = [];
    payload = null;
    replacement = null;
    failure = undefined;
    createdImageId = undefined;
    targetUnavailable = false;
    inspectCount = 0;
    onInspect = undefined;
    oldStarted = false;
    onVersionRead = undefined;
    versionReads = 0;
    old = {
      Id: "old", Name: "/nowen-note", Image: "sha256:old",
      Config: {
        Image: "cropflre/nowen-note:v1.5.1",
        Labels: {
          "com.nowen-note.managed": "true", "com.nowen-note.role": "app",
          "com.nowen-note.project": "nowen-note", "com.nowen-note.instance": "nowen-note",
        },
      },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" }, Binds: ["notes:/app/data"] },
      NetworkSettings: { Networks: {} }, State: { Running: true, Health: { Status: "healthy" } },
    };
    targetImage = {
      Id: "sha256:new", Architecture: "amd64", RepoDigests: [digest],
      Config: {
        Env: [`NOWEN_APP_VERSION=${targetVersion}`],
        Labels: { "org.opencontainers.image.version": `v${targetVersion}` },
        Healthcheck: { Test: ["CMD", "node", "health.js"] },
      },
    };
    sourceMetadata = { appVersion: "1.5.1", schemaVersion: 123, codeSchemaVersion: 123 };
    runtimeVersion = { appVersion: targetVersion, schemaVersion: 131, codeSchemaVersion: 131 };
  }
  reset();

  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = String(input);
    const targetRunning = replacement && !oldStarted;
    if (targetRunning && targetUnavailable) throw new Error("service unavailable");
    if (targetRunning && url.endsWith("/api/version")) {
      versionReads++;
      onVersionRead?.();
    }
    const body = url.endsWith("/api/health") ? { status: "ok" } : targetRunning ? runtimeVersion : sourceMetadata;
    return new Response(JSON.stringify(body));
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://docker");
    const route = decodeURIComponent(url.pathname);
    operations.push(`${req.method} ${route}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    let result: any = {};
    if (route === "/info") result = { Architecture: "amd64" };
    else if (route === "/images/create") result = { status: "pulled" };
    else if (route.startsWith("/images/")) {
      result = route.includes("sha256:old") ? { Id: "sha256:old" } : targetImage;
    } else if (route === "/containers/json") result = [{ Id: "old", Names: ["/nowen-note"], State: "running" }];
    else if (route === "/containers/old/json") result = old;
    else if (route === "/containers/new/json") {
      if (replacement.State.Running) {
        inspectCount++;
        onInspect?.();
      }
      result = replacement;
    } else if (route === "/containers/create") {
      if (failure === "create") { res.writeHead(500); res.end("create failed"); return; }
      payload = body;
      replacement = {
        Id: "new", Image: createdImageId || targetImage.Id, Config: body,
        State: { Running: false, Health: { Status: "healthy" } },
      };
      result = { Id: "new" };
    } else if (route === "/containers/new/start") {
      if (failure === "start") { res.writeHead(500); res.end("start failed"); return; }
      replacement.State.Running = true;
    } else if (route === "/containers/old/start") { oldStarted = true; old.State.Running = true; }
    else if (route === "/containers/new/stop") {
      if (failure === "stop") { res.writeHead(500); res.end("stop failed"); return; }
      if (!replacement.State.Running) { res.writeHead(304); res.end(); return; }
      replacement.State.Running = false;
    } else if (route === "/containers/old/stop") old.State.Running = false;
    else if (route === "/containers/old/rename") old.Name = `/${url.searchParams.get("name")}`;
    else if (req.method === "DELETE" && route === "/containers/new") {
      if (failure === "remove") { res.writeHead(500); res.end("remove failed"); return; }
      replacement = null;
    }
    else if (req.method !== "DELETE") { res.writeHead(404); res.end(route); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const key of ["NOWEN_DOCKER_SOCKET", "NOWEN_UPDATER_STATE_DIR", "NOWEN_UPDATER_HEALTH_TIMEOUT_MS", "NOWEN_UPDATER_STABILITY_WINDOW_MS"]) {
      if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { createUpdateJob, getJob, runUpdaterPreflight } = await import("../src/updater/jobs");
  async function run() {
    const initial = await createUpdateJob({ targetVersion, targetImageId: targetImage.Id, expectedCurrentImageId: old.Image });
    for (let turns = 0; turns < 20_000; turns++) {
      const job = getJob(initial.id)!;
      if (job.status !== "queued" && job.status !== "running") return job;
      await nextTurn();
    }
    throw new Error("job did not settle");
  }

  await t.test("rejects a stale image behind a version tag before stopping the old container", async () => {
    reset();
    targetImage.Config.Env = ["NOWEN_APP_VERSION=1.5.1"];
    const preflight = await runUpdaterPreflight(targetVersion);
    assert.equal(preflight.canApply, false);
    await assert.rejects(run(), /版本/);
    assert.ok(!operations.includes("POST /containers/old/stop"));
  });

  await t.test("rejects missing or incorrect image version labels and repository digests", async () => {
    for (const modify of [
      () => { delete targetImage.Config.Labels; },
      () => { targetImage.Config.Labels["org.opencontainers.image.version"] = "v1.5.1"; },
      () => { delete targetImage.Config.Env; },
      () => { delete targetImage.RepoDigests; },
      () => { targetImage.RepoDigests = [digest.replace("cropflre/nowen-note", "other/image")]; },
      () => { targetImage.RepoDigests = ["cropflre/nowen-note@sha256:invalid"]; },
    ]) {
      reset(); modify();
      assert.equal((await runUpdaterPreflight(targetVersion)).canApply, false);
      await assert.rejects(run());
      assert.ok(!operations.includes("POST /containers/old/stop"));
    }
  });

  await t.test("creates the verified immutable image and completes only after migration readiness", async () => {
    reset();
    const job = await run();
    assert.equal(job.phase, "completed");
    assert.equal(payload.Image, digest);
    assert.ok(operations.includes("DELETE /containers/old"));
  });

  await t.test("refuses to start a container whose actual image differs from preflight", async () => {
    reset(); createdImageId = "sha256:unexpected";
    assert.equal((await run()).phase, "rolled_back");
    assert.ok(!operations.includes("POST /containers/new/start"));
    assert.ok(oldStarted);
  });

  await t.test("DCC-008: schema mismatch never succeeds or starts the incompatible old container", async () => {
    reset();
    runtimeVersion.schemaVersion = 130;
    const job = await run();
    assert.equal(job.phase, "rollback_failed");
    assert.ok(!job.logs.some((entry) => entry.phase === "completed"));
    assert.ok(!oldStarted);
    assert.equal(replacement.State.Running, false);
    assert.ok(!operations.some((entry) => entry.startsWith("DELETE")));
  });

  await t.test("missing or invalid schema metadata cannot pass readiness or authorize rollback", async () => {
    for (const metadata of [{}, { schemaVersion: null, codeSchemaVersion: null }, { schemaVersion: "123", codeSchemaVersion: "123" }]) {
      reset(); runtimeVersion = { appVersion: targetVersion, ...metadata };
      assert.equal((await run()).phase, "rollback_failed");
      assert.ok(!oldStarted);
    }
  });

  await t.test("a wrong runtime version cannot pass readiness or authorize rollback", async () => {
    reset(); runtimeVersion = { ...sourceMetadata };
    assert.equal((await run()).phase, "rollback_failed");
    assert.ok(!oldStarted);
  });

  await t.test("readiness must remain continuous throughout the observation window", async () => {
    reset();
    const started = now;
    onInspect = () => { runtimeVersion.appVersion = inspectCount === 2 ? "1.5.1" : targetVersion; };
    assert.equal((await run()).phase, "completed");
    assert.ok(now - started >= 10_000, "a failed version observation must reset the stability window");
  });

  await t.test("Docker health or restarting state resets the observation window", async () => {
    for (const state of ["starting", "restarting"]) {
      reset();
      const started = now;
      onInspect = () => {
        replacement.State.Health.Status = state === "starting" && inspectCount === 2 ? "starting" : "healthy";
        replacement.State.Restarting = state === "restarting" && inspectCount === 2;
      };
      assert.equal((await run()).phase, "completed");
      assert.ok(now - started >= 10_000);
    }
  });

  await t.test("the final success check also requires complete schema metadata", async () => {
    reset();
    onVersionRead = () => { if (versionReads >= 5) delete runtimeVersion.schemaVersion; };
    assert.equal((await run()).phase, "rollback_failed");
    assert.ok(!oldStarted);
    assert.ok(!operations.includes("DELETE /containers/old"));
  });

  await t.test("DCC-008: unavailable new service preserves both containers without restarting the old program", async () => {
    reset(); targetUnavailable = true;
    const job = await run();
    assert.equal(job.phase, "rollback_failed");
    assert.match(job.rollbackError!, /兼容|确认|Schema/);
    assert.ok(!oldStarted);
    assert.equal(replacement.State.Running, false);
    assert.ok(!operations.some((entry) => entry.startsWith("DELETE")));
  });

  await t.test("compatible rollback stops and removes the replacement before restarting the old program", async () => {
    reset(); runtimeVersion = { ...sourceMetadata, appVersion: targetVersion };
    onInspect = () => { if (replacement.State.Running) replacement.State.Health.Status = "unhealthy"; };
    assert.equal((await run()).phase, "rolled_back");
    assert.ok(operations.includes("POST /containers/new/stop"));
    assert.ok(operations.includes("DELETE /containers/new"));
    assert.ok(operations.indexOf("POST /containers/new/stop") < operations.indexOf("POST /containers/old/start"));
    assert.ok(operations.indexOf("DELETE /containers/new") < operations.indexOf("POST /containers/old/start"));
  });

  await t.test("a ready schema 131 database cannot be rolled back to a schema 123 program", async () => {
    reset();
    onInspect = () => { replacement.State.Health.Status = "unhealthy"; };
    const job = await run();
    assert.equal(job.sourceCodeSchemaVersion, 123);
    assert.equal(job.phase, "rollback_failed");
    assert.ok(!oldStarted);
    assert.equal(replacement.State.Running, false);
  });

  await t.test("missing source compatibility metadata cannot authorize rollback", async () => {
    reset(); sourceMetadata = { appVersion: "1.5.1" };
    runtimeVersion = { appVersion: targetVersion, schemaVersion: 123, codeSchemaVersion: 123 };
    onInspect = () => { replacement.State.Health.Status = "unhealthy"; };
    assert.equal((await run()).phase, "rollback_failed");
    assert.ok(!oldStarted);
  });

  await t.test("failure to stop the replacement never starts a second database writer", async () => {
    reset(); failure = "stop"; targetUnavailable = true;
    assert.equal((await run()).phase, "rollback_failed");
    assert.ok(!oldStarted);
    assert.ok(!operations.includes("DELETE /containers/new"));
  });

  await t.test("creation failure can restore the old container before any new program is started", async () => {
    reset(); failure = "create";
    assert.equal((await run()).phase, "rolled_back");
    assert.ok(oldStarted);
  });

  await t.test("failure to remove the stopped replacement never starts the old container", async () => {
    reset(); failure = "remove";
    runtimeVersion = { ...sourceMetadata, appVersion: targetVersion };
    onInspect = () => { replacement.State.Health.Status = "unhealthy"; };
    assert.equal((await run()).phase, "rollback_failed");
    assert.ok(!oldStarted);
    assert.equal(replacement.State.Running, false);
  });

  await t.test("an ambiguous start failure still requires proof of compatibility", async () => {
    reset(); failure = "start"; targetUnavailable = true;
    assert.equal((await run()).phase, "rollback_failed");
    assert.ok(!oldStarted);
  });
});
