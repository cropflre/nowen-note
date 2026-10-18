// Credential-free, deterministic integration tests for the entire formal release lifecycle.
// All GitHub reads/writes are overridden locally. Never use a real GitHub credential.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitHub } from "../server/github.ts";
import { Publication } from "../server/publication.ts";
import { fixture, root } from "./helpers.ts";
import { zipBuffer, archiveDigest } from "./archive-fixture.ts";
import type { Platform } from "../shared.ts";

type Asset = { id: number; name: string; size: number; digest: string; state: "uploaded" };
type ZipFixture = { id: number; name: string; archive: Buffer; digest: string };

const version = "1.5.2";
const sha = "a".repeat(40);
const tag = "v" + version;
const digestFile = (content: Buffer) => "sha256:" + createHash("sha256").update(content).digest("hex");
const checksum = (content: Buffer) => createHash("sha512").update(content).digest("base64");
const bytes = (name: string) => Buffer.from("NOT A REAL INSTALLER; isolated fixture: " + name);

function updater(name: string, entries: { name: string; bytes: Buffer; blockMapSize?: number }[]) {
  return Buffer.from([
    "version: " + version,
    "files:",
    ...entries.flatMap((item) => [
      "  - url: " + item.name,
      "    sha512: " + checksum(item.bytes),
      "    size: " + item.bytes.length,
      ...(item.blockMapSize ? ["    blockMapSize: " + item.blockMapSize] : []),
    ]),
    "path: " + entries[0].name,
    "sha512: " + checksum(entries[0].bytes),
    "",
  ].join("\n"));
}
function platformFiles(platform: Platform): { name: string; data: Buffer }[] {
  const prefix = "Nowen-Note-" + version;
  const file = (name: string) => ({ name, data: bytes(name) });
  if (platform === "windows") {
    const full = file(prefix + "-setup.exe"), lite = file("Nowen-Note-Lite-" + version + "-setup.exe");
    return [
      full, file(prefix + "-portable.exe"), file(full.name + ".blockmap"),
      { name: "latest.yml", data: updater("latest.yml", [{ name: full.name, bytes: full.data }]) },
      lite, file("Nowen-Note-Lite-" + version + "-portable.exe"), file(lite.name + ".blockmap"),
      { name: "latest-lite.yml", data: updater("latest-lite.yml", [{ name: lite.name, bytes: lite.data }]) },
    ];
  }
  if (platform === "macos") {
    const intel = file(prefix + "-x64.dmg"), arm = file(prefix + "-arm64.dmg");
    return [
      intel, arm, file(prefix + "-x64.zip"), file(prefix + "-arm64.zip"),
      { name: "latest-mac.yml", data: updater("latest-mac.yml", [
        { name: intel.name, bytes: intel.data }, { name: arm.name, bytes: arm.data },
      ]) },
    ];
  }
  const app = file(prefix + "-x86_64.AppImage");
  return [
    app, file(prefix + "-amd64.deb"),
    { name: "latest-linux.yml", data: updater("latest-linux.yml", [{ name: app.name, bytes: app.data, blockMapSize: 8 }]) },
  ];
}

class SimulatedGitHub extends GitHub {
  readonly calls: string[] = [];
  readonly zips = new Map<number, ZipFixture>();
  readonly assets: Asset[] = [];
  readonly source = {
    id: 71, path: ".github/workflows/release.yml", event: "push",
    head_branch: tag, head_sha: sha, status: "completed",
    conclusion: "success", run_attempt: 1,
  };
  releaseRecord?: any;
  nextAsset = 901;
  createCount = 0;
  publishCount = 0;
  uploadCount = 0;
  failDraftAfterCommit = false;
  failPublishAfterCommit = false;
  failAssetAfterCommit = false;

  constructor() { super("fixture-token-never-sent"); }

  async prepare() {
    for (const [i, platform] of (["windows", "macos", "linux"] as const).entries()) {
      const archive = await zipBuffer(platformFiles(platform));
      const id = 100 + i;
      this.zips.set(id, { id, name: ["nowen-note-win-direct", "nowen-note-mac", "nowen-note-linux"][i],
        archive, digest: archiveDigest(archive) });
    }
  }
  override async authenticatedUser() { return { id: 42, login: "fixture-maintainer", type: "User" }; }
  override async run() { return structuredClone(this.source); }
  override async tagCommit() { return sha; }
  override async content(path: string) {
    if (path.startsWith(".github/") || path.startsWith("scripts/")) return readFile(join(root, path), "utf8");
    return path.endsWith(".gradle")
      ? 'versionName "' + version + '"'
      : JSON.stringify({ version, packages: { "": { version } } });
  }
  override async jobs() { return []; }
  override async artifacts() {
    return [...this.zips.values()].map((file) => ({
      id: file.id, name: file.name, size: file.archive.length, digest: file.digest,
      expired: false, verification: "not_downloaded" as const,
    }));
  }
  override async artifactMeta(id: number) {
    this.calls.push("GET artifact/" + id);
    const file = this.zips.get(id);
    if (!file) throw Error("Unexpected artifact");
    return { id, name: file.name, size_in_bytes: file.archive.length, digest: file.digest,
      expired: false, workflow_run: { id: this.source.id, head_sha: sha } };
  }
  override async downloadArtifact(id: number, path: string, signal: AbortSignal, maxBytes: number) {
    this.calls.push("GET artifact-zip/" + id);
    signal.throwIfAborted();
    const file = this.zips.get(id);
    if (!file || file.archive.length > maxBytes) throw Error("Unexpected artifact download");
    await writeFile(path, file.archive);
  }
  override async list(path: string, _key?: string): Promise<any[]> {
    this.calls.push("GET " + path);
    if (path.endsWith("/check-runs"))
      return [{ name: "rc1-security", status: "completed", conclusion: "success" }];
    if (path === "releases") return this.releaseRecord ? [structuredClone(this.releaseRecord)] : [];
    if (path.startsWith("releases/") && path.endsWith("/assets")) return structuredClone(this.assets);
    throw Error("Unexpected mock GitHub list " + path);
  }
  override async request(path: string, method = "GET", body?: any): Promise<any> {
    this.calls.push(method + " " + path);
    if (path === "collaborators/fixture-maintainer/permission" && method === "GET") return { permission: "write" };
    if (path === "releases/latest" && method === "GET") return { tag_name: "v1.5.1" };
    if (path === "releases" && method === "POST") {
      if (this.releaseRecord) throw Error("Duplicate remote Draft forbidden");
      this.createCount++;
      this.releaseRecord = {
        id: 515, tag_name: body.tag_name, body: body.body, draft: true,
        prerelease: false, author: { id: 42 }, published_at: null, immutable: false,
      };
      if (this.failDraftAfterCommit) {
        this.failDraftAfterCommit = false;
        throw Error("Fixture connection dropped AFTER remote Draft commit");
      }
      return structuredClone(this.releaseRecord);
    }
    if (path === "releases/515" && method === "GET") {
      if (!this.releaseRecord) throw Error("Remote Release missing");
      return structuredClone(this.releaseRecord);
    }
    if (path === "releases/515" && method === "PATCH") {
      if (!this.releaseRecord?.draft || body?.draft !== false) throw Error("Unsafe PATCH");
      this.publishCount++;
      this.releaseRecord.draft = false;
      this.releaseRecord.published_at = new Date().toISOString();
      if (this.failPublishAfterCommit) {
        this.failPublishAfterCommit = false;
        throw Error("Fixture connection dropped AFTER remote Publish commit");
      }
      return structuredClone(this.releaseRecord);
    }
    throw Error("Unknown simulated request " + method + " " + path);
  }
  override async uploadReleaseAsset(releaseId: number, name: string, path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.releaseRecord?.draft || releaseId !== 515 || this.assets.some((a) => a.name === name))
      throw Error("Unsafe duplicate/foreign asset upload");
    const data = await readFile(path);
    this.uploadCount++;
    this.calls.push("POST asset/" + name);
    const record: Asset = {
      id: this.nextAsset++, name, size: data.length, digest: digestFile(data), state: "uploaded",
    };
    this.assets.push(record);
    if (this.failAssetAfterCommit) {
      this.failAssetAfterCommit = false;
      throw Error("Fixture connection dropped AFTER remote asset upload");
    }
    return structuredClone(record);
  }
}
const request = () => ({ version, runId: 71, notes: "Isolated release lifecycle fixture only", key: randomUUID() });

async function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t);
  const github = new SimulatedGitHub();
  await github.prepare();
  const publication = new Publication(f.store, github, github, { drafts: true, publish: true, maintainerId: 42 });
  const initial = await publication.importRun(request());
  return { ...f, github, publication, initial, candidateId: initial.publication!.candidateId };
}
async function verify(f: Awaited<ReturnType<typeof setup>>) {
  await f.publication.advance(f.initial.id);
  assert.equal(f.store.task(f.initial.id).state, "succeeded", f.store.task(f.initial.id).error);
  const candidate = f.publication.candidate(f.candidateId);
  assert.equal(candidate.state, "verified");
  assert.ok(candidate.digest);
  assert.deepEqual(candidate.verifications.map((x) => [x.platform, x.files.length]),
    [["windows", 8], ["macos", 5], ["linux", 3]]);
  return candidate;
}
async function draft(f: Awaited<ReturnType<typeof setup>>, candidate: Awaited<ReturnType<typeof verify>>) {
  const task = await f.publication.submit(candidate.id, "draft",
    { key: randomUUID(), tag, digest: candidate.digest, confirmDraft: true });
  await f.publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "succeeded", f.store.task(task.id).error);
  assert.equal(f.publication.candidate(candidate.id).state, "draft");
  assert.equal(f.github.assets.length, 16);
  return task;
}

test("formal complete lifecycle: 3 real ZIP validators -> Draft/16 uploads -> immutable approval -> publish", async (t) => {
  const f = await setup(t);
  const verified = await verify(f);
  assert.equal(f.github.createCount, 0);
  await draft(f, verified);
  assert.equal(f.github.createCount, 1);
  const approved = await f.publication.approve(f.candidateId,
    { tag, digest: verified.digest, confirmApproval: true });
  assert.equal(approved.state, "approved");
  const task = await f.publication.submit(f.candidateId, "publish",
    { key: randomUUID(), tag, digest: verified.digest, confirmPublish: true });
  await f.publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "succeeded", f.store.task(task.id).error);
  assert.equal(f.publication.candidate(f.candidateId).state, "published");
  assert.equal(f.github.releaseRecord?.draft, false);
  assert.equal(f.github.publishCount, 1);
  assert.equal(f.github.uploadCount, 16);
  assert.equal(f.github.calls.filter((x) => x === "POST releases").length, 1);
  assert.equal(f.github.calls.filter((x) => x === "PATCH releases/515").length, 1);
  assert.ok(f.github.calls.every((x) => !x.startsWith("DELETE ") && !x.startsWith("PUT ")));
});
test("Draft response lost after remote write: restart reconciles without another POST", async (t) => {
  const f = await setup(t);
  const candidate = await verify(f);
  f.github.failDraftAfterCommit = true;
  const task = await f.publication.submit(candidate.id, "draft",
    { key: randomUUID(), tag, digest: candidate.digest, confirmDraft: true });
  await f.publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "reconciling");
  assert.equal(f.store.task(task.id).publication?.intent?.kind, "draft");
  const interrupted = f.store.task(task.id);
  interrupted.publication!.retryAt = 0;
  f.store.save(interrupted, "fixture.restart", "Simulated service restart after POST");
  const restarted = new Publication(f.store, f.github, f.github,
    { drafts: true, publish: true, maintainerId: 42 });
  await restarted.advance(task.id);
  assert.equal(f.store.task(task.id).state, "succeeded", f.store.task(task.id).error);
  assert.equal(f.github.createCount, 1);
  assert.equal(f.github.uploadCount, 16);
});
test("Publish response lost: remote read reconciles success, not a duplicate PATCH", async (t) => {
  const f = await setup(t);
  const candidate = await verify(f);
  await draft(f, candidate);
  await f.publication.approve(candidate.id, { tag, digest: candidate.digest, confirmApproval: true });
  f.github.failPublishAfterCommit = true;
  const task = await f.publication.submit(candidate.id, "publish",
    { key: randomUUID(), tag, digest: candidate.digest, confirmPublish: true });
  await f.publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "reconciling");
  const interrupted = f.store.task(task.id);
  interrupted.publication!.retryAt = 0;
  f.store.save(interrupted, "fixture.restart", "Simulated crash following remote publish");
  const restarted = new Publication(f.store, f.github, f.github,
    { drafts: true, publish: true, maintainerId: 42 });
  await restarted.advance(task.id);
  assert.equal(f.store.task(task.id).state, "succeeded", f.store.task(task.id).error);
  assert.equal(restarted.candidate(candidate.id).state, "published");
  assert.equal(f.github.publishCount, 1);
});
test("Remote asset tampering after approval blocks publish without any PATCH", async (t) => {
  const f = await setup(t);
  const candidate = await verify(f);
  await draft(f, candidate);
  await f.publication.approve(candidate.id, { tag, digest: candidate.digest, confirmApproval: true });
  f.github.assets[0].digest = "sha256:" + "f".repeat(64);
  const task = await f.publication.submit(candidate.id, "publish",
    { key: randomUUID(), tag, digest: candidate.digest, confirmPublish: true });
  await f.publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "failed");
  assert.equal(f.github.publishCount, 0);
  assert.equal(f.github.releaseRecord?.draft, true);
  assert.equal(f.publication.candidate(candidate.id).state, "blocked");
});

test("Asset upload response lost: recover by remote digest without duplicate upload", async (t) => {
  const f = await setup(t);
  const candidate = await verify(f);
  f.github.failAssetAfterCommit = true;
  const task = await f.publication.submit(candidate.id, "draft",
    { key: randomUUID(), tag, digest: candidate.digest, confirmDraft: true });
  await f.publication.advance(task.id);
  assert.equal(f.store.task(task.id).state, "reconciling");
  assert.equal(f.store.task(task.id).publication?.intent?.kind, "asset");
  assert.equal(f.github.assets.length, 1);
  const interrupted = f.store.task(task.id);
  interrupted.publication!.retryAt = 0;
  f.store.save(interrupted, "fixture.restart", "Simulated crash following asset upload");
  const restarted = new Publication(f.store, f.github, f.github,
    { drafts: true, publish: true, maintainerId: 42 });
  await restarted.advance(task.id);
  assert.equal(f.store.task(task.id).state, "succeeded", f.store.task(task.id).error);
  assert.equal(restarted.candidate(candidate.id).state, "draft");
  assert.equal(f.github.createCount, 1);
  assert.equal(f.github.assets.length, 16);
  assert.equal(f.github.uploadCount, 16);
});
