const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function verifyMacSqliteVec(backendDir, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error(`不支持的 sqlite-vec 架构：${arch}`);
  const modules = path.join(backendDir, "node_modules");
  const name = `sqlite-vec-darwin-${arch}`;
  const version = JSON.parse(fs.readFileSync(path.join(modules, "sqlite-vec/package.json"))).optionalDependencies[name];
  const installed = JSON.parse(fs.readFileSync(path.join(modules, name, "package.json")));
  if (installed.version !== version) throw new Error(`sqlite-vec 版本不匹配：${name}`);
  const header = fs.readFileSync(path.join(modules, name, "vec0.dylib")).subarray(0, 8);
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== (arch === "x64" ? 0x01000007 : 0x0100000c)) {
    throw new Error(`sqlite-vec 二进制架构不匹配：darwin-${arch}`);
  }
}

function prepareMacSqliteVec(backendDir, arch, run = spawnSync) {
  try { verifyMacSqliteVec(backendDir, arch); return; } catch { /* npm ci 只安装宿主架构。 */ }
  const name = `sqlite-vec-darwin-${arch}`;
  const source = path.join(backendDir, "node_modules/sqlite-vec/package.json");
  const version = JSON.parse(fs.readFileSync(source)).optionalDependencies[name];
  if (!version) throw new Error(`sqlite-vec 未声明目标架构：${arch}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mac-vec-"));
  try {
    fs.writeFileSync(path.join(temp, "package.json"), '{"private":true}\n');
    const result = run("npm", ["install", "--force", "--no-save", "--package-lock=false", "--ignore-scripts",
      "--no-audit", "--no-fund", "--os=darwin", `--cpu=${arch}`, `${name}@${version}`],
    { cwd: temp, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) throw new Error(`安装 ${name} 失败`);
    fs.mkdirSync(path.join(temp, "node_modules/sqlite-vec"), { recursive: true });
    fs.copyFileSync(source, path.join(temp, "node_modules/sqlite-vec/package.json"));
    verifyMacSqliteVec(temp, arch);
    const destination = path.join(backendDir, "node_modules", name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(path.join(temp, "node_modules", name), destination, { recursive: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { prepareMacSqliteVec, verifyMacSqliteVec };
