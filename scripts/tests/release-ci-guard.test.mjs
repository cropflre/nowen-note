import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const guard = (await readFile(new URL("../release.sh", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const legacy = (await readFile(new URL("../release-legacy.sh", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

async function runGuard(t, { args = [], state = "completed:success", checkStatus = 0, upload = true, failMetadata = false, realLegacy = false, releaseExists = false, published = false, wizardOnly = false, ciPlatforms = "" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nowen-release-ci-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, "dist-electron"));
  await writeFile(path.join(root, "dist-electron", "existing-output"), "preserve");
  await writeFile(path.join(root, "package.json"), '{"version":"1.5.2"}');
  await writeFile(path.join(root, "scripts/release.sh"), guard);
  const wizard = legacy.slice(0, legacy.indexOf("# ===== 自动推断 --atomic"))
    + '\nprintf "WIZARD_DESKTOP=%s\\nWIZARD_PLATFORMS=%s\\n" "$DESKTOP_BUILD" "$PC_PLATFORMS"\n';
  await writeFile(path.join(root, "scripts/release-legacy.sh"), wizardOnly ? wizard : ciPlatforms
    ? `echo "GitHub Release 产物已上传"; echo "NOWEN_RELEASE_CI_PLATFORMS=${ciPlatforms}"\n` : realLegacy ? legacy : upload
    ? 'echo "GitHub Release 产物已上传"; echo "PC 产物"\n' : 'echo "Docker push completed"\n');
  await writeFile(path.join(root, "scripts/release-ci-assets.mjs"), 'import fs from "node:fs"; fs.appendFileSync(process.env.CALLS, "receipt-check\\n"); process.exit(Number(process.env.CHECK_STATUS));\n');
  for (const [name, content] of [
    ["docker", "#!/bin/sh\nexit 1\n"],
    ["curl", "#!/bin/sh\nexit 1\n"],
    ["npm", "#!/bin/sh\necho unexpected-local-build >&2\nexit 99\n"],
    ["git", `#!/bin/sh
if [ "$REAL_LEGACY" = "1" ]; then
  case "$*" in
    'rev-parse refs/tags/'*) exit 1 ;;
    'tag --list'*|'ls-remote'*) exit 0 ;;
    'rev-parse --abbrev-ref HEAD') echo main; exit 0 ;;
    'diff --cached --stat') exit 0 ;;
  esac
fi
printf '%s' '${"a".repeat(40)}'
`],
    ["gh", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "release" && args[1] === "view") {
  if (!args.includes("--json")) process.exit(process.env.RELEASE_EXISTS === "1" ? 0 : 1);
  if (args.includes("assets")) {
    if (process.env.FAIL_METADATA === "1") process.exit(1);
    console.log("Nowen-Note-1.5.2-setup.exe");
  }
  else if (args.includes("body")) console.log("### 桌面端支持");
  else if (args.includes("isDraft")) console.log(process.env.PUBLISHED === "1" ? "false" : "true");
  else process.exit(2);
} else if (args[0] === "run" && args[1] === "list") {
  console.log(args.includes("push") ? "101" : "202");
} else if (args[0] === "run" && args[1] === "view") console.log(process.env.CI_STATE);
else if (!(args[0] === "auth" || (["workflow", "release"].includes(args[0]) && ["run", "edit", "create"].includes(args[1])))) process.exit(3);
`],
  ]) await writeFile(path.join(root, "bin", name), content, { mode: 0o755 });
  const callsFile = path.join(root, "calls.txt");
  const result = spawnSync("bash", [path.join(root, "scripts/release.sh"), ...(wizardOnly ? [] : ["--yes"]), ...args], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    input: wizardOnly ? "5\n\n" : undefined,
    env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, CALLS: callsFile,
      REAL_LEGACY: realLegacy ? "1" : "0", RELEASE_EXISTS: releaseExists ? "1" : "0", PUBLISHED: published ? "1" : "0",
      CI_STATE: state, CHECK_STATUS: String(checkStatus), FAIL_METADATA: failMetadata ? "1" : "0", NOWEN_RELEASE_CI_ARTIFACT_TIMEOUT_SECONDS: "10" },
  });
  const calls = await readFile(callsFile, "utf8").catch(() => "");
  const existingOutput = await readFile(path.join(root, "dist-electron", "existing-output"), "utf8").catch(() => "");
  return { ...result, calls, existingOutput };
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

const githubArgs = ["--target", "pc,lite", "--desktop-build", "github", "--no-pull", "-v", "1.5.2"];

test("real legacy flow creates an empty Draft and delegates all desktop packaging without local toolchains", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { args: githubArgs, realLegacy: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = result.calls.trim().split("\n").filter((line) => line.startsWith("[")).map((line) => JSON.parse(line));
  const create = calls.find((args) => args[0] === "release" && args[1] === "create");
  assert.ok(create?.includes("--draft"));
  assert.ok(!create.some((arg) => /\.(exe|deb|AppImage|dmg)$/.test(arg)));
  const dispatch = calls.find((args) => args[0] === "workflow");
  for (const platform of ["desktop", "windows", "linux"]) assert.ok(dispatch.includes(`${platform}=true`));
  assert.match(result.calls, /receipt-check/);
  assert.match(result.calls, /--draft=false/);
  assert.doesNotMatch(result.stdout + result.stderr, /unexpected-local-build|PC 端打包（|Lite 版打包（|缺 wine/);
  assert.doesNotMatch(result.calls, /"upload"|"download"/);
  assert.equal(result.existingOutput, "preserve");
});

test("GitHub linux-app selects Linux only and preserves an existing Draft", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { args: [...githubArgs, "--target", "linux-app", "--draft"], realLegacy: true, releaseExists: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.calls, /desktop=false/);
  assert.match(result.calls, /windows=false/);
  assert.match(result.calls, /linux=true/);
  assert.doesNotMatch(result.calls, /"create"|"upload"|--draft=false/);
});

for (const args of [["--target", "pc", "--pc-platform", "win"], ["--target", "lite"]]) {
  test(`Windows-only CI selection works without local builds: ${args.join(" ")}`, { skip: process.platform === "win32" }, async (t) => {
    const result = await runGuard(t, { args: [...githubArgs, ...args], realLegacy: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.calls, /desktop=false/);
    assert.match(result.calls, /windows=true/);
    assert.match(result.calls, /linux=false/);
    assert.doesNotMatch(result.stdout + result.stderr, /unexpected-local-build/);
  });
}

for (const [args, expected] of [
  [["--linux-arch", "arm64"], /仅支持 x64/],
  [["--no-github-release"], /需要发布模式和 GitHub Release/],
  [["--desktop-build", "unknown"], /只能是 local \/ github/],
  [["--pc-platform", ",,,", "--target", "pc"], /至少包含一个平台/],
  [["--pc-platform", "win,linux"], /需要同时包含 macOS/],
]) {
  test(`unsupported GitHub packaging options fail before any release mutation: ${args.join(" ")}`, { skip: process.platform === "win32" }, async (t) => {
    const result = await runGuard(t, { args: [...githubArgs, ...args], realLegacy: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, expected);
    assert.doesNotMatch(result.calls, /"create"|"upload"|"workflow"|--draft=false/);
  });
}

test("real GitHub desktop flow cannot replace a published Release", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { args: githubArgs, realLegacy: true, releaseExists: true, published: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /不能替换已发布版本/);
  assert.doesNotMatch(result.calls, /"upload"|"workflow"|--draft=false/);
});

test("real GitHub desktop flow leaves its empty Draft unpublished after CI failure", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { args: githubArgs, realLegacy: true, state: "completed:failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.calls, /"create"/);
  assert.doesNotMatch(result.calls, /receipt-check|--draft=false/);
});

test("GitHub desktop dry-run describes cloud packaging without dispatching or creating a Release", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { args: [...githubArgs, "--dry-run"], realLegacy: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /GitHub Actions/);
  assert.doesNotMatch(result.calls, /"create"|"workflow"|receipt-check/);
  assert.equal(result.existingOutput, "preserve");
});

test("menu option 5 defaults to GitHub desktop packaging and preserves local outputs", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { wizardOnly: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /WIZARD_DESKTOP=github/);
  assert.match(result.stdout, /WIZARD_PLATFORMS=(?=[^\n]*win)(?=[^\n]*mac)(?=[^\n]*linux)/);
  assert.equal(result.existingOutput, "preserve");
});

test("menu option 5 honors an explicit local desktop build", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { wizardOnly: true, args: ["--desktop-build", "local"] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /WIZARD_DESKTOP=local/);
});

test("publisher uses the resolved menu platforms without a desktop-build command-line flag", { skip: process.platform === "win32" }, async (t) => {
  const result = await runGuard(t, { ciPlatforms: "win,mac,linux" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const platform of ["desktop", "windows", "linux"]) assert.match(result.calls, new RegExp(`${platform}=true`));
  assert.match(result.calls, /receipt-check/);
  assert.match(result.calls, /--draft=false/);
});
