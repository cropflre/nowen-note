import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const guard = (await readFile(new URL("../release.sh", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

async function runGuard(t, { args = [], state = "completed:success", checkStatus = 0, upload = true, failMetadata = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nowen-release-ci-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "bin"));
  await writeFile(path.join(root, "package.json"), '{"version":"1.5.2"}');
  await writeFile(path.join(root, "scripts/release.sh"), guard);
  await writeFile(path.join(root, "scripts/release-legacy.sh"), upload
    ? 'echo "GitHub Release 产物已上传"; echo "PC 产物"\n' : 'echo "Docker push completed"\n');
  await writeFile(path.join(root, "scripts/release-ci-assets.mjs"), 'import fs from "node:fs"; fs.appendFileSync(process.env.CALLS, "receipt-check\\n"); process.exit(Number(process.env.CHECK_STATUS));\n');
  for (const [name, content] of [
    ["docker", "#!/bin/sh\nexit 1\n"],
    ["git", `#!/bin/sh\nprintf '%s' '${"a".repeat(40)}'\n`],
    ["gh", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "release" && args[1] === "view") {
  if (args.includes("assets")) {
    if (process.env.FAIL_METADATA === "1") process.exit(1);
    console.log("Nowen-Note-1.5.2-setup.exe");
  }
  else if (args.includes("body")) console.log("### 桌面端支持");
  else if (args.includes("isDraft")) console.log("true");
  else process.exit(2);
} else if (args[0] === "run" && args[1] === "list") {
  console.log(args.includes("push") ? "101" : "202");
} else if (args[0] === "run" && args[1] === "view") console.log(process.env.CI_STATE);
else if (!(["workflow", "release"].includes(args[0]) && ["run", "edit"].includes(args[1]))) process.exit(3);
`],
  ]) await writeFile(path.join(root, "bin", name), content, { mode: 0o755 });
  const callsFile = path.join(root, "calls.txt");
  const result = spawnSync("bash", [path.join(root, "scripts/release.sh"), "--yes", ...args], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, CALLS: callsFile,
      CI_STATE: state, CHECK_STATUS: String(checkStatus), FAIL_METADATA: failMetadata ? "1" : "0", NOWEN_RELEASE_CI_ARTIFACT_TIMEOUT_SECONDS: "10" },
  });
  const calls = await readFile(callsFile, "utf8").catch(() => "");
  return { ...result, calls };
}

test("Bash publication waits for a successful cloud run and receipt before publishing, with no binary transfer", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.calls.trim().split("\n");
  assert.ok(lines.findIndex((line) => line === "receipt-check") < lines.findIndex((line) => line.includes("--draft=false")));
  assert.doesNotMatch(result.calls, /"download"|"upload"/);
  assert.match(result.calls, /release-assets/);
  assert.match(result.stdout, /发布成功/);
});

test("Bash --draft performs CI verification but never publishes", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { args: ["--draft"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /receipt-check/);
  assert.match(result.calls, /--draft=true/);
  assert.doesNotMatch(result.calls, /--draft=false/);
  assert.doesNotMatch(result.stdout, /发布成功/);
});

for (const settings of [{ state: "completed:failure" }, { checkStatus: 1 }]) {
  test(`Bash cannot publish after CI or receipt failure: ${JSON.stringify(settings)}`, { skip: process.platform === "win32" }, async (t) => {
    const result = await runGuard(t, settings);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.calls, /--draft=false/);
    assert.doesNotMatch(result.stdout, /发布成功/);
  });
}

test("Docker-only runs without a GitHub Release do not dispatch a collection workflow", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { upload: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, "");
});

test("an API failure cannot be mistaken for a release without Windows candidates", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { failMetadata: true });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /release-assets|--draft=false/);
  assert.doesNotMatch(result.stdout, /发布成功/);
});
