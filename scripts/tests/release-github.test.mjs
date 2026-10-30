import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { identity, stageFiles, verifyFiles, publishRelease, assertDockerManifest, assertFullInventory, assertUploadedFiles, prepareSigning, registryDigest } from "../release-github.mjs";

const source = { tag: "v1.5.3", sha: "a".repeat(40), runId: "100", attempt: 1 };
const env = { GITHUB_REPOSITORY: "cropflre/nowen-note", GITHUB_REF: "refs/tags/v1.5.3",
  GITHUB_SHA: source.sha, GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1" };

test("only an immutable stable tag from the release repository is accepted", () => {
  assert.deepEqual(identity(env), source);
  for (const change of [{ GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: "refs/tags/v1.5.3-rc1" },
    { GITHUB_SHA: "main" }, { GITHUB_REPOSITORY: "fork/nowen-note" }, { GITHUB_RUN_ATTEMPT: "0" }])
    assert.throws(() => identity({ ...env, ...change }));
});

test("Android signing properties round-trip special characters through Java Properties", (t) => {
  if (spawnSync("java", ["-version"]).status !== 0) { t.skip("Java is unavailable"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-signing-properties-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "app"));
  const password = " leading\\space:=#\n中文🔑";
  prepareSigning(dir, { NOWEN_ANDROID_KEYSTORE_B64: Buffer.from("keystore fixture").toString("base64"),
    NOWEN_ANDROID_KEYSTORE_PASSWORD: password, NOWEN_ANDROID_KEY_ALIAS: "nowen-release", NOWEN_ANDROID_KEY_PASSWORD: password });
  const java = path.join(dir, "ReadProperties.java");
  fs.writeFileSync(java, 'import java.util.*;import java.io.*;class ReadProperties { public static void main(String[] args)throws Exception {var p=new Properties();try(var in=new FileInputStream(args[0])){p.load(in);}System.out.print(Base64.getEncoder().encodeToString(p.getProperty("storePassword").getBytes(java.nio.charset.StandardCharsets.UTF_8)));}}');
  const result = spawnSync("java", [java, path.join(dir, "keystore.properties")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.from(result.stdout, "base64").toString(), password);
  assert.equal(fs.readFileSync(path.join(dir, "app/github-release.keystore"), "utf8"), "keystore fixture");
});

test("artifact evidence rejects corruption, extra files, another run and future attempts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-github-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "Nowen-Note-1.5.3.apk");
  fs.writeFileSync(file, "signed apk fixture");
  const evidence = stageFiles(dir, "android", source);
  assert.equal(verifyFiles(dir, "android", source).length, 1);
  // Failed-job reruns may consume successful jobs from the previous attempt.
  assert.equal(verifyFiles(dir, "android", { ...source, attempt: 2 }).length, 1);
  assert.throws(() => verifyFiles(dir, "android", { ...source, runId: "101" }));
  fs.writeFileSync(file, "tampered");
  assert.throws(() => verifyFiles(dir, "android", source));
  fs.writeFileSync(file, "signed apk fixture");
  fs.writeFileSync(path.join(dir, "old.apk"), "unexpected");
  assert.throws(() => verifyFiles(dir, "android", source));
  fs.unlinkSync(path.join(dir, "old.apk"));
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ ...evidence, attempt: 2 }));
  assert.throws(() => verifyFiles(dir, "android", source));
});

test("a missing second UPK architecture cannot silently pass", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-github-upk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "amd64_com.nowen.note_1.5.3.1.upk"), "upk");
  assert.throws(() => stageFiles(dir, "upk", source));
});

test("Docker promotion requires the tested digests and both Linux architectures", () => {
  const manifest = { manifests: [
    { platform: { os: "linux", architecture: "amd64" }, digest: "sha256:a" },
    { platform: { os: "linux", architecture: "arm64" }, digest: "sha256:b" },
  ] };
  assertDockerManifest(manifest, ["sha256:a", "sha256:b"]);
  assert.throws(() => assertDockerManifest(manifest, ["sha256:old", "sha256:b"]));
  assert.throws(() => assertDockerManifest({ manifests: manifest.manifests.slice(0, 1) }, ["sha256:a"]));
});

test("Docker registry digests are parsed from structured manifest output", () => {
  const digest = "sha256:" + "a".repeat(64);
  assert.equal(registryDigest(JSON.stringify({ digest, manifests: [] })), digest);
  assert.throws(() => registryDigest("Name: image\nDigest: " + digest));
  assert.throws(() => registryDigest(JSON.stringify({ digest: "latest" })));
});

test("full inventory rejects a missing platform and unrelated stale assets", () => {
  const require = createRequire(import.meta.url);
  const { requiredMacReleaseAssets, requiredDebugReleaseAssets } = require("../lib/release-platform-assets.cjs");
  const names = [...requiredMacReleaseAssets("1.5.3"), ...requiredDebugReleaseAssets("linux", "1.5.3"),
    ...["Nowen-Note", "Nowen-Note-Lite"].flatMap(prefix => [`${prefix}-1.5.3-setup.exe`, `${prefix}-1.5.3-portable.exe`, `${prefix}-1.5.3-setup.exe.blockmap`]),
    "latest.yml", "latest-lite.yml", "Nowen-Note-1.5.3.apk"];
  const assets = names.map(name => ({ name }));
  assertFullInventory(assets, source, ["Nowen-Note-1.5.3.apk"]);
  assert.throws(() => assertFullInventory(assets.slice(1), source, ["Nowen-Note-1.5.3.apk"]));
  assert.throws(() => assertFullInventory([...assets, { name: "old.apk" }], source, ["Nowen-Note-1.5.3.apk"]));
});

test("supplemental packages cannot change while desktop collection is running", () => {
  const expected = [{ name: "Nowen-Note-1.5.3.apk", size: 10, digest: "sha256:original" }];
  assertUploadedFiles(expected, expected);
  assert.throws(() => assertUploadedFiles([{ ...expected[0], digest: "sha256:changed" }], expected));
  assert.throws(() => assertUploadedFiles([{ ...expected[0], size: 11 }], expected));
  assert.throws(() => assertUploadedFiles([], expected));
});

function publicationFixture(settings = {}) {
  const calls = [];
  const release = { id: 7, tag_name: source.tag, draft: true, assets: [
    { id: 1, name: "test.apk", size: 3, digest: "sha256:test", updated_at: "now" },
  ] };
  return { calls, release, deps: {
    readRelease: () => { calls.push("read"); return structuredClone(release); },
    assertTag: () => { calls.push("tag"); if (settings.movedTag) throw Error("tag moved"); },
    promoteDocker: () => { calls.push("docker"); if (settings.dockerFailure) throw Error("push failed"); },
    verifyRemote: () => { calls.push("verify"); if (settings.changed) release.assets[0].digest = "sha256:changed"; },
    editRelease: () => { calls.push("publish"); release.draft = false; },
  } };
}

test("Draft mode never pushes Docker or publishes; formal publication follows verification", async () => {
  const draft = publicationFixture();
  await publishRelease(source, false, draft.release.assets, draft.deps);
  assert.ok(!draft.calls.includes("docker") && !draft.calls.includes("publish"));
  const formal = publicationFixture();
  await publishRelease(source, true, formal.release.assets, formal.deps);
  assert.ok(formal.calls.indexOf("verify") < formal.calls.indexOf("docker"));
  assert.ok(formal.calls.indexOf("docker") < formal.calls.indexOf("publish"));
});

test("moved tags, changing assets, published releases and Docker failure block publication", async () => {
  for (const settings of [{ movedTag: true }, { changed: true }, { dockerFailure: true }, { published: true }]) {
    const f = publicationFixture(settings);
    if (settings.published) f.release.draft = false;
    await assert.rejects(publishRelease(source, true, f.release.assets, f.deps));
    assert.ok(!f.calls.includes("publish"));
  }
});

test("hosted workflow gates publication on all build jobs and keeps secrets away from pull requests", () => {
  const require = createRequire(import.meta.url);
  const workflow = require("js-yaml").load(fs.readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.deepEqual(workflow.jobs.publish.needs, ["prepare", "desktop", "android", "docker", "packages", "upk"]);
  assert.match(workflow.jobs.publish.if, /needs\.upk\.result == 'skipped'/);
  assert.equal(workflow.jobs.publish.permissions.contents, "write");
  for (const job of Object.values(workflow.jobs)) {
    assert.doesNotMatch(JSON.stringify(job["runs-on"]), /self-hosted/);
    assert.ok(job.steps.filter(s => s.uses?.startsWith("actions/checkout@")).every(s => s.with?.["persist-credentials"] === false));
  }
});
