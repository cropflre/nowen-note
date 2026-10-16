// Source-only regression cases in this round; execution is deferred by the maintainer.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Publication } from "../server/publication.ts";
import { GitHub } from "../server/github.ts";
import { Engine } from "../server/engine.ts";
import { AppError } from "../server/errors.ts";
import { verifyArchive } from "../server/verification.ts";
import { fixture, FakePlanner, makePlan, root } from "./helpers.ts";
import { buildArchive, archiveDigest } from "./archive-fixture.ts";

class FormalGitHub extends GitHub {
  calls: string[] = [];
  source: any = { id: 71, path: ".github/workflows/release.yml", event: "push", head_branch: "v1.5.2", head_sha: "a".repeat(40), status: "completed", conclusion: "success", run_attempt: 1 };
  sourceSha = "a".repeat(40);
  version = "1.5.2";
  checks: any[] = ["console-contracts", "rc1-security"].map((name) => ({ name, status: "completed", conclusion: "success" }));
  outputs = ["nowen-note-win-direct", "nowen-note-mac", "nowen-note-linux"].map((name, index) => ({ id: 100 + index, name, expired: false, size: 100, digest: `sha256:${"b".repeat(64)}`, verification: "not_downloaded" as const }));
  readError?: AppError;
  constructor() { super("ghp_publication_fixture"); }
  override async run() { return structuredClone(this.source); }
  override async tagCommit() { return this.sourceSha; }
  override async content(path: string) {
    if (path.startsWith(".github/") || path.startsWith("scripts/")) return readFile(join(root, path), "utf8");
    return path.endsWith(".gradle") ? `versionName "${this.version}"` : JSON.stringify({ version: this.version, packages: { "": { version: this.version } } });
  }
  override async artifacts() { return structuredClone(this.outputs); }
  override async jobs() { return []; }
  override async list(path: string) {
    this.calls.push(`GET ${path}`);
    if (this.readError) throw this.readError;
    if (path === "releases") return [];
    if (path.endsWith("/check-runs")) return structuredClone(this.checks);
    throw new Error(`Unexpected fixture list: ${path}`);
  }
  override async request(path: string, method = "GET"): Promise<any> {
    this.calls.push(`${method} ${path}`);
    throw new Error(`Unexpected request; never use a real service: ${method} ${path}`);
  }
}
const input = () => ({ version: "1.5.2", runId: 71, notes: "Formal fixture only; never publish", key: randomUUID() });

test("formal imports are durable and idempotent, reserve the global task mutex and never dispatch or write", async (t) => {
  const f = fixture(t), github = new FormalGitHub(), publication = new Publication(f.store, github);
  const raw = input();
  const task = await publication.importRun(raw);
  assert.equal(task.mode, "publication");
  assert.equal(task.publication?.operation, "verify");
  assert.deepEqual(task.plan.platforms, ["windows", "macos", "linux"]);
  assert.equal((await publication.importRun(raw)).id, task.id);
  assert.throws(() => f.submit(), /已有活动任务/);
  const recovered = new Publication(f.store, github).view();
  assert.equal(recovered.candidates[0].id, task.publication!.candidateId);
  assert.equal(recovered.draftsEnabled, false);
  assert.equal(recovered.publishEnabled, false);
  assert.ok(github.calls.every((c) => c.startsWith("GET ")));
});
for (const override of [
  { event: "workflow_dispatch" }, { path: ".github/workflows/release-center-debug.yml" },
  { conclusion: "failure" }, { status: "in_progress" }, { head_branch: "release/v1.5.2" }, { head_sha: "bad" },
]) test(`formal import refuses debug, partial, failed or wrong source (${JSON.stringify(override)})`, async (t) => {
  const f = fixture(t), github = new FormalGitHub(); Object.assign(github.source, override);
  const publication = new Publication(f.store, github);
  await assert.rejects(publication.importRun(input()));
  assert.equal(publication.view().candidates.length, 0);
  assert.equal(f.store.tasks(true).length, 0);
});
test("formal import refuses mismatched tag SHA, inconsistent versions and failed/missing CI", async (t) => {
  for (const fault of ["tag", "version", "ci", "missing-ci"]) {
    const f = fixture(t), github = new FormalGitHub();
    if (fault === "tag") github.sourceSha = "c".repeat(40);
    if (fault === "version") github.version = "1.5.20";
    if (fault === "ci") github.checks[1].conclusion = "failure";
    if (fault === "missing-ci") github.checks = [];
    await assert.rejects(new Publication(f.store, github).importRun(input()));
    assert.equal(f.store.tasks(true).length, 0);
  }
});
test("path-filtered console CI can be absent, but a changed formal workflow protocol cannot be imported", async (t) => {
  const f = fixture(t), github = new FormalGitHub();
  github.checks = github.checks.filter((c) => c.name === "rc1-security");
  const publication = new Publication(f.store, github);
  const original = github.content.bind(github);
  github.content = async (path) => path === ".github/workflows/release.yml" ? "unreviewed workflow" : original(path);
  await assert.rejects(publication.importRun(input()), /正式构建协议不同/);
  github.content = original;
  assert.equal((await publication.importRun(input())).mode, "publication");
});
test("formal import refuses expired, duplicated or incomplete desktop artifacts", async (t) => {
  for (const fault of ["expired", "duplicate", "missing"]) {
    const f = fixture(t), github = new FormalGitHub();
    if (fault === "expired") github.outputs[0].expired = true;
    if (fault === "duplicate") github.outputs.push({ ...github.outputs[0], id: 999 });
    if (fault === "missing") github.outputs.pop();
    await assert.rejects(new Publication(f.store, github).importRun(input()));
  }
});
test("formal fields cannot select partial platforms, override workflow or run shell commands", async (t) => {
  const f = fixture(t), publication = new Publication(f.store, new FormalGitHub());
  for (const extra of [{ platforms: ["windows"] }, { workflow: "ios-release.yml" }, { command: "unsafe" }, { version: "1.5.2-rc.1" }])
    await assert.rejects(publication.importRun({ ...input(), ...extra }));
  assert.equal(f.store.tasks(true).length, 0);
});
test("a queued formal verification cancels through the same engine without dispatching", async (t) => {
  const f = fixture(t), github = new FormalGitHub(), publication = new Publication(f.store, github);
  const engine = new Engine(f.store, new FakePlanner(github, makePlan()), undefined, undefined, publication);
  const task = await publication.importRun(input());
  engine.cancel(task.id);
  assert.equal(f.store.task(task.id).state, "cancelling");
  await engine.tick();
  assert.equal(f.store.task(task.id).state, "cancelled");
  assert.equal(f.store.tasks(true).length, 0);
});
test("uncertain Draft creation survives API rate limits and restart without repeating a write or releasing the mutex", async (t) => {
  const f = fixture(t), github = new FormalGitHub(), publication = new Publication(f.store, github, github);
  const task = await publication.importRun(input());
  const candidate = publication.candidate(task.publication!.candidateId);
  candidate.authorId = 42; candidate.digest = "d".repeat(64);
  f.store.db.prepare("UPDATE release_candidates SET data=? WHERE id=?").run(JSON.stringify(candidate), candidate.id);
  task.publication = { candidateId: candidate.id, operation: "draft", intent: { kind: "draft" } };
  task.dispatchedAt = new Date().toISOString(); task.state = "reconciling";
  f.store.save(task, "fixture.write_intent", "Fixture only");
  github.readError = new AppError(429, "rate limited", "60");
  await publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "reconciling");
  assert.equal(f.store.task(task.id).publication?.intent?.kind, "draft");
  assert.ok(f.store.task(task.id).publication!.retryAt! > Date.now());
  github.readError = undefined;
  const recovering = f.store.task(task.id); recovering.publication!.retryAt = 0;
  f.store.save(recovering, "fixture.retry", "Fixture only");
  await new Publication(f.store, github, github).advance(task.id);
  assert.equal(f.store.task(task.id).state, "reconciling");
  assert.ok(github.calls.every((c) => c.startsWith("GET ")));
});
test("debug archives cannot enter formal verification, while a Full+Lite archive is checked using the shared updater validator", async (t) => {
  const f = fixture(t), context = { taskId: randomUUID(), sha: "a".repeat(40), version: "1.5.2", platform: "windows" as const };
  const debug = await buildArchive(context);
  const path = join(f.directory, "artifact.zip");
  await writeFile(path, debug.archive);
  await assert.rejects(verifyArchive(path, { ...context, purpose: "formal-import" }, debug.digest, new AbortController().signal));
  const formal = await buildArchive(context, async (dir) => {
    await rm(join(dir, "release-center-manifest.json"));
    const binary = Buffer.from("unsigned fixture; not an installable EXE");
    const name = "Nowen-Note-Lite-1.5.2-setup.exe";
    const sha512 = createHash("sha512").update(binary).digest("base64");
    await writeFile(join(dir, name), binary);
    await writeFile(join(dir, "Nowen-Note-Lite-1.5.2-portable.exe"), binary);
    await writeFile(join(dir, `${name}.blockmap`), "fixture blockmap");
    await writeFile(join(dir, "latest-lite.yml"), `version: 1.5.2\nfiles:\n  - url: ${name}\n    size: ${binary.length}\n    sha512: ${sha512}\npath: ${name}\nsha512: ${sha512}\n`);
  });
  await writeFile(path, formal.archive);
  const verified = await verifyArchive(path, { ...context, purpose: "formal-import" }, archiveDigest(formal.archive), new AbortController().signal);
  assert.equal(verified.files.length, 8);
  assert.ok(verified.files.some((f) => f.name === "latest-lite.yml"));
  await assert.rejects(verifyArchive(path, { ...context, purpose: "formal-import" }, `sha256:${"0".repeat(64)}`, new AbortController().signal));
});

async function verifiedFixture(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t), github = new FormalGitHub();
  const publication = new Publication(f.store, github, github, { drafts: true, publish: true, maintainerId: 42 });
  const task = await publication.importRun(input());
  const candidate = publication.candidate(task.publication!.candidateId);
  candidate.verifications = (["windows", "macos", "linux"] as const).map((platform, i) => ({ platform, artifactId: 100 + i, archiveDigest: `sha256:${"b".repeat(64)}`,
    verifiedAt: new Date().toISOString(), metadata: [], files: [{ name: `fixture-${platform}.zip`, architecture: "x64", size: 10, sha256: "d".repeat(64), updaterMetadata: false }] }));
  candidate.digest = "c".repeat(64); candidate.state = "verified";
  f.store.db.prepare("UPDATE release_candidates SET data=? WHERE id=?").run(JSON.stringify(candidate), candidate.id);
  task.state = "succeeded"; f.store.save(task, "fixture.only", "Synthetic verified state for permission/rejection tests only; not content validation");
  github.authenticatedUser = async () => ({ id: 42, login: "fixture-maintainer", type: "User" });
  github.request = async (path, method = "GET") => {
    github.calls.push(`${method} ${path}`);
    if (path === "collaborators/fixture-maintainer/permission") return { permission: "write" };
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  };
  return { ...f, github, publication, candidate };
}
test("draft and publish require their own explicit confirmation, configured switches and authenticated maintainer identity", async (t) => {
  const f = await verifiedFixture(t);
  const body = { key: randomUUID(), tag: f.candidate.tag, digest: f.candidate.digest };
  await assert.rejects(f.publication.submit(f.candidate.id, "draft", body), /请确认/);
  await assert.rejects(new Publication(f.store, f.github, f.github).submit(f.candidate.id, "draft", { ...body, confirmDraft: true }), /默认关闭/);
  f.github.authenticatedUser = async () => ({ id: 99, login: "another-maintainer", type: "User" });
  await assert.rejects(f.publication.submit(f.candidate.id, "draft", { ...body, confirmDraft: true }), /身份不符合/);
  f.github.authenticatedUser = async () => ({ id: 42, login: "fixture-maintainer", type: "User" });
  await assert.rejects(f.publication.submit(f.candidate.id, "publish", { ...body, confirmPublish: true }), /尚未审批/);
  assert.equal(f.store.tasks(true).length, 0);
  assert.ok(f.github.calls.every((c) => c.startsWith("GET ")));
});
test("an existing Release is never adopted, overwritten or deleted by Draft preparation", async (t) => {
  const f = await verifiedFixture(t);
  const list = f.github.list.bind(f.github);
  f.github.list = async (path) => path === "releases" ? [{ id: 999, tag_name: "v1.5.2", draft: false }] : list(path);
  const task = await f.publication.submit(f.candidate.id, "draft", { key: randomUUID(), tag: f.candidate.tag, digest: f.candidate.digest, confirmDraft: true });
  await f.publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "failed");
  assert.match(f.store.task(task.id).error!, /同版本/);
  assert.equal(f.publication.candidate(f.candidate.id).draftId, undefined);
  assert.ok(f.github.calls.every((c) => c.startsWith("GET ")));
});
test("a cancelled request with an uncertain publish intent records the confirmed published outcome without another write", async (t) => {
  const f = await verifiedFixture(t);
  const candidate = f.candidate;
  candidate.draftId = 515; candidate.authorId = 42; candidate.state = "publishing";
  f.store.db.prepare("UPDATE release_candidates SET data=? WHERE id=?").run(JSON.stringify(candidate), candidate.id);
  const expectedBody = `${candidate.notes}\n\n### 桌面端支持\n\n- Windows x64 Full / Lite（GitHub 直接下载，安装包未提供代码签名）\n- macOS Intel x64 / Apple Silicon arm64\n- Linux x64\n\n<!-- nowen-release-center:${candidate.id}:${candidate.digest} -->`;
  const assets = candidate.verifications.flatMap((v) => v.files).map((file, i) => ({ id: 900 + i, name: file.name, size: file.size, state: "uploaded", digest: `sha256:${file.sha256}` }));
  f.github.request = async (path, method = "GET") => {
    f.github.calls.push(`${method} ${path}`);
    if (method !== "GET" || path !== "releases/515") throw new Error(`Unexpected fixture request: ${method} ${path}`);
    return { id: 515, tag_name: "v1.5.2", body: expectedBody, author: { id: 42 }, draft: false, prerelease: false, published_at: new Date().toISOString() };
  };
  f.github.list = async (path) => {
    f.github.calls.push(`GET ${path}`);
    if (path.endsWith("/check-runs")) return f.github.checks;
    if (path !== "releases/515/assets") throw new Error(`Unexpected fixture list: ${path}`);
    return assets;
  };
  const at = new Date().toISOString();
  const task = f.store.create({ id: randomUUID(), key: randomUUID(), mode: "publication", plan: makePlan(), createdAt: at, updatedAt: at,
    state: "cancelling", cancelReason: "cancelled", dispatchedAt: at, deadline: Date.now() + 60_000, jobs: [], artifacts: [],
    publication: { candidateId: candidate.id, operation: "publish", intent: { kind: "publish" } } }, "fixture-uncertain-publish");
  await f.publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "succeeded");
  assert.equal(f.publication.candidate(candidate.id).state, "published");
  assert.ok(f.github.calls.every((c) => c.startsWith("GET ")));
});
