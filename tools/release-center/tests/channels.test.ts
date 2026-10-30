import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Channels, channelVersion } from "../server/channels.ts";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { fixture } from "./helpers.ts";
import { ChannelGitHub, ChannelProvider, channelSha, channelDigest, storeToken } from "./channels-fixture.ts";

function setup(t: TestContext, configured = true) {
  const f = fixture(t);
  const github = new ChannelGitHub();
  const provider = new ChannelProvider();
  const channels = new Channels(f.store, github, configured ? { storeToken } : {}, provider.transport);
  const plan = (ids = ["microsoft-store", "docker-hub", "nas"], key = randomUUID()) => channels.createPlan({ version: "1.5.2", channels: ids, key });
  return { ...f, github, provider, channels, plan, basePlan: f.plan };
}
const latest = (view: ReturnType<Channels["view"]>, id: string) => view.observations.find((o) => o.channel === id)!;
function receipt(plan: Awaited<ReturnType<Channels["createPlan"]>>, extra = {}) {
  return { planId: plan.id, version: plan.version, sha: plan.source.sha, channel: "nas", key: randomUUID(),
    status: "submitted", reference: "ticket-123", evidenceUrl: "https://example.invalid/submissions/123", notes: "manual evidence", confirmManual: true, ...extra };
}

test("channel input rejects shell syntax, prerelease, extra fields and arbitrary adapter selection", async (t) => {
  const f = setup(t);
  for (const value of [null, 123, "v1.5.2", "01.5.2", "1.5.2-rc.1", "1.5.2; touch /tmp/unsafe", "1.5.2\n"])
    assert.throws(() => channelVersion(value));
  for (const raw of [null, [], { version: "1.5.2", command: "x" }, { version: "1.5.2", url: "https://evil.invalid" }])
    assert.throws(() => f.channels.refresh(raw));
  for (const ids of [[], ["docker-hub", "docker-hub"], ["custom-shell"]])
    assert.throws(() => f.channels.createPlan({ version: "1.5.2", channels: ids, key: randomUUID() }));
  assert.equal(f.provider.calls.length, 0);
});
test("local reads do not query providers; refresh is concurrent-deduplicated, cached and audited", async (t) => {
  const f = setup(t);
  assert.deepEqual(f.channels.view("1.5.2").observations, []);
  assert.equal(f.provider.calls.length, 0);
  let resume!: () => void;
  f.provider.blocker = new Promise<void>((r) => { resume = r; });
  const a = f.channels.refresh({ version: "1.5.2" });
  const b = f.channels.refresh({ version: "1.5.2" });
  assert.equal(a, b);
  resume();
  const view = await a;
  assert.equal(view.history.length, 3);
  assert.equal(latest(view, "microsoft-store").state, "pending");
  assert.equal(latest(view, "docker-hub").state, "available");
  assert.equal(latest(view, "nas").state, "available");
  const count = f.provider.calls.length;
  await f.channels.refresh({ version: "1.5.2" });
  assert.equal(f.provider.calls.length, count);
  assert.equal(f.store.audits().filter((a) => a.event === "channels.observed").length, 1);
  for (const { url, init } of f.provider.calls) {
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const auth = (init?.headers as Record<string, string>).Authorization;
    assert.equal(auth, url.includes("manage.devcenter.microsoft.com") ? `Bearer ${storeToken}` : undefined);
  }
  assert.doesNotMatch(JSON.stringify(view), /fixture-partner-center-credential|fileUploadUrl|must-not-leak/);
});
test("missing Partner Center token does not make any Store request or claim publication", async (t) => {
  const f = setup(t, false);
  const view = await f.channels.refresh({ version: "1.5.2" });
  assert.equal(latest(view, "microsoft-store").state, "not_configured");
  assert.equal(f.provider.calls.length, 1);
});
for (const status of [401, 403, 429]) test(`Partner Center ${status} is an error observation and never a publication`, async (t) => {
  const f = setup(t);
  f.provider.storeStatus = status;
  const view = await f.channels.refresh({ version: "1.5.2" });
  assert.equal(latest(view, "microsoft-store").state, "error");
  assert.match(latest(view, "microsoft-store").details.join(), new RegExp(String(status)));
  assert.equal(latest(view, "docker-hub").state, "available");
});
for (const field of ["id", "packageIdentityName", "publisherName"]) test(`Store rejects mismatched ${field}`, async (t) => {
  const f = setup(t);
  f.provider.app[field] = "another-app";
  const view = await f.channels.refresh({ version: "1.5.2" });
  assert.equal(latest(view, "microsoft-store").state, "error");
  assert.equal(f.provider.calls.filter((c) => c.url.includes("/submissions/")).length, 0);
});
for (const [status, state] of [["Published", "available"], ["CertificationFailed", "error"], ["NewProviderStatus", "unknown"]])
  test(`Store ${status} is reported as ${state} only for the exact package version`, async (t) => {
    const f = setup(t);
    f.provider.submissions["pending-1"].status = status;
    assert.equal(latest(await f.channels.refresh({ version: "1.5.2" }), "microsoft-store").state, state);
  });
test("Store ignores other package versions and refuses a mismatched submission ID", async (t) => {
  const f = setup(t);
  f.provider.submissions["pending-1"].applicationPackages[0].version = "1.5.20.0";
  assert.equal(latest(await f.channels.refresh({ version: "1.5.2" }), "microsoft-store").state, "not_found");
  const second = new Channels(f.store, f.github, { storeToken }, f.provider.transport);
  f.store.db.exec("DELETE FROM channel_observations");
  f.provider.submissions["pending-1"].applicationPackages[0].version = "1.5.2.0";
  f.provider.submissions["pending-1"].id = "unrelated-submission";
  assert.equal(latest(await second.refresh({ version: "1.5.2" }), "microsoft-store").state, "error");
});
test("an already published Store version wins over a matching pending revision and blocks overwrite", async (t) => {
  const f = setup(t);
  f.provider.submissions["published-1"].applicationPackages[0].version = "1.5.2.0";
  const plan = await f.plan(["microsoft-store"]);
  const observed = latest(f.channels.view("1.5.2"), "microsoft-store");
  assert.equal(observed.state, "available");
  assert.equal(observed.evidence.submissionId, "published-1");
  assert.ok(plan.handoffs[0].blockers.some((b) => b.includes("不得以此计划覆盖")));
});
test("Store cannot swap two otherwise valid submission IDs in the returned bodies", async (t) => {
  const f = setup(t);
  f.provider.submissions["pending-1"].id = "published-1";
  assert.equal(latest(await f.channels.refresh({ version: "1.5.2" }), "microsoft-store").state, "error");
});
for (const [status, state] of [[404, "not_found"], [429, "error"]]) test(`Docker ${status} is ${state}, never available`, async (t) => {
  const f = setup(t);
  f.provider.dockerStatus = Number(status);
  assert.equal(latest(await f.channels.refresh({ version: "1.5.2" }), "docker-hub").state, state);
});
test("Docker missing digest cannot authorize overwrite; wrong tag cannot impersonate the version", async (t) => {
  const f = setup(t);
  f.provider.docker.digest = null;
  const plan = await f.plan(["docker-hub"]);
  assert.equal(latest(f.channels.view("1.5.2"), "docker-hub").state, "unknown");
  assert.ok(plan.handoffs[0].blockers.some((b) => b.includes("禁止本工具覆盖")));
  f.store.db.exec("DELETE FROM channel_observations");
  f.provider.docker.name = "latest";
  assert.equal(latest(await f.channels.refresh({ version: "1.5.2" }), "docker-hub").state, "error");
});
test("provider timeout, oversize and invalid JSON remain explicit errors with credentials redacted", async (t) => {
  for (const response of [() => { throw new Error(`Timeout ${storeToken}`); }, () => new Response("x".repeat(2_000_001)), () => new Response("invalid-json")]) {
    const f = setup(t);
    f.provider.response = response;
    const view = await f.channels.refresh({ version: "1.5.2" });
    assert.equal(latest(view, "docker-hub").state, "error");
    assert.equal(latest(view, "microsoft-store").state, "error");
    assert.ok(!JSON.stringify(view).includes(storeToken));
    assert.ok(!JSON.stringify(f.store.audits()).includes(storeToken));
  }
});
test("a provider that never responds is aborted by the real deadline and releases refresh deduplication", { timeout: 25_000 }, async (t) => {
  const f = fixture(t);
  const github = new ChannelGitHub();
  let hung = true;
  const transport: typeof fetch = async (_input, init) => {
    if (!hung) return Response.json({ name: "v1.5.2", digest: channelDigest });
    return new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const channels = new Channels(f.store, github, {}, transport);
  const view = await channels.refresh({ version: "1.5.2" });
  assert.equal(latest(view, "docker-hub").state, "error");
  hung = false;
  f.store.db.exec("DELETE FROM channel_observations");
  assert.equal(latest(await channels.refresh({ version: "1.5.2" }), "docker-hub").state, "available");
});
test("a refreshed failure is current while historical success remains visible", async (t) => {
  const f = setup(t);
  await f.channels.refresh({ version: "1.5.2" });
  const rows = f.store.db.prepare("SELECT seq,data FROM channel_observations").all();
  for (const row of rows) {
    const data = JSON.parse(String(row.data)); data.at = "2020-01-01T00:00:00Z";
    f.store.db.prepare("UPDATE channel_observations SET data=? WHERE seq=?").run(JSON.stringify(data), row.seq);
  }
  f.provider.dockerStatus = 429;
  const view = await f.channels.refresh({ version: "1.5.2" });
  assert.equal(view.history.length, 6);
  assert.equal(latest(view, "docker-hub").state, "error");
  assert.ok(view.history.some((o) => o.channel === "docker-hub" && o.state === "available"));
});
test("plan fixes published Release and annotated Tag SHA, isolates AppX and pins NAS image digest", async (t) => {
  const f = setup(t);
  f.github.tag = { type: "tag", sha: "e".repeat(40) };
  const plan = await f.plan();
  assert.equal(plan.source.sha, channelSha);
  assert.equal(plan.source.releaseId, 301);
  assert.equal(plan.executable, false);
  assert.equal(plan.approval, "not_connected");
  const store = plan.handoffs.find((h) => h.channel === "microsoft-store")!;
  assert.equal((store.metadata.artifacts as any[])[0].name, "nowen-note-store-appx");
  assert.equal(store.assets.length, 0);
  const nas = plan.handoffs.find((h) => h.channel === "nas")!;
  assert.deepEqual(nas.assets.map((a) => a.id), [401, 402]);
  assert.ok(nas.assets.every((a) => a.contentVerified === false));
  assert.equal((nas.metadata.containerReference as any).pinnedReference, `cropflre/nowen-note@${channelDigest}`);
  assert.ok(f.github.calls.every((c) => c.startsWith("GET ")));
});
for (const modification of [{ draft: true }, { prerelease: true }, { tag_name: "v1.5.20" }, { published_at: null }, { id: -1 }])
  test(`unpublished or mismatched source is refused (${JSON.stringify(modification)})`, async (t) => {
    const f = setup(t);
    Object.assign(f.github.release, modification);
    await assert.rejects(f.plan(), /只接收已正式发布/);
    assert.equal(f.channels.view("1.5.2").plans.length, 0);
    assert.ok(f.store.audits().some((a) => a.event === "distribution.plan_failed"));
  });
test("missing Tag, invalid Commit and cyclic annotated tags are refused", async (t) => {
  for (const tag of [undefined, { type: "commit", sha: "bad" }, { type: "tag", sha: "e".repeat(40) }]) {
    const f = setup(t);
    f.github.tag = tag;
    f.github.annotated = { type: "tag", sha: "e".repeat(40) };
    await assert.rejects(f.plan());
    assert.equal(f.channels.view("1.5.2").plans.length, 0);
  }
});
for (const invalid of ["wrong-sha", "wrong-workflow", "failed", "expired", "duplicate", "exe-only"]) test(`Store handoff refuses ${invalid} artifact source`, async (t) => {
  const f = setup(t);
  if (invalid === "wrong-sha") f.github.storeRuns[0].head_sha = "f".repeat(40);
  if (invalid === "wrong-workflow") f.github.storeRuns[0].path = ".github/workflows/release.yml";
  if (invalid === "failed") f.github.storeRuns[0].conclusion = "failure";
  if (invalid === "expired") f.github.storeArtifacts[0].expired = true;
  if (invalid === "duplicate") f.github.storeArtifacts.push({ ...f.github.storeArtifacts[0], id: 602 });
  if (invalid === "exe-only") f.github.storeArtifacts[0].name = "Nowen-Note-Setup-1.5.2.exe";
  const plan = await f.plan(["microsoft-store"]);
  assert.ok(plan.handoffs[0].blockers.some((b) => b.includes("未找到同 Commit")));
  assert.equal(plan.executable, false);
});
test("NAS missing exact-version packages or digest is a visible blocker", async (t) => {
  const f = setup(t);
  f.github.release.assets = [{ id: 401, name: "nowen-note-1.5.2.fpk", size: 10, digest: null }];
  let plan = await f.plan(["nas"]);
  assert.ok(plan.handoffs[0].blockers.some((b) => b.includes("缺少 GitHub SHA-256")));
  f.github.release.assets = [{ id: 402, name: "nowen-note-1.5.20.fpk", size: 10, digest: channelDigest }];
  plan = await f.plan(["nas"]);
  assert.equal(plan.handoffs[0].assets.length, 0);
  assert.ok(plan.handoffs[0].blockers.some((b) => b.includes("缺少该版本")));
});
test("duplicate plan clicks converge, key-content conflicts reject, receipts require confirmation and remain unverified", async (t) => {
  const f = setup(t);
  const key = randomUUID();
  const [a, b] = await Promise.all([f.plan(undefined, key), f.plan(undefined, key)]);
  assert.equal(a.id, b.id);
  assert.equal(f.channels.view("1.5.2").plans.length, 1);
  await assert.rejects(async () => f.plan(["nas"], key), /幂等键/);
  const value = receipt(a);
  assert.throws(() => f.channels.record({ ...value, confirmManual: false }));
  for (const change of [{ sha: "f".repeat(40) }, { version: "1.5.20" }, { channel: "docker-hub" }, { evidenceUrl: "http://local.invalid" },
    { evidenceUrl: "https://x.invalid/?token=secret" }, { evidenceUrl: "https://user:secret@x.invalid" }, { evidenceUrl: "https://x.invalid/#secret" }])
    assert.throws(() => f.channels.record({ ...value, ...change }));
  const calls = f.provider.calls.length + f.github.calls.length;
  const recorded = f.channels.record(value);
  assert.equal(f.channels.record(value).id, recorded.id);
  assert.throws(() => f.channels.record({ ...value, status: "published" }), /幂等键/);
  assert.equal(recorded.verifiedByProvider, false);
  assert.equal(recorded.source, "maintainer-report");
  assert.equal(f.provider.calls.length + f.github.calls.length, calls);
  assert.equal(f.channels.view("1.5.2").receipts.length, 1);
  assert.equal(f.channels.view("1.5.2").formalDistribution, false);
});
test("observations and audit roll back together on failed persistence and can be retried", async (t) => {
  const f = setup(t);
  const audit = f.store.audit.bind(f.store);
  f.store.audit = () => { throw new Error("fixture storage failure"); };
  await assert.rejects(f.channels.refresh({ version: "1.5.2" }), /storage failure/);
  assert.equal(f.channels.view("1.5.2").history.length, 0);
  f.store.audit = audit;
  assert.equal((await f.channels.refresh({ version: "1.5.2" })).history.length, 3);
});
test("manual notes redact configured secrets without breaking JSON or changing idempotency", async (t) => {
  const f = setup(t);
  const plan = await f.plan(["nas"]);
  const value = receipt(plan, { notes: `quote \" and newline\n${storeToken}\n${f.github.token}` });
  const saved = f.channels.record(value);
  assert.ok(!saved.notes.includes(storeToken));
  assert.ok(!saved.notes.includes(f.github.token));
  assert.match(saved.notes, /\[REDACTED\]/);
  assert.equal(f.channels.record(value).id, saved.id);
  assert.ok(!JSON.stringify(f.store.audits()).includes(storeToken));
});
test("prior database upgrades additively; new process recovers plans, observations and receipts without network or duplication", async (t) => {
  const f = setup(t);
  const plan = await f.plan();
  const value = receipt(plan);
  const saved = f.channels.record(value);
  // Close/reopen first, then read and replay the same request in a fresh process.
  f.store.close();
  const store = new Store(f.path);
  assert.equal(store.plan(f.basePlan.id).sha, f.basePlan.sha);
  store.close();
  const driver = fileURLToPath(new URL("./channels-restart-fixture.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", driver, f.path, JSON.stringify(value)], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const recovered = JSON.parse(result.stdout);
  assert.equal(recovered.plans[0].id, plan.id);
  assert.equal(recovered.receipts.length, 1);
  assert.equal(recovered.receipts[0].id, saved.id);
  assert.equal(recovered.history.length, 3);
});
test("all channel HTTP routes enforce session/origin/mutation header; publishing remains absent", async (t) => {
  const f = setup(t);
  const server = createApp(f.engine, { dist: join(f.directory, "missing"), channels: f.channels });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const session = await fetch(`${base}/api/session`);
  assert.equal((await session.json() as any).formalDistribution, false);
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const headers = { cookie, "Content-Type": "application/json", "X-Release-Center": "1" };
  for (const endpoint of ["channels/refresh", "distribution/plans", "distribution/receipts"]) {
    for (const [h, status] of [[{}, 401], [{ cookie }, 403], [{ ...headers, Origin: "https://evil.invalid" }, 403]] as const) {
      assert.equal((await fetch(`${base}/api/${endpoint}`, { method: "POST", headers: h, body: "{}" })).status, status);
    }
  }
  const refreshed = await fetch(`${base}/api/channels/refresh`, { method: "POST", headers, body: JSON.stringify({ version: "1.5.2" }) });
  assert.equal(refreshed.status, 200);
  const planned = await fetch(`${base}/api/distribution/plans`, { method: "POST", headers, body: JSON.stringify({ version: "1.5.2", channels: ["nas"], key: randomUUID() }) });
  assert.equal(planned.status, 201);
  const plan = await planned.json() as any;
  assert.equal((await fetch(`${base}/api/distribution/receipts`, { method: "POST", headers, body: JSON.stringify(receipt(plan)) })).status, 201);
  for (const path of ["distribution/execute", "distribution/publish", "drafts", "publish", "tag", "docker", "store"])
    assert.equal((await fetch(`${base}/api/${path}`, { method: "POST", headers, body: "{}" })).status, 404);
});
