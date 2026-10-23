import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assetSnapshot, checkRelease, collectRelease, RECEIPT, REPO, validateOptions, validateReceipt, validateSource } from "../release-ci-assets.mjs";

const options = {
  tag: "v1.5.2", sha: "a".repeat(40), requestId: "12345678-1234-1234-1234-123456789abc",
  sourceRunId: "101", runId: "202", desktop: true, windows: true,
};
const source = () => ({ id: 101, event: "push", head_branch: options.tag, head_sha: options.sha,
  path: ".github/workflows/release.yml", repository: { full_name: REPO }, status: "completed" });
const run = () => ({ id: 202, event: "workflow_dispatch", head_branch: options.tag, head_sha: options.sha,
  path: ".github/workflows/release.yml", repository: { full_name: REPO },
  display_title: `Release assets ${options.requestId}`, status: "completed", conclusion: "success", run_attempt: 1 });

function fixture(settings = {}) {
  let nextId = 10;
  const release = { tag_name: options.tag, draft: true, assets: [
    { id: 1, name: "Nowen-Note-1.5.2.apk", size: 3, digest: "sha256:android", updated_at: "2026-10-16T00:00:00Z" },
  ] };
  const state = { release, uploads: [], downloads: [], source: source(), verified: 0, ...settings };
  const jobs = [
    { name: "build (macos-latest, mac)", conclusion: "success" },
    { name: "build (windows-latest, win)", conclusion: settings.windowsFailed ? "failure" : "success" },
    { name: "build (ubuntu-latest, linux)", conclusion: settings.linuxFailed ? "failure" : "success" },
  ];
  const artifacts = ["nowen-note-mac", "nowen-note-win-direct", "nowen-note-linux"].map((name, id) => ({
    id, name, expired: false, workflow_run: { id: 101, head_sha: options.sha },
  }));
  state.artifacts = artifacts;
  const client = (args) => {
    if (args[0] === "api") {
      const endpoint = args[1].replace(`repos/${REPO}/`, "");
      if (endpoint === `git/ref/tags/${options.tag}`) return JSON.stringify({ object: { type: "tag", sha: "b".repeat(40) } });
      if (endpoint === `git/tags/${"b".repeat(40)}`) return JSON.stringify({ object: { type: "commit", sha: state.tagSha || options.sha } });
      if (endpoint === `releases/tags/${options.tag}`) return JSON.stringify(release);
      if (endpoint === "actions/runs/101") return JSON.stringify(state.source);
      if (endpoint === "actions/runs/101/jobs?per_page=100") return JSON.stringify({ jobs });
      if (endpoint === "actions/runs/101/artifacts?per_page=100") return JSON.stringify({ artifacts });
      throw new Error(`unexpected API request: ${endpoint}`);
    }
    if (args[0] === "run" && args[1] === "download") {
      const name = args[args.indexOf("--name") + 1];
      const dir = args[args.indexOf("--dir") + 1];
      state.downloads.push(dir);
      fs.mkdirSync(dir, { recursive: true });
      const platform = name.endsWith("mac") ? "mac" : name.endsWith("linux") ? "linux" : "win";
      const metadata = (prefix, channel, suffix) => {
        const asset = `${prefix}-1.5.2-${suffix}`;
        const bytes = Buffer.from(asset);
        fs.writeFileSync(path.join(dir, asset), bytes);
        if (/\.(exe|zip)$/.test(asset)) fs.writeFileSync(path.join(dir, `${asset}.blockmap`), "blockmap");
        const sha = createHash("sha512").update(bytes).digest("base64");
        fs.writeFileSync(path.join(dir, channel), `version: 1.5.2\nfiles:\n  - url: ${asset}\n    sha512: ${sha}\n    size: ${bytes.length}\n${asset.endsWith(".AppImage") ? "    blockMapSize: 8\n" : ""}path: ${asset}\nsha512: ${sha}\n`);
      };
      if (platform === "mac") {
        metadata("Nowen-Note", "latest-mac.yml", "arm64.zip");
        for (const suffix of ["x64.dmg", "arm64.dmg", "x64.zip"]) fs.writeFileSync(path.join(dir, `Nowen-Note-1.5.2-${suffix}`), suffix);
      } else if (platform === "linux") {
        metadata("Nowen-Note", "latest-linux.yml", "x86_64.AppImage");
        fs.writeFileSync(path.join(dir, "Nowen-Note-1.5.2-amd64.deb"), "deb");
      } else {
        for (const [prefix, channel] of [["Nowen-Note", "latest.yml"], ["Nowen-Note-Lite", "latest-lite.yml"]]) {
          metadata(prefix, channel, "setup.exe");
          fs.writeFileSync(path.join(dir, `${prefix}-1.5.2-portable.exe`), "portable");
        }
      }
      if (state.corrupt === platform) fs.writeFileSync(path.join(dir, platform === "mac" ? "Nowen-Note-1.5.2-arm64.zip" : platform === "linux" ? "Nowen-Note-1.5.2-x86_64.AppImage" : "Nowen-Note-1.5.2-setup.exe"), "corrupt");
      if (state.extra === platform) fs.writeFileSync(path.join(dir, "old-version.dmg"), "old");
      return "";
    }
    if (args[0] === "release" && args[1] === "upload") {
      const files = args.slice(6);
      state.uploads.push(files.map((file) => path.basename(file)));
      for (const file of files) {
        const name = path.basename(file);
        release.assets = release.assets.filter((item) => item.name !== name);
        release.assets.push({ id: nextId++, name, size: fs.statSync(file).size,
          digest: state.badUploadHash ? "sha256:wrong" : `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`,
          updated_at: "2026-10-16T01:00:00Z" });
      }
      return "";
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const verify = () => {
    state.verified++;
    if (state.verifyFails) throw new Error("remote metadata SHA-512 mismatch");
    if (state.changedDuringVerify) release.assets[0].size++;
  };
  return { state, client, verify };
}

test("GitHub collector verifies both architectures and Full/Lite, preserves other assets and returns a bound receipt", async () => {
  const f = fixture();
  const receipt = await collectRelease(options, f);
  assert.equal(f.state.uploads.length, 2);
  assert.ok(f.state.uploads[0].includes("Nowen-Note-1.5.2-x64.zip"));
  assert.ok(f.state.uploads[0].includes("Nowen-Note-1.5.2-arm64.dmg"));
  assert.ok(f.state.uploads[1].includes("latest-lite.yml"));
  assert.equal(f.state.release.draft, true);
  assert.equal(f.state.release.assets[0].name, "Nowen-Note-1.5.2.apk");
  assert.equal(f.state.verified, 1);
  assert.deepEqual(receipt.assets, assetSnapshot(f.state.release));
  validateReceipt(receipt, options, f.state.release, run());
  for (const dir of f.state.downloads) assert.equal(fs.existsSync(dir), false, "temporary download must be cleaned");
});

test("Linux-only collection uploads AppImage, Debian package and updater metadata with a bound receipt", async () => {
  const linuxOptions = { ...options, desktop: false, windows: false, linux: true };
  const f = fixture();
  f.state.release.assets = [];
  const receipt = await collectRelease(linuxOptions, f);
  assert.equal(f.state.uploads.length, 1);
  assert.deepEqual(f.state.uploads[0], ["Nowen-Note-1.5.2-amd64.deb", "Nowen-Note-1.5.2-x86_64.AppImage", "latest-linux.yml"]);
  validateReceipt(receipt, linuxOptions, f.state.release, run());
  assert.throws(() => validateReceipt({ ...receipt, linux: false }, linuxOptions, f.state.release, run()), /linux mismatch/);
  assert.equal(f.state.release.draft, true);
});

for (const settings of [{ linuxFailed: true }, { corrupt: "linux" }, { extra: "linux" }]) {
  test(`Linux CI failure or invalid assets cannot yield a publication receipt: ${JSON.stringify(settings)}`, async () => {
    const f = fixture(settings);
    await assert.rejects(collectRelease({ ...options, desktop: false, windows: false, linux: true }, f));
    assert.equal(f.state.uploads.length, 0);
    assert.equal(f.state.verified, 0);
    assert.equal(f.state.release.draft, true);
  });
}

test("all desktop platforms can be collected without local release assets", async () => {
  const f = fixture();
  f.state.release.assets = [];
  const receipt = await collectRelease({ ...options, linux: true }, f);
  assert.equal(f.state.uploads.length, 3);
  assert.equal(f.state.verified, 1);
  assert.equal(receipt.assets.length, 17);
});

for (const [field, value] of [["event", "workflow_dispatch"], ["head_branch", "main"], ["head_sha", "c".repeat(40)], ["path", ".github/workflows/other.yml"], ["repository", { full_name: "other/repo" }]]) {
  test(`collector rejects source ${field} mismatch before any upload`, async () => {
    const f = fixture({ source: { ...source(), [field]: value } });
    await assert.rejects(collectRelease(options, f));
    assert.equal(f.state.uploads.length, 0);
  });
}

for (const settings of [{ corrupt: "mac" }, { extra: "mac" }, { badUploadHash: true }, { verifyFails: true }, { changedDuringVerify: true }, { tagSha: "c".repeat(40) }]) {
  test(`invalid assets or changed remote state cannot produce a receipt: ${JSON.stringify(settings)}`, async () => {
    const f = fixture(settings);
    await assert.rejects(collectRelease(options, f));
    assert.equal(f.state.release.draft, true);
    for (const dir of f.state.downloads) assert.equal(fs.existsSync(dir), false);
  });
}

test("failed Windows job does not strand successful macOS assets and never passes final verification", async () => {
  const f = fixture({ windowsFailed: true });
  await assert.rejects(collectRelease(options, f), /windows-latest/);
  assert.equal(f.state.uploads.length, 1);
  assert.equal(f.state.verified, 0);
  assert.equal(f.state.release.draft, true);
});

for (const mutate of [
  (artifact) => { artifact.expired = true; },
  (artifact) => { artifact.workflow_run.head_sha = "d".repeat(40); },
  (artifact) => { artifact.workflow_run.id = 999; },
]) {
  test("expired or foreign artifact is rejected before download", async () => {
    const f = fixture();
    mutate(f.state.artifacts[0]);
    await assert.rejects(collectRelease(options, f));
    assert.equal(f.state.downloads.length, 0);
  });
}

test("published releases cannot be overwritten; verification-only supplemental uploads remain supported", async () => {
  const f = fixture();
  f.state.release.draft = false;
  await assert.rejects(collectRelease(options, f), /Draft/);
  const receipt = await collectRelease({ ...options, desktop: false, windows: false }, f);
  assert.equal(f.state.uploads.length, 0);
  assert.equal(f.state.verified, 1);
  assert.equal(f.state.release.draft, false);
  assert.equal(receipt.desktop, false);
});

test("receipt rejects stale requests, attempts, source SHAs, failed runs and any later asset replacement", async () => {
  const f = fixture();
  const receipt = await collectRelease(options, f);
  for (const change of [{ requestId: "other" }, { sha: "c".repeat(40) }, { sourceRunId: "999" }, { attempt: 2 }, { windows: false }]) {
    assert.throws(() => validateReceipt({ ...receipt, ...change }, options, f.state.release, run()));
  }
  for (const change of [{ conclusion: "failure" }, { status: "in_progress" }, { head_sha: "c".repeat(40) }, { event: "push" }, { run_attempt: 2 }]) {
    assert.throws(() => validateReceipt(receipt, options, f.state.release, { ...run(), ...change }));
  }
  f.state.release.assets[0].id++;
  assert.throws(() => validateReceipt(receipt, options, f.state.release, run()), /changed after CI/);
});

test("invalid IDs and shell-like tag input cannot reach a command", () => {
  for (const change of [{ tag: "v1.5.2;echo unsafe" }, { requestId: "" }, { runId: "1 --other" }, { desktop: "false" }]) {
    assert.throws(() => validateOptions({ ...options, ...change }));
  }
  assert.doesNotThrow(() => validateSource(source(), options));
});

test("local check downloads only the small receipt and rechecks the live asset inventory", async () => {
  const f = fixture();
  const receipt = await collectRelease(options, f);
  const calls = [];
  const client = (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1].endsWith("actions/runs/202/artifacts?per_page=100")) {
      return JSON.stringify({ artifacts: [{ name: `release-verification-${options.requestId}`, expired: false,
        size_in_bytes: 500, workflow_run: { id: 202, head_sha: options.sha } }] });
    }
    if (args[0] === "api" && args[1].endsWith("actions/runs/202")) return JSON.stringify(run());
    if (args[0] === "run") {
      assert.equal(args[2], "202");
      assert.equal(args[args.indexOf("--name") + 1], `release-verification-${options.requestId}`);
      fs.writeFileSync(path.join(args.at(-1), RECEIPT), JSON.stringify(receipt));
      return "";
    }
    return f.client(args);
  };
  assert.doesNotThrow(() => checkRelease(options, { client }));
  assert.equal(calls.filter((args) => args[0] === "run").length, 1);
  assert.equal(calls.filter((args) => args[0] === "api" && args[1].endsWith(`releases/tags/${options.tag}`)).length, 2);
  f.state.release.assets[0].size++;
  assert.throws(() => checkRelease(options, { client }), /changed after CI/);
});

test("a repeated CI attempt produces a fresh receipt instead of reusing prior success", async () => {
  const f = fixture();
  const receipt = await collectRelease(options, { ...f, attempt: 2 });
  assert.equal(receipt.attempt, 2);
  assert.throws(() => validateReceipt(receipt, options, f.state.release, run()));
  assert.doesNotThrow(() => validateReceipt(receipt, options, f.state.release, { ...run(), run_attempt: 2 }));
});
