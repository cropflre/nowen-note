#!/usr/bin/env node
/**
 * Release-only acquisition of the exact ffmpeg-static@5.3.0 / FFmpeg b6.1.1
 * upstream binaries. GitHub Release browser URLs can return HTTP 504 on
 * runners while the GitHub Assets API remains healthy.
 *
 * --prepare downloads the host binary BEFORE backend/npm ci and exports
 * FFMPEG_BIN via GITHUB_ENV, so ffmpeg-static's install.js reuses it.
 * --install copies the pinned, verified binary into the actual bundled
 * backend/node_modules/ffmpeg-static path. macOS x64/arm64 builds call
 * --install for each architecture immediately before native rebuilding.
 *
 * Refuse unexpected bytes or unsupported platforms. Do NOT replace these
 * release assets with an unrelated system FFmpeg.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = Object.freeze({
  "linux-x64": {
    id: 316528626,
    compressed: "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
    binary: "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
  },
  "win32-x64": {
    id: 316528798,
    compressed: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
    binary: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
  },
  "darwin-x64": {
    id: 316528367,
    compressed: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    binary: "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894",
  },
  "darwin-arm64": {
    id: 316528311,
    compressed: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    binary: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
  },
});

const args = process.argv.slice(2);
const mode = args.includes("--prepare") ? "prepare" : args.includes("--install") ? "install" : null;
const arg = (key, fallback) => {
  const direct = args.find((value) => value.startsWith(key + "="));
  return direct ? direct.slice(key.length + 1) : fallback;
};
const platform = arg("--platform", process.platform);
const arch = arg("--arch", process.arch);
const key = platform + "-" + arch;
const asset = assets[key];
if (!mode || !asset) throw new Error("Unsupported release FFmpeg invocation: " + args.join(" ") + " (" + key + ")");
const binaryPath = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "nowen-release-ffmpeg-" + key + (platform === "win32" ? ".exe" : ""));
const expectedDestination = path.join(root, "backend", "node_modules", "ffmpeg-static", platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function verifyBinary(bytes) {
  if (hash(bytes) !== asset.binary) throw new Error("Pinned FFmpeg binary SHA-256 mismatch: " + key);
  if (platform === "win32" && bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Invalid Windows executable");
  if (platform === "linux" && bytes.toString("ascii", 1, 4) !== "ELF") throw new Error("Invalid ELF executable");
  if (platform === "darwin") {
    const cpu = arch === "arm64" ? 0x0100000c : 0x01000007;
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) throw new Error("Invalid macOS FFmpeg architecture: " + arch);
  }
}

async function fetchPinnedAsset() {
  const url = "https://api.github.com/repos/eugeneware/ffmpeg-static/releases/assets/" + asset.id;
  let previousError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const headers = {
        Accept: "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "nowen-note-pinned-release-fetch",
      };
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      if (token) headers.Authorization = "Bearer " + token;
      const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error("GitHub Assets API HTTP " + response.status);
      const compressed = Buffer.from(await response.arrayBuffer());
      if (hash(compressed) !== asset.compressed) throw new Error("Pinned FFmpeg download SHA-256 mismatch: " + key);
      const bytes = zlib.gunzipSync(compressed);
      verifyBinary(bytes);
      fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
      fs.writeFileSync(binaryPath, bytes, { mode: 0o755 });
      if (platform !== "win32") fs.chmodSync(binaryPath, 0o755);
      return binaryPath;
    } catch (error) {
      previousError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw new Error("Unable to acquire pinned FFmpeg " + key + ": " + previousError?.message);
}

if (mode === "prepare") {
  await fetchPinnedAsset();
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) throw new Error("GITHUB_ENV is required for release preparation");
  fs.appendFileSync(envFile, "FFMPEG_BIN=" + binaryPath + "\n");
  console.log("[release-ffmpeg] pinned " + key + " ready for npm ci (SHA-256 verified)");
} else {
  if (!fs.existsSync(expectedDestination.replace(/ffmpeg(?:\.exe)?$/, ""))) {
    throw new Error("Backend ffmpeg-static module is not installed: run backend npm ci first");
  }
  let source = binaryPath;
  if (!fs.existsSync(source) || arg("--platform", process.platform) !== process.platform || arg("--arch", process.arch) !== process.arch) {
    source = await fetchPinnedAsset();
  } else {
    verifyBinary(fs.readFileSync(source));
  }
  fs.copyFileSync(source, expectedDestination);
  if (platform !== "win32") fs.chmodSync(expectedDestination, 0o755);
  verifyBinary(fs.readFileSync(expectedDestination));
  console.log("[release-ffmpeg] installed pinned " + key + " binary at " + expectedDestination);
}
