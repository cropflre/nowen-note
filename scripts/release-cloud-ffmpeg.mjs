#!/usr/bin/env node
/**
 * Release packaging installs the minimal FFmpeg that scripts/ffmpeg/build-desktop.sh
 * builds from pinned sources (the same components as the Docker image). Build jobs
 * place ffmpeg-<platform>-<arch>[.exe] and SHA256SUMS in $RUNNER_TEMP/nowen-ffmpeg.
 *
 * --prepare verifies the host binary BEFORE backend npm ci and exports FFMPEG_BIN via
 * GITHUB_ENV, so ffmpeg-static's install.js reuses it instead of downloading.
 * --install copies the verified binary into backend/node_modules/ffmpeg-static.
 * macOS x64/arm64 builds call --install for each architecture before native rebuilding.
 *
 * Refuse missing, unlisted, modified or wrong-architecture binaries. Never fall back to
 * downloading a general-purpose FFmpeg.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED = new Set(["linux-x64", "win32-x64", "darwin-x64", "darwin-arm64"]);

export function binaryName(platform, arch) {
  const key = platform + "-" + arch;
  if (!SUPPORTED.has(key)) throw new Error("Unsupported release FFmpeg target: " + key);
  return "ffmpeg-" + key + (platform === "win32" ? ".exe" : "");
}

export function verifyBinary(file, { platform, arch }) {
  const name = binaryName(platform, arch);
  if (!fs.existsSync(file)) throw new Error("Minimal FFmpeg is missing: " + file + " (run scripts/ffmpeg/build-desktop.sh)");
  const bytes = fs.readFileSync(file);
  const sums = path.join(path.dirname(file), "SHA256SUMS");
  const listed = fs.existsSync(sums) && fs.readFileSync(sums, "utf8").split(/\r?\n/)
    .map((line) => line.split(/\s+/)).find(([, entry]) => entry === name)?.[0];
  if (!listed || listed !== crypto.createHash("sha256").update(bytes).digest("hex")) {
    throw new Error("Minimal FFmpeg SHA-256 does not match SHA256SUMS: " + name);
  }
  if (platform === "win32") {
    const pe = bytes.toString("ascii", 0, 2) === "MZ" ? bytes.readUInt32LE(0x3c) : -1;
    if (pe < 0 || bytes.toString("latin1", pe, pe + 4) !== "PE\0\0" || bytes.readUInt16LE(pe + 4) !== 0x8664) {
      throw new Error("Invalid Windows x64 FFmpeg executable: " + name);
    }
  } else if (platform === "linux") {
    if (bytes.toString("latin1", 0, 4) !== "\x7fELF" || bytes.readUInt16LE(0x12) !== 0x3e) {
      throw new Error("Invalid Linux x64 FFmpeg executable: " + name);
    }
  } else {
    const cpu = arch === "arm64" ? 0x0100000c : 0x01000007;
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) {
      throw new Error("Invalid macOS FFmpeg architecture: " + arch);
    }
  }
  return bytes;
}

export function prepare({ dir, platform, arch, envFile }) {
  const file = path.join(dir, binaryName(platform, arch));
  verifyBinary(file, { platform, arch });
  if (!envFile) throw new Error("GITHUB_ENV is required for release preparation");
  fs.appendFileSync(envFile, "FFMPEG_BIN=" + file + "\n");
  return file;
}

export function install({ dir, platform, arch, destination }) {
  const bytes = verifyBinary(path.join(dir, binaryName(platform, arch)), { platform, arch });
  if (!fs.existsSync(path.dirname(destination))) {
    throw new Error("Backend ffmpeg-static module is not installed: run backend npm ci first");
  }
  fs.writeFileSync(destination, bytes);
  if (platform !== "win32") fs.chmodSync(destination, 0o755);
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (key, fallback) => args.find((value) => value.startsWith(key + "="))?.slice(key.length + 1) ?? fallback;
  const platform = option("--platform", process.platform);
  const arch = option("--arch", process.arch);
  const dir = path.resolve(process.env.NOWEN_FFMPEG_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "nowen-ffmpeg"));
  if (args.includes("--prepare")) {
    const file = prepare({ dir, platform, arch, envFile: process.env.GITHUB_ENV });
    console.log("[release-ffmpeg] minimal " + platform + "-" + arch + " ready for npm ci: " + file);
  } else if (args.includes("--install")) {
    const destination = path.join(root, "backend", "node_modules", "ffmpeg-static", platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    install({ dir, platform, arch, destination });
    console.log("[release-ffmpeg] installed minimal " + platform + "-" + arch + " FFmpeg at " + destination);
  } else {
    throw new Error("Unsupported release FFmpeg invocation: " + args.join(" "));
  }
}
