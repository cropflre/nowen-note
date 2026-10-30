import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";
import { AppError } from "../server/errors.ts";
import { fixture, makePlan } from "./helpers.ts";

test("repeated clicks reuse the same task before and after completion; one active task per DB", async (t) => {
  const f = fixture(t);
  const key = randomUUID();
  const task = f.submit("dry-run", key);
  assert.equal(f.submit("dry-run", key).id, task.id);
  assert.throws(() => f.submit(), /活动任务/);
  const other = new Store(f.path);
  t.after(() => other.close());
  assert.throws(
    () =>
      other.create({ ...task, id: randomUUID(), key: randomUUID() }, "other"),
    /活动任务/,
  );
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "succeeded");
  assert.equal(f.submit("dry-run", key).id, task.id);
  assert.equal(f.github.dispatchCount, 0);
  assert.throws(() => f.submit("debug", key), /幂等键/);
});
test("formal publish, missing debug confirmation, and stale plans are rejected server-side", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.engine.submit({
        mode: "publish",
        planId: f.plan.id,
        key: randomUUID(),
      }),
    AppError,
  );
  assert.throws(
    () =>
      f.engine.submit({
        mode: "debug",
        planId: f.plan.id,
        key: randomUUID(),
        confirmDebug: false,
      }),
    /未确认/,
  );
  const stale = makePlan({ createdAt: "2020-01-01T00:00:00Z" });
  f.store.savePlan(stale);
  assert.throws(
    () =>
      f.engine.submit({ mode: "dry-run", planId: stale.id, key: randomUUID() }),
    /过期/,
  );
});
test("preflight failure and moving branch prevent dispatch", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.planner.nextPlan = makePlan({ sha: "c".repeat(40) });
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "failed");
  assert.equal(f.github.dispatchCount, 0);
});
test("restart after ambiguous dispatch only reconciles the persisted task, without repeating a write", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.github.dispatchError = Error("Network connection reset");
  await f.engine.tick();
  assert.equal(f.github.dispatchCount, 1);
  assert.equal(f.store.task(task.id).state, "reconciling");
  f.store.close();
  const reopened = new Store(f.path, [f.github.token]);
  t.after(() => reopened.close());
  f.github.found = { id: 101, head_sha: f.plan.workflowSha };
  const recovered = new Engine(reopened, f.planner);
  await recovered.tick();
  assert.equal(f.github.dispatchCount, 1);
  assert.equal(reopened.task(task.id).runId, 101);
  assert.equal(reopened.task(task.id).state, "running");
});
test("server recovery also preserves queued dry runs and audit history", async (t) => {
  const f = fixture(t);
  const task = f.submit("dry-run");
  f.store.close();
  const reopened = new Store(f.path);
  t.after(() => reopened.close());
  await new Engine(reopened, f.planner).tick();
  assert.equal(reopened.task(task.id).state, "succeeded");
  assert.ok(
    reopened.audits(task.id).some((a) => a.event === "dry_run.completed"),
  );
});
test("partial platform failure fails the overall task and retains successful artifacts", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.github.found = { id: 101, head_sha: f.plan.workflowSha };
  f.github.remote = { status: "completed", conclusion: "failure" };
  f.github.remoteJobs = [
    {
      id: 9,
      name: "windows",
      status: "completed",
      conclusion: "success",
      steps: [],
    },
    {
      id: 10,
      name: "linux",
      status: "completed",
      conclusion: "failure",
      steps: [],
    },
  ];
  f.github.remoteArtifacts = [
    {
      id: 1,
      name: `rc-debug-${task.id}-windows`,
      size: 20,
      expired: false,
      digest: "sha256:abc",
      verification: "not_downloaded",
    },
  ];
  await f.engine.tick();
  const result = f.store.task(task.id);
  assert.equal(result.state, "failed");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.jobs[1].conclusion, "failure");
});
test("workflow success with missing or expired artifacts cannot pass", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.github.found = { id: 101, head_sha: f.plan.workflowSha };
  f.github.remote = { status: "completed", conclusion: "success" };
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "failed");
  assert.match(f.store.task(task.id).error!, /缺少调试产物/);
});
test("only a successful run with every selected platform artifact can succeed", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.github.found = { id: 101, head_sha: f.plan.workflowSha };
  f.github.remote = { status: "completed", conclusion: "success" };
  f.github.remoteArtifacts = task.plan.platforms.map((p, i) => ({
    id: i,
    name: `rc-debug-${task.id}-${p}`,
    size: 20,
    expired: false,
    digest: null,
    verification: "not_downloaded",
  }));
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "succeeded");
  assert.ok(
    f.store
      .task(task.id)
      .artifacts.every((a) => a.verification === "not_downloaded"),
  );
});
test("cancellation and timeout retain exclusion until GitHub confirms the remote run ended", async (t) => {
  let now = Date.now();
  const f = fixture(t, { now: () => now, timeoutMs: 1000 });
  const task = f.submit();
  f.github.found = { id: 101, head_sha: f.plan.workflowSha };
  await f.engine.tick();
  now += 2000;
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "cancelling");
  assert.equal(f.github.cancelCount, 1);
  assert.throws(() => f.submit(), /活动任务/);
  f.github.remote = { status: "completed", conclusion: "cancelled" };
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "timed_out");
  const second = f.submit("dry-run");
  f.engine.cancel(second.id);
  await f.engine.tick();
  assert.equal(f.store.task(second.id).state, "cancelled");
});
test("cancel while preflight is in flight must not subsequently dispatch", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  let release!: () => void;
  f.planner.blocker = new Promise((resolve) => {
    release = resolve;
  });
  const running = f.engine.tick();
  f.engine.cancel(task.id);
  release();
  await running;
  assert.equal(f.github.dispatchCount, 0);
  assert.equal(f.store.task(task.id).state, "cancelled");
});
test("API 429/401 after dispatch preserve recoverability and apply backoff", async (t) => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  const task = f.submit();
  f.github.pollError = new AppError(429, "GitHub API 限流", "90");
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "reconciling");
  await f.engine.tick();
  assert.equal(f.github.dispatchCount, 1);
  now += 100_000;
  f.github.pollError = new AppError(401, "Token 无效");
  await f.engine.tick();
  assert.match(f.store.task(task.id).error!, /Token/);
  assert.equal(f.store.tasks(true).length, 1);
  now += 40_000;
  f.github.pollError = undefined;
  f.github.found = { id: 101, head_sha: f.plan.workflowSha };
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "running");
});
test("definitive dispatch rejection releases task without claiming a build exists", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.github.dispatchError = new AppError(403, "权限不足");
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "failed");
  assert.equal(f.store.task(task.id).runId, undefined);
});
test("wrong remote workflow SHA fails closed instead of attaching unrelated work", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.github.found = { id: 101, head_sha: "c".repeat(40) };
  await f.engine.tick();
  assert.equal(f.store.task(task.id).runId, undefined);
  assert.equal(f.store.task(task.id).state, "reconciling");
  assert.match(f.store.task(task.id).error!, /SHA/);
});
test("logs and errors are redacted before persistence", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.github.found = { id: 101, head_sha: f.plan.workflowSha };
  f.github.remoteJobs = [
    {
      id: 9,
      name: "windows",
      status: "completed",
      conclusion: "failure",
      steps: [],
    },
  ];
  await f.engine.tick();
  await f.engine.captureLog(task.id, 9);
  const text = JSON.stringify(f.store.audits(task.id));
  assert.ok(!text.includes(f.github.token));
  assert.ok(!text.includes("super-secret"));
  assert.match(text, /REDACTED/);
});
test("second service cannot claim the same database while owner process is alive", (t) => {
  const f = fixture(t);
  f.engine.claim();
  assert.throws(() => new Engine(f.store, f.planner).claim(), /已有/);
});

test("expired artifacts cannot satisfy the selected platform set", async (t) => {
  const f = fixture(t);
  const task = f.submit();
  f.github.found = { id: 101, head_sha: f.plan.workflowSha };
  f.github.remote = { status: "completed", conclusion: "success" };
  f.github.remoteArtifacts = task.plan.platforms.map((p, i) => ({
    id: i,
    name: `rc-debug-${task.id}-${p}`,
    size: 20,
    expired: true,
    digest: null,
    verification: "not_downloaded",
  }));
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "failed");
});

test("large logs explicitly preserve both ends, redact secrets, and support incremental audit reads", (t) => {
  const f = fixture(t);
  const task = f.submit("dry-run");
  const before = f.store.audits()[0].seq;
  f.store.audit(
    task.id,
    "large.log",
    `start ${f.github.token}\n${"x".repeat(150_000)}\ncompiler error at end`,
  );
  const entries = f.store.since(before);
  assert.equal(entries.length, 1);
  assert.match(entries[0].detail, /已截断/);
  assert.match(entries[0].detail, /compiler error at end$/);
  assert.ok(!entries[0].detail.includes(f.github.token));
  assert.deepEqual(f.store.since(entries[0].seq), []);
});

test("redacted errors preserve valid task JSON and remain readable after persistence", (t) => {
  const f = fixture(t);
  const task = f.submit("dry-run");
  task.error = "Authorization: Bearer unknown-token-value";
  task.plan.notes = "password=note-secret";
  f.store.save(task, "test.error", task.error);
  const restored = f.store.task(task.id);
  assert.equal(restored.error, "Authorization: Bearer [REDACTED]");
  assert.equal(restored.plan.notes, "password=[REDACTED]");
  assert.equal(restored.id, task.id);
});

test("unknown persisted task modes cannot fall through to a workflow dispatch", async (t) => {
  const f = fixture(t);
  const task = f.submit("dry-run");
  (task as any).mode = "publish";
  f.store.save(
    task,
    "fixture.unknown_mode",
    "simulate a newer or invalid stored task type",
  );
  await f.engine.tick();
  assert.equal(f.store.task(task.id).state, "failed");
  assert.equal(f.github.dispatchCount, 0);
});
