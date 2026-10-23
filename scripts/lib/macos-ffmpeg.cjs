const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function verifyMacFfmpeg(file, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error(`不支持的 FFmpeg 架构：${arch}`);
  const header = Buffer.alloc(8);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, header, 0, header.length, 0); }
  finally { fs.closeSync(fd); }
  if (header.readUInt32LE(0) !== 0xfeedfacf ||
      header.readUInt32LE(4) !== (arch === "x64" ? 0x01000007 : 0x0100000c)) {
    throw new Error(`FFmpeg 二进制架构不匹配：${file}，期望 darwin-${arch}`);
  }
}

function prepareMacFfmpeg(backendDir, arch, run = spawnSync) {
  const root = path.join(backendDir, "node_modules/ffmpeg-static");
  const destination = path.join(root, "ffmpeg");
  try { verifyMacFfmpeg(destination, arch); return; }
  catch { /* npm ci installs the host architecture; dual-arch builds must replace it. */ }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mac-ffmpeg-"));
  const binary = path.join(temp, "ffmpeg");
  try {
    // Reuse the locked package's installer and release tag, with an isolated output path.
    const result = run(process.execPath, [path.join(root, "install.js")], {
      env: { ...process.env, npm_config_platform: "darwin", npm_config_arch: arch, FFMPEG_BIN: binary },
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`安装 darwin-${arch} FFmpeg 失败：${result.error?.message || result.status}`);
    verifyMacFfmpeg(binary, arch);
    fs.copyFileSync(binary, destination);
    fs.chmodSync(destination, 0o755);
    for (const suffix of [".README", ".LICENSE"]) {
      if (fs.existsSync(binary + suffix)) fs.copyFileSync(binary + suffix, destination + suffix);
    }
    console.log(`[rebuild-native] ✓ FFmpeg runtime verified: darwin-${arch}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { verifyMacFfmpeg, prepareMacFfmpeg };
