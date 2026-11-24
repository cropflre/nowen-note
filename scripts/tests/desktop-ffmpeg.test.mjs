import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { motionArgs } from "../ffmpeg/smoke-motion.mjs";
import { install, prepare, verifyBinary } from "../release-cloud-ffmpeg.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("the FFmpeg smoke test converts with exactly the backend's Live Photo arguments", () => {
  const source = read("backend/src/services/modern-media.ts");
  const literal = source.match(/spawn\(getMediaFfmpegPath\(\), \[([\s\S]*?)\], \{/)?.[1];
  assert.ok(literal, "convertMotion spawn arguments not found");
  const backendArgs = new Function("input", "output", `return [${literal}];`)("IN", "OUT");
  assert.deepEqual(motionArgs("IN", "OUT"), backendArgs);
});

test("Docker and desktop packages build FFmpeg from one component list", () => {
  const flags = read("scripts/ffmpeg/minimal-configure-flags.txt").split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  const list = (prefix) => flags.find((flag) => flag.startsWith(prefix))?.slice(prefix.length).split(",") || [];
  // ffmpeg 会按需自动插入这些滤镜；少一个，带旋转、裁剪或 -t 的实况照片就会转码失败。
  for (const filter of ["scale", "format", "trim", "atrim", "transpose", "hflip", "vflip", "rotate", "crop",
    "aformat", "aresample", "null", "anull"]) assert.ok(list("--enable-filter=").includes(filter), filter);
  for (const decoder of ["h264", "hevc", "aac"]) assert.ok(list("--enable-decoder=").includes(decoder), decoder);
  assert.deepEqual(list("--enable-encoder="), ["libx264", "aac"]);
  assert.ok(flags.includes("--disable-everything") && flags.includes("--disable-autodetect") && flags.includes("--enable-libx264"));
  assert.match(read("Dockerfile"), /COPY scripts\/ffmpeg\/minimal-configure-flags\.txt \/minimal-configure-flags\.txt/);
  assert.match(read("Dockerfile"), /\.\/configure \$\(grep -v -e '\^#' -e '\^\$' \/minimal-configure-flags\.txt\)/);
  assert.match(read("scripts/ffmpeg/build-desktop.sh"), /flags=\$\(grep -v -e '\^#' -e '\^\$' "\$here\/minimal-configure-flags\.txt"\)/);
});

function fakeBinary(platform, arch) {
  const bytes = Buffer.alloc(256, 7);
  if (platform === "win32") {
    bytes.write("MZ", 0, "ascii"); bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write("PE\0\0", 0x80, "latin1"); bytes.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 0x84);
  } else if (platform === "linux") {
    bytes.write("\x7fELF", 0, "latin1"); bytes.writeUInt16LE(arch === "x64" ? 0x3e : 0xb7, 0x12);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  }
  return bytes;
}

function buildDir(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-release-ffmpeg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sums = [];
  for (const [name, bytes] of entries) {
    fs.writeFileSync(path.join(dir, name), bytes);
    sums.push(`${crypto.createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
  return dir;
}

test("release packaging installs only the listed minimal FFmpeg for the exact target", (t) => {
  const targets = [["linux", "x64"], ["win32", "x64"], ["darwin", "x64"], ["darwin", "arm64"]];
  const dir = buildDir(t, targets.map(([platform, arch]) =>
    [`ffmpeg-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`, fakeBinary(platform, arch)]));
  const backend = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ffmpeg-static-"));
  t.after(() => fs.rmSync(backend, { recursive: true, force: true }));
  for (const [platform, arch] of targets) {
    const destination = path.join(backend, platform === "win32" ? "ffmpeg.exe" : `ffmpeg-${arch}`);
    install({ dir, platform, arch, destination });
    assert.deepEqual(fs.readFileSync(destination), fakeBinary(platform, arch));
  }
  const envFile = path.join(backend, "github-env");
  const prepared = prepare({ dir, platform: "darwin", arch: "arm64", envFile });
  assert.equal(fs.readFileSync(envFile, "utf8"), `FFMPEG_BIN=${prepared}\n`);
  assert.throws(() => install({ dir, platform: "linux", arch: "x64", destination: path.join(backend, "missing", "ffmpeg") }), /npm ci first/);
});

test("release packaging refuses missing, unlisted, modified, foreign or unsupported FFmpeg binaries", (t) => {
  const dir = buildDir(t, [
    ["ffmpeg-darwin-arm64", fakeBinary("darwin", "x64")],
    ["ffmpeg-linux-x64", fakeBinary("linux", "arm64")],
    ["ffmpeg-win32-x64.exe", fakeBinary("win32", "arm64")],
  ]);
  assert.throws(() => verifyBinary(path.join(dir, "ffmpeg-darwin-x64"), { platform: "darwin", arch: "x64" }), /missing/);
  assert.throws(() => verifyBinary(path.join(dir, "ffmpeg-darwin-arm64"), { platform: "darwin", arch: "arm64" }), /macOS FFmpeg architecture/);
  assert.throws(() => verifyBinary(path.join(dir, "ffmpeg-linux-x64"), { platform: "linux", arch: "x64" }), /Linux x64/);
  assert.throws(() => verifyBinary(path.join(dir, "ffmpeg-win32-x64.exe"), { platform: "win32", arch: "x64" }), /Windows x64/);
  assert.throws(() => verifyBinary(path.join(dir, "ffmpeg-linux-arm64"), { platform: "linux", arch: "arm64" }), /Unsupported/);
  fs.writeFileSync(path.join(dir, "ffmpeg-darwin-x64"), fakeBinary("darwin", "x64"));
  assert.throws(() => verifyBinary(path.join(dir, "ffmpeg-darwin-x64"), { platform: "darwin", arch: "x64" }), /SHA256SUMS/);
  fs.appendFileSync(path.join(dir, "ffmpeg-linux-x64"), "tampered");
  assert.throws(() => verifyBinary(path.join(dir, "ffmpeg-linux-x64"), { platform: "linux", arch: "x64" }), /SHA256SUMS/);
});

test("candidate builds compile, smoke-test and install the minimal FFmpeg on every desktop platform", () => {
  const workflow = createRequire(import.meta.url)("js-yaml").load(read(".github/workflows/release-center-candidate.yml"));
  const ffmpegJob = workflow.jobs.ffmpeg.steps.map((step) => step.run || "").join("\n");
  assert.match(ffmpegJob, /build-desktop\.sh linux-x64/);
  assert.match(ffmpegJob, /build-desktop\.sh win32-x64/);
  assert.match(ffmpegJob, /smoke-motion\.mjs "\$RUNNER_TEMP\/nowen-ffmpeg\/ffmpeg-linux-x64"/);
  assert.ok(workflow.jobs.build.needs.includes("ffmpeg"));
  const build = workflow.jobs.build.steps.map((step) => step.run || "").join("\n");
  const linuxFfmpeg = '"$RUNNER_TEMP/nowen-ffmpeg/ffmpeg-linux-x64"';
  const restoreMode = build.indexOf(`chmod +x ${linuxFfmpeg}`);
  const smoke = build.indexOf(`node scripts/ffmpeg/smoke-motion.mjs ${linuxFfmpeg}`);
  assert.ok(restoreMode >= 0 && restoreMode < smoke, "restore executable mode before Linux smoke test");
  for (const pattern of [/build-desktop\.sh darwin-arm64/, /build-desktop\.sh darwin-x64/, /ffmpeg-win32-x64\.exe/,
    /ffmpeg-darwin-x64" arch -x86_64/, /release-cloud-ffmpeg\.mjs --prepare/, /release-cloud-ffmpeg\.mjs --install --platform=darwin --arch=x64/]) {
    assert.match(build, pattern);
  }
  assert.doesNotMatch(read(".github/workflows/release-center-candidate.yml") + read("scripts/release-cloud-ffmpeg.mjs"), /eugeneware|6\.1\.1/);
});
