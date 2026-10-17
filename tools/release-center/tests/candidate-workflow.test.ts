import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { root } from "./helpers.ts";
// @ts-expect-error JavaScript helper is intentionally not compiled as TypeScript.
import { candidateInput, stageCandidate } from "../../../scripts/release-center-stage-candidate.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const workflow = yaml.load(readFileSync(join(root, ".github/workflows/release-center-candidate.yml"), "utf8"));
const sha = "a".repeat(40), version = "1.5.2";
const identity = (platform: string) => ({ platform, sha, version, requestId: randomUUID(), runId: 1001, runAttempt: 1 });
const fake = (name: string) => Buffer.from("NOT AN INSTALLER: " + name);
const sum512 = (buf: Buffer) => createHash("sha512").update(buf).digest("base64");
function metadata(names: string[], embedded = false) {
  const files = names.map((name) => ({ name, data: fake(name) }));
  return Buffer.from([
    "version: " + version, "files:",
    ...files.flatMap(({ name, data }) => [
      "  - url: " + name, "    size: " + data.length, "    sha512: " + sum512(data),
      ...(embedded ? ["    blockMapSize: 8"] : []),
    ]),
    "path: " + files[0].name, "sha512: " + sum512(files[0].data), "",
  ].join("\n"));
}
async function sources(dir: string, platform: string) {
  await mkdir(join(dir, "dist-electron"));
  await mkdir(join(dir, "dist-electron-lite"));
  const full = join(dir, "dist-electron"), lite = join(dir, "dist-electron-lite");
  const prefix = "Nowen-Note-" + version;
  const save = async (path: string, name: string, value = fake(name)) => writeFile(join(path, name), value);
  if (platform === "windows") {
    const setup = prefix + "-setup.exe", liteSetup = "Nowen-Note-Lite-" + version + "-setup.exe";
    for (const name of [setup, prefix + "-portable.exe", setup + ".blockmap"]) await save(full, name);
    await save(full, "latest.yml", metadata([setup]));
    for (const name of [liteSetup, "Nowen-Note-Lite-" + version + "-portable.exe", liteSetup + ".blockmap"]) await save(lite, name);
    await save(lite, "latest-lite.yml", metadata([liteSetup]));
  } else if (platform === "macos") {
    const intel = prefix + "-x64.dmg", arm = prefix + "-arm64.dmg";
    for (const name of [intel, arm, prefix + "-x64.zip", prefix + "-arm64.zip"]) await save(full, name);
    await save(full, "latest-mac.yml", metadata([intel, arm]));
  } else {
    const app = prefix + "-x86_64.AppImage";
    for (const name of [app, prefix + "-amd64.deb"]) await save(full, name);
    await save(full, "latest-linux.yml", metadata([app], true));
  }
}
test("candidate workflow is dispatch-only, three-platform, unsigned and no release writes", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map((x: any) => x.platform), ["windows", "macos", "linux"]);
  assert.deepEqual(workflow.jobs.build.needs, ["validate", "contracts"]);
  const raw = JSON.stringify(workflow);
  assert.doesNotMatch(raw, /secrets\.|gh release|git push|docker push|release-legacy|TestFlight|apple.*password|MAC_CSC|CSC_LINK/i);
  assert.match(raw, /candidate-evidence/);
  const steps = Object.values(workflow.jobs).flatMap((job: any) => job.steps) as any[];
  const builders = steps.filter((step) => step.run?.includes("electron-builder"));
  assert.equal(builders.length, 5);
  for (const step of builders) assert.match(step.run, /--publish never/);
  for (const step of steps.filter((step) => step.uses?.startsWith("actions/checkout"))) {
    assert.equal(step.with.ref, "${{ inputs.commit_sha }}");
    assert.equal(step.with["persist-credentials"], false);
  }
  for (const step of steps.filter((step) => step.run)) assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./);
});
test("candidate identity rejects partial releases, shell-like inputs and missing run provenance", () => {
  for (const bad of [
    { version: "1.5.2-rc.1" }, { version: "01.5.2" },
    { sha: "main" }, { sha: "a".repeat(39) + ";" },
    { platform: "ios" }, { runId: 0 }, { runAttempt: -1 }, { requestId: "not-a-uuid" },
  ]) assert.throws(() => candidateInput({ ...identity("windows"), ...bad }));
});
for (const [platform, count] of [["windows", 8], ["macos", 5], ["linux", 3]] as const) {
  test(platform + " stages verified updater metadata with separate nonpublishing evidence", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "nowen-rc-candidate-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await sources(dir, platform);
    const selected = identity(platform);
    const evidence = await stageCandidate(dir, selected);
    assert.equal(evidence.purpose, "candidate-build-only");
    assert.equal(evidence.releaseEligible, false);
    assert.equal(evidence.signed, false);
    assert.equal(evidence.source.sha, selected.sha);
    assert.equal(evidence.source.requestId, selected.requestId);
    assert.equal(evidence.files.length, count);
    const assetDir = join(dir, "rc-candidate", platform, "assets");
    assert.deepEqual((await readdir(assetDir)).sort(), evidence.files.map((f: any) => f.name).sort());
    assert.equal((await readdir(assetDir)).includes("candidate-evidence.json"), false);
    const persisted = JSON.parse(await readFile(join(dir, "rc-candidate", platform, "candidate-evidence.json"), "utf8"));
    assert.deepEqual(persisted, evidence);
    await assert.rejects(stageCandidate(dir, selected), /EEXIST/);
  });
}
test("missing Windows Lite binary fails without leaving staged release candidates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nowen-rc-candidate-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await sources(dir, "windows");
  await rm(join(dir, "dist-electron-lite", "Nowen-Note-Lite-" + version + "-setup.exe"));
  await assert.rejects(stageCandidate(dir, identity("windows")));
  assert.deepEqual(await readdir(join(dir, "rc-candidate")), []);
});
test("tampered updater references block Linux candidate staging", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nowen-rc-candidate-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await sources(dir, "linux");
  await writeFile(join(dir, "dist-electron", "latest-linux.yml"),
    metadata(["Nowen-Note-" + version + "-x86_64.AppImage", "wrong.bin"], true));
  await assert.rejects(stageCandidate(dir, identity("linux")));
  assert.deepEqual(await readdir(join(dir, "rc-candidate")), []);
});
