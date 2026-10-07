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
  assert.match(workflow, /node-version:\s*["']22["']/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*actions:\s*read/);
  const jobs = require("js-yaml").load(workflow).jobs;
  const builderCommands = Object.values(jobs)
    .flatMap((job) => job.steps || [])
    .map((step) => step.run)
    .filter((command) => typeof command === "string" && command.includes("electron-builder"));
  assert.equal(builderCommands.length, 5);
  for (const command of builderCommands) assert.match(command, /--publish never\b/);
  assert.doesNotMatch(workflow, /--publish always/);
  assert.doesNotMatch(workflow, /GH_TOKEN:/);
});

test("手动 workflow 只使用 SignPath test-signing 且使用 Full Artifact Configuration", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  const testBlock = workflow.slice(
    workflow.indexOf("- name: Stage Windows EXEs for SignPath test"),
    workflow.indexOf("# ========= tag 正式发布"),
  );
  assert.match(testBlock, /workflow_dispatch/);
  assert.match(testBlock, /signing-policy-slug:\s*["']test-signing["']/);
  assert.match(testBlock, /artifact-configuration-slug:\s*\$\{\{ vars\.SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG \}\}/);
  assert.match(testBlock, /version:\s*\$\{\{ toJSON\(steps\.package_version\.outputs\.version\) \}\}/);
  assert.match(testBlock, /SIGNPATH_ORGANIZATION_ID/);
  assert.match(testBlock, /SIGNPATH_PROJECT_SLUG/);
  assert.match(testBlock, /nowen-note-win-signpath-test/);
  assert.doesNotMatch(testBlock, /release-signing/);
  assert.doesNotMatch(testBlock, /SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG/);
  assert.doesNotMatch(testBlock, /refs\/tags/);
});

test("tag Windows 正式发布必须经过 Full Lite 独立 SignPath 配置和签名后校验", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.match(workflow, /Check SignPath production configuration/);
  assert.match(workflow, /SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG/);
  assert.match(workflow, /SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG/);
  assert.match(workflow, /SIGNPATH_SIGNING_POLICY_SLUG \|\| 'release-signing'/);
  assert.match(workflow, /artifact-configuration-slug:\s*\$\{\{ vars\.SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG \}\}/);
  assert.match(workflow, /artifact-configuration-slug:\s*\$\{\{ vars\.SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG \}\}/);
  assert.equal((workflow.match(/wait-for-completion-timeout-in-seconds:\s*10800/g) || []).length, 2);
  assert.match(workflow, /verify-windows-signatures\.mjs/);
  assert.match(workflow, /--require full,lite/);
  assert.match(workflow, /refresh-windows-update-metadata\.mjs/);
  assert.match(workflow, /nowen-note-win-signed/);
});

test("本地 Release 在公开前必须用同 tag 的 SignPath Windows artifact 覆盖候选 EXE", async () => {
  const releaseGuard = await readRepoFile("scripts/release.sh");
  assert.match(releaseGuard, /collect_ci_signed_windows_assets/);
  assert.match(releaseGuard, /nowen-note-win-signed/);
  assert.match(releaseGuard, /replacing local Windows candidates/);
  assert.match(releaseGuard, /failed to collect SignPath-signed Windows assets; keeping \$\{TAG\} as draft/);
  const winIndex = releaseGuard.indexOf("if release_contains_windows_candidates");
  const verifyIndex = releaseGuard.indexOf("==== 验证 GitHub Release 更新元数据与远端资产 ====");
  assert.ok(winIndex >= 0 && verifyIndex > winIndex, "必须先替换为 SignPath 已签名 Windows 产物，再执行远端校验");
});

test("本地发布守卫在正式校验前汇总完整 CI macOS 产物", async () => {
  const releaseGuard = await readRepoFile("scripts/release.sh");
  assert.match(releaseGuard, /nowen-note-mac/);
  assert.match(releaseGuard, /gh run download/);
  assert.match(releaseGuard, /gh release upload/);
  assert.match(releaseGuard, /--clobber/);
  assert.match(releaseGuard, /release_has_complete_mac_assets/);
  assert.match(releaseGuard, /latest-mac\.yml/);
  assert.match(releaseGuard, /failed to collect complete CI macOS assets; keeping \$\{TAG\} as draft/);
  const macIndex = releaseGuard.indexOf('if grep -q "PC 产物" "$LOG_FILE"; then');
  const winIndex = releaseGuard.indexOf("if release_contains_windows_candidates");
  const verifyIndex = releaseGuard.indexOf("==== 验证 GitHub Release 更新元数据与远端资产 ====");
  assert.ok(macIndex >= 0 && winIndex > macIndex, "macOS 产物必须先于 Windows SignPath 门禁汇总");
  assert.ok(verifyIndex > winIndex, "Windows 签名门禁仍必须先于最终远端校验");
});

test("完整桌面 Release 会写明四个平台支持情况", async () => {
  const releaseGuard = await readRepoFile("scripts/release.sh");
  assert.match(releaseGuard, /ensure_desktop_platform_notes/);
  assert.match(releaseGuard, /### 桌面端支持/);
  assert.match(releaseGuard, /Windows x64（SignPath 签名）/);
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
