import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fixture, makePlan } from "./helpers.ts";
import { seedDebugArtifacts } from "./verification-fixture.ts";
import { Engine } from "../server/engine.ts";
import { Store } from "../server/store.ts";

test("verification is durable, idempotent, scoped to source SHA and permits only debug acceptance", async (t) => {
  const f = fixture(t);
  const seed = await seedDebugArtifacts(f.store, f.github, f.plan);
  const key = randomUUID();
  const task = f.engine.submitVerification(seed.source.id, { key });
  assert.equal(
    f.engine.submitVerification(seed.source.id, { key }).id,
    task.id,
  );
  assert.throws(() => f.engine.accept(task.id, {}), /必须先完成/);
  assert.throws(() => f.submit(), /活动任务/);
  await f.engine.tick();
  const result = f.store.task(task.id);
  assert.equal(result.state, "succeeded");
  assert.equal(result.verifications!.length, 2);
  assert.equal(f.github.dispatchCount, 0);
  assert.equal(seed.downloads(), 2);
  assert.equal(
    f.engine.submitVerification(seed.source.id, { key }).id,
    task.id,
  );
  assert.throws(
    () =>
      f.engine.accept(task.id, {
        version: "wrong",
        sha: result.plan.sha,
        confirmDebugOnly: true,
      }),
    /明确确认/,
  );
  const body = {
    version: result.plan.version,
    sha: result.plan.sha,
    confirmDebugOnly: true,
  };
  const accepted = f.engine.accept(task.id, body);
  assert.equal(accepted.acceptance?.scope, "debug-only");
  assert.equal(
    f.engine.accept(task.id, body).acceptance?.digest,
    accepted.acceptance?.digest,
  );
  assert.equal(
    f.store.audits(task.id).filter((a) => a.event === "artifact.accepted")
      .length,
    1,
  );
  f.store.close();
  const reopened = new Store(f.path);
  t.after(() => reopened.close());
  assert.equal(
    reopened.task(task.id).acceptance?.digest,
    accepted.acceptance?.digest,
  );
});
test("a failed or non-debug source cannot request verification or be accepted", (t) => {
  const f = fixture(t);
  const source = f.submit("dry-run");
  assert.throws(
    () => f.engine.submitVerification(source.id, { key: randomUUID() }),
    /只能下载校验/,
  );
  assert.throws(() => f.engine.accept(source.id, {}), /必须先完成/);
});
test("expired or foreign-run artifacts fail before download and preserve the original build", async (t) => {
  const f = fixture(t);
  const seed = await seedDebugArtifacts(f.store, f.github, f.plan);
  seed.metadata.get(9001).expired = true;
  const first = f.engine.submitVerification(seed.source.id, {
    key: randomUUID(),
  });
  await f.engine.tick();
  assert.equal(f.store.task(first.id).state, "failed");
  assert.equal(seed.downloads(), 0);
  seed.metadata.get(9001).expired = false;
  seed.metadata.get(9001).workflow_run.id = 999;
  const second = f.engine.submitVerification(seed.source.id, {
    key: randomUUID(),
  });
  await f.engine.tick();
  assert.equal(f.store.task(second.id).state, "failed");
  assert.equal(seed.downloads(), 0);
  assert.equal(f.store.task(seed.source.id).state, "succeeded");
});
test("partial validation failure retains the completed platform and prevents acceptance", async (t) => {
  const f = fixture(t);
  const seed = await seedDebugArtifacts(f.store, f.github, f.plan);
  seed.archives.set(9002, Buffer.from("corrupt archive"));
  const task = f.engine.submitVerification(seed.source.id, {
    key: randomUUID(),
  });
  await f.engine.tick();
  const result = f.store.task(task.id);
  assert.equal(result.state, "failed");
  assert.equal(result.verifications!.length, 1);
  assert.throws(() => f.engine.accept(task.id, {}), /必须先完成/);
});
test("cancelling a download waits for local shutdown, frees exclusion and never cancels the source Run", async (t) => {
  const f = fixture(t);
  const seed = await seedDebugArtifacts(f.store, f.github, f.plan);
  let started!: () => void;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.github.downloadArtifact = async (_id, _path, signal) =>
    new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  const task = f.engine.submitVerification(seed.source.id, {
    key: randomUUID(),
  });
  const tick = f.engine.tick();
  await downloading;
  assert.equal(f.engine.cancel(task.id).state, "cancelling");
  assert.throws(() => f.submit(), /活动任务/);
  await tick;
  assert.equal(f.store.task(task.id).state, "cancelled");
  assert.equal(f.github.cancelCount, 0);
  assert.equal(f.store.task(seed.source.id).state, "succeeded");
});
test("verification timeouts stop the download and do not mark any artifact verified", async (t) => {
  const f = fixture(t, { timeoutMs: 25 });
  const seed = await seedDebugArtifacts(f.store, f.github, f.plan);
  f.github.downloadArtifact = async (_id, _path, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  const task = f.engine.submitVerification(seed.source.id, {
    key: randomUUID(),
  });
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "timed_out");
  assert.deepEqual(f.store.task(task.id).verifications, []);
});
test("service restart resumes interrupted read-only verification without redispatch or losing source evidence", async (t) => {
  const f = fixture(t);
  const seed = await seedDebugArtifacts(f.store, f.github, f.plan);
  f.engine.claim();
  let started!: () => void;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.github.downloadArtifact = async (_id, _path, signal) =>
    new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  const task = f.engine.submitVerification(seed.source.id, {
    key: randomUUID(),
  });
  const tick = f.engine.tick();
  await downloading;
  await f.engine.stop();
  await tick;
  assert.equal(f.store.task(task.id).state, "running");
  f.github.downloadArtifact = async (id, path) => {
    await writeFile(path, seed.archives.get(id)!);
  };
  f.store.close();
  const reopened = new Store(f.path);
  t.after(() => reopened.close());
  await new Engine(reopened, f.planner).tick();
  assert.equal(reopened.task(task.id).state, "succeeded");
  assert.equal(f.github.dispatchCount, 0);
});
test("queued verification can be cancelled before any download starts", async (t) => {
  const f = fixture(t, { plan: makePlan({ platforms: ["windows"] }) });
  const seed = await seedDebugArtifacts(f.store, f.github, f.plan);
  const task = f.engine.submitVerification(seed.source.id, {
    key: randomUUID(),
  });
  f.engine.cancel(task.id);
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "cancelled");
  assert.equal(seed.downloads(), 0);
});
