const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function targetPackages(modules, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error(`不支持的 macOS sharp 架构：${arch}`);
  const sharp = JSON.parse(fs.readFileSync(path.join(modules, "sharp/package.json"), "utf8"));
  return [`@img/sharp-darwin-${arch}`, `@img/sharp-libvips-darwin-${arch}`].map(name => {
    const version = sharp.optionalDependencies?.[name];
    if (!version) throw new Error(`sharp 未声明目标依赖 ${name}`);
    return { name, version };
  });
}

// 检查实际二进制，而不是只看目录名，防止把 ARM 产物误装进 Intel 包。
function verifyMacSharp(modules, arch) {
  for (const { name, version } of targetPackages(modules, arch)) {
    const root = path.join(modules, name);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (pkg.version !== version) throw new Error(`sharp 依赖版本不匹配：${name}，期望 ${version}`);
    const binary = name.includes("libvips")
      ? "lib/libvips-cpp.42.dylib"
      : `lib/sharp-darwin-${arch}.node`;
    const file = path.join(root, binary);
    const header = Buffer.alloc(8);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, header, 0, header.length, 0); }
    finally { fs.closeSync(fd); }
    const cpu = arch === "x64" ? 0x01000007 : 0x0100000c;
    if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu) {
      throw new Error(`sharp 二进制架构不匹配：${file}，期望 darwin-${arch}`);
    }
  }
}

function prepareMacSharp(backendDir, arch, run = spawnSync) {
  const modules = path.join(backendDir, "node_modules");
  const packages = targetPackages(modules, arch);
  try { verifyMacSharp(modules, arch); return; }
  catch { /* npm ci 通常只安装宿主架构的 optional dependencies。 */ }

  // 隔离安装，避免 npm 重算 backend 依赖树、删除另一架构或覆盖 Electron SQLite。
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mac-sharp-"));
  try {
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ private: true }));
    const result = run(process.platform === "win32" ? "npm.cmd" : "npm", [
      // --force 兼容不识别 --cpu/--os 的旧 npm；只在隔离目录中忽略宿主架构限制。
      "install", "--force", "--no-save", "--package-lock=false", "--ignore-scripts",
      "--include=optional", "--no-audit", "--no-fund", "--os=darwin", `--cpu=${arch}`,
      ...packages.map(({ name, version }) => `${name}@${version}`),
    ], { cwd: temp, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) throw new Error(`安装 darwin-${arch} sharp 依赖失败：${result.error?.message || result.status}`);
    const installed = path.join(temp, "node_modules");
    // 临时目录不包含 sharp JS 包，使用已安装后端的依赖清单校验复制后的版本和架构。
    for (const { name } of packages) {
      const destination = path.join(modules, name);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(path.join(installed, name), destination, { recursive: true });
    }
    verifyMacSharp(modules, arch);
    console.log(`[rebuild-native] ✓ sharp runtime verified: darwin-${arch}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { verifyMacSharp, prepareMacSharp };
