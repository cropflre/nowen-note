#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assetNameFromUrl,
  isUpdateMetadataName,
  parseUpdateMetadata,
  validateLocalMetadataFiles,
  verifyLocalDirectory,
} = require("./lib/update-metadata-validator.cjs");

function die(message) {
  console.error(`[update-release] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { mode: "", directory: "", version: "", repo: "", tag: "" };
  const args = [...argv];
  options.mode = args.shift() || "";
  while (args.length > 0) {
    const key = args.shift();
    const value = args.shift();
    if (!value) die(`missing value for ${key}`);
    if (key === "--dir") options.directory = value;
    else if (key === "--version") options.version = value.replace(/^v/, "");
    else if (key === "--repo") options.repo = value;
    else if (key === "--tag") options.tag = value;
    else die(`unknown argument: ${key}`);
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? String(result.stdout || "") : "";
}

const SAFE_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isDesktopUpdaterAsset(name) {
  return /^Nowen-Note(?:-Lite)?-.*\.(?:exe|zip|AppImage)$/i.test(name) && !/portable/i.test(name);
}

function assertSafeRemoteAssetName(name) {
  if (!SAFE_ASSET_NAME_RE.test(name) || /portable/i.test(name)) {
    throw new Error(`unsafe or non-updatable asset referenced by metadata: ${name}`);
  }
}

function downloadAsset(repo, tag, name, directory) {
  run("gh", ["release", "download", tag, "--repo", repo, "--pattern", name, "--dir", directory, "--clobber"]);
}

function verifyRemoteRelease({ repo, tag, version }) {
  const view = JSON.parse(
    run("gh", ["release", "view", tag, "--repo", repo, "--json", "assets,isDraft,url"], { capture: true }),
  );
  const assets = Array.isArray(view.assets) ? view.assets : [];
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const metadataAssets = assets.filter((asset) => isUpdateMetadataName(asset.name));
  const hasDesktopAssets = assets.some((asset) => isDesktopUpdaterAsset(asset.name));

  if (metadataAssets.length === 0) {
    if (hasDesktopAssets) throw new Error("desktop updater binaries were uploaded without update metadata");
    console.log(`[update-release] ${tag}: no desktop updater assets, remote metadata check skipped`);
    return { metadataFiles: [], assets: [] };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-release-verify-"));
  try {
    for (const asset of metadataAssets) downloadAsset(repo, tag, asset.name, tempDir);

    const referenced = new Set();
    for (const asset of metadataAssets) {
      const metadataPath = path.join(tempDir, asset.name);
      const metadata = parseUpdateMetadata(fs.readFileSync(metadataPath, "utf8"), asset.name);
      if (version && metadata.version.replace(/^v/, "") !== version.replace(/^v/, "")) {
        throw new Error(`${asset.name}: remote metadata version ${metadata.version} does not match ${version}`);
      }
      for (const file of metadata.files) {
        const name = assetNameFromUrl(file.url);
        assertSafeRemoteAssetName(name);
        referenced.add(name);
      }
    }

    const unreferencedDesktopAssets = assets
      .map((asset) => asset.name)
      .filter((name) => isDesktopUpdaterAsset(name) && !referenced.has(name));
    if (unreferencedDesktopAssets.length > 0) {
      throw new Error(`remote Release contains updater binaries not referenced by metadata: ${unreferencedDesktopAssets.join(", ")}`);
    }

    for (const name of referenced) {
      const remoteAsset = byName.get(name);
      if (!remoteAsset) throw new Error(`remote Release is missing metadata-referenced asset: ${name}`);
      downloadAsset(repo, tag, name, tempDir);
      if (/\.(?:exe|zip|appimage)$/i.test(name)) {
        const blockmapName = `${name}.blockmap`;
        if (!byName.has(blockmapName)) throw new Error(`remote Release is missing required blockmap: ${blockmapName}`);
        downloadAsset(repo, tag, blockmapName, tempDir);
      }
    }

    const report = validateLocalMetadataFiles({
      metadataPaths: metadataAssets.map((asset) => path.join(tempDir, asset.name)),
      assetDir: tempDir,
      expectedVersion: version,
      requireMetadata: true,
    });

    for (const item of report.assets) {
      const remote = byName.get(item.name);
      if (!remote) throw new Error(`remote asset disappeared during verification: ${item.name}`);
      if (Number(remote.size) !== item.size) {
        throw new Error(`${item.name}: GitHub asset size mismatch (remote=${remote.size}, downloaded=${item.size})`);
      }
    }

    console.log(
      `[update-release] verified ${tag}: ${report.metadataFiles.join(", ")} -> ${report.assets.map((item) => item.name).join(", ")}`,
    );
    return report;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
try {
  if (options.mode === "local") {
    if (!options.directory || !options.version) die("local mode requires --dir and --version");
    const report = verifyLocalDirectory({
      directory: options.directory,
      expectedVersion: options.version,
      requireMetadata: true,
    });
    console.log(
      `[update-release] local verification passed: ${report.metadataFiles.join(", ")} -> ${report.assets.map((item) => item.name).join(", ")}`,
    );
  } else if (options.mode === "remote") {
    if (!options.repo || !options.tag) die("remote mode requires --repo and --tag");
    verifyRemoteRelease(options);
  } else {
    die("usage: verify-release-update-assets.mjs local --dir DIR --version X.Y.Z | remote --repo OWNER/REPO --tag vX.Y.Z [--version X.Y.Z]");
  }
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
