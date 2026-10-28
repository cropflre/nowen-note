import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  assertCompleteMacReleaseAssets,
  findMissingMacReleaseAssets,
  isMacManualDownloadZip,
  requiredMacReleaseAssets,
} = require("../lib/release-platform-assets.cjs");

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "../..");

async function readRepoFile(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

test("tag 构建工作流不让 electron-builder 直接发布 GitHub Release", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.match(workflow, /node-version:\s*["']24\.22\.1["']/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*actions:\s*read/);
  const jobs = require("js-yaml").load(workflow).jobs;
  const builderCommands = Object.values(jobs)
    .flatMap((job) => job.steps || [])
    .map((step) => step.run)
    .filter((command) => typeof command === "string" && command.includes("electron-builder"));
  assert.equal(builderCommands.length, 5);
  for (const command of builderCommands) assert.match(command, /--publish never\b/);
  assert.doesNotMatch(workflow, /--publish always/);
  assert.ok(jobs.build.if.includes("inputs.mode == 'debug'"));
  assert.ok(jobs.build.steps.every((step) => !step.env?.GH_TOKEN));
  assert.equal(jobs["release-assets"].permissions.contents, "write");
  assert.equal(jobs["release-assets"].permissions.actions, "read");
  assert.match(jobs["release-assets"].if, /workflow_dispatch/);
  assert.match(jobs["release-assets"].if, /refs\/tags\/v/);
  assert.equal(jobs["release-assets"].concurrency["cancel-in-progress"], false);
  assert.ok(jobs["release-assets"].steps.some((step) => step.run === "node scripts/release-ci-assets.mjs collect"));
  assert.ok(jobs["release-assets"].steps.some((step) => step.uses === "actions/upload-artifact@v4"));
});

test("Windows GitHub Direct EXE never requires third-party signer", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.doesNotMatch(workflow, /signpath|SIGNPATH/i);
  assert.doesNotMatch(workflow, /NOWEN_WINDOWS_PUBLISHER_NAME/);
  assert.doesNotMatch(workflow, /submit-signing-request/);
  assert.match(workflow, /name: nowen-note-win-direct/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
  assert.match(workflow, /Verify direct Windows SHA-512 metadata and assets/);
  assert.match(workflow, /scripts\/verify-release-update-assets\.mjs local/);
  assert.match(workflow, /Nowen-Note-Lite-\$version-setup\.exe/);
  assert.match(workflow, /latest-lite\.yml/);
  assert.match(workflow, /if-no-files-found: error/);
});

test("local release waits for same-tag CI collection and checks receipt before publication without transferring binaries", async () => {
  const guard = await readRepoFile("scripts/release-local.sh");
  assert.match(guard, /--event push/);
  assert.match(guard, /--commit "\$tag_sha"/);
  assert.match(guard, /--branch "\$TAG"/);
  assert.match(guard, /gh workflow run release\.yml/);
  assert.match(guard, /-f mode=release-assets/);
  assert.match(guard, /-f source_run_id="\$SOURCE_RUN_ID"/);
  assert.match(guard, /--ref "\$TAG"/);
  assert.match(guard, /completed:success/);
  assert.match(guard, /node "\$CI_ASSETS_SCRIPT" check/);
  assert.doesNotMatch(guard, /gh run download|gh release upload|node "\$VERIFY_SCRIPT" remote/);
  const check = guard.indexOf('node "$CI_ASSETS_SCRIPT" check');
  const publish = guard.indexOf('--draft=false');
  assert.ok(check >= 0 && publish > check);
  assert.ok(guard.indexOf('发布成功：') > publish);
  assert.match(guard, /NOWEN_RELEASE_GUARDED=1 bash/);
});

test("cloud collector keeps Mac independent of failed Windows jobs and uses existing local and remote validators", async () => {
  const collector = await readRepoFile("scripts/release-ci-assets.mjs");
  assert.match(collector, /nowen-note-mac/);
  assert.match(collector, /nowen-note-win-direct/);
  assert.match(collector, /options.desktop && "mac", options.windows && "win"/);
  assert.match(collector, /verifyLocalDirectory/);
  assert.match(collector, /verify-release-update-assets\.mjs/);
  assert.match(collector, /uploaded SHA-256 mismatch/);
  assert.doesNotMatch(collector, /--draft=false|release", "create/);
});

test("legacy upload messages do not announce completed guarded publication", async () => {
  const legacy = await readRepoFile("scripts/release-legacy.sh");
  assert.match(legacy, /GitHub Release 产物已上传/);
  assert.doesNotMatch(legacy, /GitHub Release 已发布/);
  assert.match(legacy, /NOWEN_RELEASE_GUARDED/);
  assert.match(legacy, /尚未完成发布/);
  assert.match(legacy, /Draft 产物已上传，尚未正式发布/);
});

test("完整桌面 Release 会写明四个平台支持情况", async () => {
  const releaseGuard = await readRepoFile("scripts/release-local.sh");
  assert.match(releaseGuard, /ensure_desktop_platform_notes/);
  assert.match(releaseGuard, /### 桌面端支持/);
  assert.match(releaseGuard, /Windows x64（GitHub 直接下载，安装包当前未提供代码签名）/);
  assert.match(releaseGuard, /macOS Intel x64/);
  assert.match(releaseGuard, /macOS Apple Silicon arm64/);
  assert.match(releaseGuard, /Linux x64/);
});

test("完整桌面 Release 的远端校验会阻止 macOS 平台整体缺失", async () => {
  const verifier = await readRepoFile("scripts/verify-release-update-assets.mjs");
  assert.match(verifier, /assertCompleteMacReleaseAssets/);
  assert.match(verifier, /byName\.has\("latest\.yml"\) && byName\.has\("latest-linux\.yml"\)/);
  assert.match(verifier, /remote Release \$\{tag\} macOS assets/);
  assert.match(verifier, /!isMacManualDownloadZip\(name\)/);
});

test("macOS 发版资产必须同时包含 Intel、Apple Silicon 与更新元数据", () => {
  const version = "1.4.16";
  const required = requiredMacReleaseAssets(version);
  assert.deepEqual(required, [
    "Nowen-Note-1.4.16-x64.dmg",
    "Nowen-Note-1.4.16-arm64.dmg",
    "Nowen-Note-1.4.16-x64.zip",
    "Nowen-Note-1.4.16-arm64.zip",
    "latest-mac.yml",
  ]);
  assert.deepEqual(findMissingMacReleaseAssets(required, version), []);
  assert.doesNotThrow(() => assertCompleteMacReleaseAssets(required, version));
});

test("macOS 双架构 ZIP 按手动下载资产处理", () => {
  assert.equal(isMacManualDownloadZip("Nowen-Note-1.4.16-x64.zip"), true);
  assert.equal(isMacManualDownloadZip("Nowen-Note-1.4.16-arm64.zip"), true);
  assert.equal(isMacManualDownloadZip("Nowen-Note-1.4.16-setup.exe"), false);
});

test("Windows Node ZIP 使用 PowerShell Expand-Archive 解压", async () => {
  const fetchNode = await readRepoFile("scripts/fetch-node.mjs");
  assert.match(fetchNode, /process\.platform === "win32"/);
  assert.match(fetchNode, /powershell\.exe/);
  assert.match(fetchNode, /Expand-Archive/);
});

test("debug Linux artifact names follow electron-builder target-specific architecture expansion", () => {
  const { requiredDebugReleaseAssets } = require("../lib/release-platform-assets.cjs");
  const { Arch, getArtifactArchName } = require("builder-util");
  const names = requiredDebugReleaseAssets("linux", "1.5.2");
  for (const extension of ["AppImage", "deb"]) {
    assert.ok(names.includes(`Nowen-Note-1.5.2-${getArtifactArchName(Arch.x64, extension)}.${extension}`));
  }
  assert.ok(names.includes("latest-linux.yml"));
});
