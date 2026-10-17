#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { requiredMacReleaseAssets } = require("./lib/release-platform-assets.cjs");
const { verifyLocalDirectory } = require("./lib/update-metadata-validator.cjs");
export const REPO = "cropflre/nowen-note";
export const RECEIPT = "nowen-release-verification.json";

function command(executable, args, capture = false, timeout = 90 * 60_000) {
  const result = spawnSync(executable, args, {
    encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} ${args.slice(0, 3).join(" ")} failed: ${result.error?.message || result.stderr || result.status}`);
  }
  return result.stdout;
}

function gh(args) {
  return command("gh", args, true, args[0] === "run" && args[1] === "download" ? 30 * 60_000 : 120_000);
}

function api(client, endpoint) {
  return JSON.parse(client(["api", `repos/${REPO}/${endpoint}`]));
}

export function validateOptions(options) {
  assert.match(options.tag, /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, "invalid release tag");
  assert.match(options.sha, /^[a-f0-9]{40}$/, "invalid source SHA");
  assert.match(options.requestId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, "invalid request ID");
  for (const key of ["sourceRunId", "runId"]) assert.match(String(options[key]), /^[1-9]\d*$/, `invalid ${key}`);
  for (const key of ["desktop", "windows"]) assert.equal(typeof options[key], "boolean", `invalid ${key}`);
}

export function validateSource(run, options) {
  assert.equal(String(run.id), String(options.sourceRunId), "source run mismatch");
  assert.equal(run.event, "push", "source must be a tag push build");
  assert.equal(run.head_branch, options.tag, "source tag mismatch");
  assert.equal(run.head_sha, options.sha, "source SHA mismatch");
  assert.equal(run.path, ".github/workflows/release.yml", "source workflow mismatch");
  assert.equal(run.repository?.full_name, REPO, "source repository mismatch");
}

export function assetSnapshot(release) {
  const assets = release.assets.map((asset) => ({
    id: asset.id, name: asset.name, size: asset.size, digest: asset.digest || null, updatedAt: asset.updated_at,
  })).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(new Set(assets.map((asset) => asset.name)).size, assets.length, "duplicate Release assets");
  return assets;
}

function validateRemoteTag(client, options) {
  let object = api(client, `git/ref/tags/${options.tag}`).object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) object = api(client, `git/tags/${object.sha}`).object;
  assert.equal(object.type, "commit", "tag does not resolve to a commit");
  assert.equal(object.sha, options.sha, "remote tag moved");
}

export function selectPlatformFiles(directory, platform, version) {
  const required = platform === "mac" ? requiredMacReleaseAssets(version) : [
    `Nowen-Note-${version}-setup.exe`, `Nowen-Note-${version}-portable.exe`,
    `Nowen-Note-${version}-setup.exe.blockmap`, "latest.yml",
    `Nowen-Note-Lite-${version}-setup.exe`, `Nowen-Note-Lite-${version}-portable.exe`,
    `Nowen-Note-Lite-${version}-setup.exe.blockmap`, "latest-lite.yml",
  ];
  const allowed = new Set([...required, ...(platform === "mac" ? required.filter((name) => /\.(dmg|zip)$/.test(name)).map((name) => `${name}.blockmap`) : [])]);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    assert.ok(entry.isFile() && allowed.has(entry.name), `unexpected ${platform} artifact entry: ${entry.name}`);
  }
  for (const name of required) assert.ok(entries.some((entry) => entry.name === name), `missing ${name}`);
  verifyLocalDirectory({ directory, expectedVersion: version, requireMetadata: true });
  return entries.map((entry) => path.join(directory, entry.name)).sort();
}

function digest(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return `sha256:${hash.digest("hex")}`;
  } finally { fs.closeSync(fd); }
}

export function validateReceipt(receipt, options, release, run) {
  validateOptions(options);
  assert.equal(receipt.schema, 1, "unknown verification receipt");
  assert.equal(receipt.repo, REPO);
  for (const key of ["tag", "sha", "requestId", "desktop", "windows"]) assert.equal(receipt[key], options[key], `receipt ${key} mismatch`);
  for (const key of ["sourceRunId", "runId"]) assert.equal(String(receipt[key]), String(options[key]), `receipt ${key} mismatch`);
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.path, ".github/workflows/release.yml");
  assert.equal(String(run.id), String(options.runId));
  assert.equal(run.repository?.full_name, REPO);
  assert.equal(run.head_sha, options.sha);
  assert.equal(run.head_branch, options.tag);
  assert.equal(run.display_title, `Release assets ${options.requestId}`);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success", "CI collection/verification did not succeed");
  assert.equal(receipt.attempt, run.run_attempt, "stale receipt from an earlier attempt");
  assert.equal(release.tag_name, options.tag);
  assert.deepEqual(assetSnapshot(release), receipt.assets, "Release assets changed after CI verification");
}

export async function collectRelease(options, { client = gh, verify = () => command(process.execPath, [
  fileURLToPath(new URL("./verify-release-update-assets.mjs", import.meta.url)),
  "remote", "--repo", REPO, "--tag", options.tag, "--version", options.tag.slice(1),
]), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempt = 1 } = {}) {
  validateOptions(options);
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0, "invalid CI attempt");
  validateRemoteTag(client, options);
  const readRelease = () => {
    const release = api(client, `releases/tags/${options.tag}`);
    assert.equal(release.tag_name, options.tag);
    if (options.desktop || options.windows) assert.equal(release.draft, true, "CI only writes an existing Draft Release");
    return release;
  };
  readRelease();
  let source;
  const deadline = Date.now() + 180 * 60_000;
  do {
    source = api(client, `actions/runs/${options.sourceRunId}`);
    validateSource(source, options);
    if (source.status === "completed") break;
    assert.ok(Date.now() < deadline, "timed out waiting for source build");
    console.log(`[release-ci] source run ${options.sourceRunId}: ${source.status}; waiting 30s`);
    await sleep(30_000);
  } while (true);

  const jobs = api(client, `actions/runs/${options.sourceRunId}/jobs?per_page=100`).jobs;
  const artifacts = api(client, `actions/runs/${options.sourceRunId}/artifacts?per_page=100`).artifacts;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-release-ci-"));
  try {
    // Keep successful Mac assets available in Draft even if Windows packaging failed.
    for (const platform of [options.desktop && "mac", options.windows && "win"].filter(Boolean)) {
      const jobName = platform === "mac" ? "build (macos-latest, mac)" : "build (windows-latest, win)";
      const job = jobs.find((item) => item.name === jobName);
      assert.equal(job?.conclusion, "success", `${jobName} did not succeed`);
      const name = platform === "mac" ? "nowen-note-mac" : "nowen-note-win-direct";
      const matches = artifacts.filter((artifact) => artifact.name === name && !artifact.expired);
      assert.equal(matches.length, 1, `expected one current ${name} artifact`);
      const artifact = matches[0];
      assert.equal(artifact.workflow_run?.head_sha, options.sha, "artifact SHA mismatch");
      assert.equal(String(artifact.workflow_run?.id), String(options.sourceRunId), "artifact run mismatch");
      const platformDir = path.join(directory, platform);
      client(["run", "download", String(options.sourceRunId), "--repo", REPO, "--name", name, "--dir", platformDir]);
      const files = selectPlatformFiles(platformDir, platform, options.tag.slice(1));
      const expected = files.map((file) => ({ name: path.basename(file), size: fs.statSync(file).size, digest: digest(file) }));
      readRelease();
      console.log(`[release-ci] uploading ${files.length} verified ${platform} assets to Draft ${options.tag}`);
      client(["release", "upload", options.tag, "--repo", REPO, "--clobber", ...files]);
      const uploaded = readRelease();
      for (const file of expected) {
        const remote = uploaded.assets.find((asset) => asset.name === file.name);
        assert.equal(remote?.size, file.size, `uploaded size mismatch: ${file.name}`);
        assert.equal(remote?.digest, file.digest, `uploaded SHA-256 mismatch: ${file.name}`);
      }
    }
    const before = readRelease();
    await verify();
    validateRemoteTag(client, options);
    const after = readRelease();
    assert.deepEqual(assetSnapshot(after), assetSnapshot(before), "Release changed during remote verification");
    const receipt = {
      schema: 1, repo: REPO, ...options, attempt,
      verifiedAt: new Date().toISOString(), assets: assetSnapshot(after),
    };
    console.log(`[release-ci] verification complete; ${options.tag} publication state unchanged`);
    return receipt;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function checkRelease(options, { client = gh } = {}) {
  validateOptions(options);
  validateRemoteTag(client, options);
  const release = api(client, `releases/tags/${options.tag}`);
  const name = `release-verification-${options.requestId}`;
  const artifacts = api(client, `actions/runs/${options.runId}/artifacts?per_page=100`).artifacts.filter((item) => item.name === name && !item.expired);
  assert.equal(artifacts.length, 1, "missing or ambiguous CI verification receipt");
  assert.ok(artifacts[0].size_in_bytes < 1024 * 1024, "oversized CI verification receipt");
  assert.equal(artifacts[0].workflow_run?.head_sha, options.sha);
  assert.equal(String(artifacts[0].workflow_run?.id), String(options.runId));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-release-receipt-"));
  try {
    client(["run", "download", String(options.runId), "--repo", REPO, "--name", name, "--dir", directory]);
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    assert.equal(entries.length, 1);
    assert.ok(entries[0].isFile() && entries[0].name === RECEIPT);
    const file = path.join(directory, RECEIPT);
    assert.ok(fs.statSync(file).size < 1024 * 1024);
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    validateReceipt(receipt, options, release, api(client, `actions/runs/${options.runId}`));
    // Re-read after fetching the receipt, immediately before local publication.
    assert.deepEqual(assetSnapshot(api(client, `releases/tags/${options.tag}`)), receipt.assets, "Release changed while checking receipt");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function parseOptions(args) {
  const options = {};
  const names = { "--tag": "tag", "--sha": "sha", "--source-run": "sourceRunId", "--run": "runId", "--request": "requestId", "--desktop": "desktop", "--windows": "windows" };
  while (args.length) {
    const key = names[args.shift()];
    const value = args.shift();
    assert.ok(key && value !== undefined, "invalid argument");
    if (["desktop", "windows"].includes(key)) {
      assert.ok(["true", "false"].includes(value), "invalid boolean");
      options[key] = value === "true";
    } else options[key] = value;
  }
  validateOptions(options);
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === "collect") {
      assert.equal(process.env.GITHUB_REPOSITORY, REPO);
      assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
      assert.equal(process.env.GITHUB_REF, `refs/tags/${process.env.RELEASE_TAG}`);
      const options = parseOptions([
        "--tag", process.env.RELEASE_TAG, "--sha", process.env.GITHUB_SHA,
        "--source-run", process.env.SOURCE_RUN_ID, "--run", process.env.GITHUB_RUN_ID,
        "--request", process.env.RELEASE_REQUEST_ID, "--desktop", process.env.COLLECT_DESKTOP,
        "--windows", process.env.COLLECT_WINDOWS,
      ]);
      assert.equal(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).version, options.tag.slice(1));
      const receipt = await collectRelease(options, { attempt: Number(process.env.GITHUB_RUN_ATTEMPT) });
      fs.writeFileSync(path.join(process.env.RUNNER_TEMP, RECEIPT), JSON.stringify(receipt, null, 2));
    } else if (mode === "check") {
      checkRelease(parseOptions(args));
      console.log("[release-ci] same-tag CI receipt and current Release inventory verified");
    } else throw new Error("expected collect or check");
  } catch (error) {
    console.error(`[release-ci] ${error.message}`);
    process.exitCode = 1;
  }
}
