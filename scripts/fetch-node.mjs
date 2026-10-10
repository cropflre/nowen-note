#!/usr/bin/env node
/**
 * fetch-node.mjs
 * ----------------------------------------------------------
 * 下载指定版本的 Node.js 官方二进制到 electron/node/<platform>/，
 * 供 electron-builder 通过 extraResources 打进安装包。
 *
 * 用法：
 *   node scripts/fetch-node.mjs               # 默认仅当前平台
 *   node scripts/fetch-node.mjs --all         # 三平台全下（win/mac/linux x64 + mac arm64）
 *   NODE_EMBED_VERSION=v20.18.0 node scripts/fetch-node.mjs
 *
 * 产物目录：
 *   electron/node/win32-x64/node.exe
 *   electron/node/darwin-x64/node
 *   electron/node/darwin-arm64/node
 *   electron/node/linux-x64/node
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "electron", "node");

const VERSION = process.env.NODE_EMBED_VERSION || "v20.18.0";
const MIRROR = process.env.NODE_MIRROR || "https://nodejs.org/dist";

const TARGETS = {
  "win32-x64": {
    url: `${MIRROR}/${VERSION}/node-${VERSION}-win-x64.zip`,
    entry: `node-${VERSION}-win-x64/node.exe`,
    exe: "node.exe",
    kind: "zip",
  },
  "darwin-x64": {
    url: `${MIRROR}/${VERSION}/node-${VERSION}-darwin-x64.tar.gz`,
    entry: `node-${VERSION}-darwin-x64/bin/node`,
    exe: "node",
    kind: "tar.gz",
  },
  "darwin-arm64": {
    url: `${MIRROR}/${VERSION}/node-${VERSION}-darwin-arm64.tar.gz`,
    entry: `node-${VERSION}-darwin-arm64/bin/node`,
    exe: "node",
    kind: "tar.gz",
  },
  "linux-x64": {
    url: `${MIRROR}/${VERSION}/node-${VERSION}-linux-x64.tar.gz`,
    entry: `node-${VERSION}-linux-x64/bin/node`,
    exe: "node",
    kind: "tar.gz",
  },
};

function currentKey() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32") return "win32-x64";
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  return "linux-x64";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function download(url, dest) {
  console.log(`[fetch-node] GET ${url}`);
  return new Promise((resolve, reject) => {
    const doReq = (u) => {
      https.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return doReq(new URL(res.headers.location, u).toString());
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} on ${u}`));
        }
        const fd = fs.createWriteStream(dest);
        res.pipe(fd);
        fd.on("finish", () => fd.close(() => resolve()));
        fd.on("error", reject);
      }).on("error", reject);
    };
    doReq(url);
  });
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function extractZip(zipPath, entry, outFile) {
  const tmpDir = path.join(path.dirname(outFile), ".tmp-zip");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ensureDir(tmpDir);

  try {
    let result;
    if (process.platform === "win32") {
      // GitHub Windows Runner 下 Git Bash 的 tar 会把 D:\... 误解析成远程主机路径，
      // 出现 `tar: Cannot connect to D: resolve failed`。Windows ZIP 明确交给
      // PowerShell Expand-Archive，避免路径语义经过 MSYS/tar 二次转换。
      const command = [
        "Expand-Archive",
        "-LiteralPath",
        powershellLiteral(zipPath),
        "-DestinationPath",
        powershellLiteral(tmpDir),
        "-Force",
      ].join(" ");
      result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { stdio: "inherit", windowsHide: true },
      );
      if (result.error) {
        throw new Error(`PowerShell Expand-Archive 启动失败：${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`PowerShell Expand-Archive 失败（exit=${result.status ?? "unknown"}）`);
      }
    } else {
      // macOS/Linux 保留系统 tar，bsdtar/gnu tar 都可稳定读取 Node 官方 zip。
      result = spawnSync("tar", ["-xf", zipPath, "-C", tmpDir], { stdio: "inherit" });
      if (result.error) {
        throw new Error(`系统 tar 启动失败：${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`系统 tar 无法解压 zip（exit=${result.status ?? "unknown"}）`);
      }
    }

    const src = path.join(tmpDir, entry);
    if (!fs.existsSync(src) || fs.statSync(src).size <= 0) {
      throw new Error(`ZIP 解压成功但未找到目标文件：${entry}`);
    }
    fs.copyFileSync(src, outFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractTarGz(tgzPath, entry, outFile) {
  // 使用系统 tar（macOS/Linux/Win10+ 均自带）
  const tmpDir = path.join(path.dirname(outFile), ".tmp-tgz");
  ensureDir(tmpDir);
  const r = spawnSync("tar", ["-xzf", tgzPath, "-C", tmpDir, entry], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error("tar -xzf 失败");
  }
  const src = path.join(tmpDir, entry);
  fs.copyFileSync(src, outFile);
  if (process.platform !== "win32") {
    fs.chmodSync(outFile, 0o755);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function fetchOne(key) {
  const cfg = TARGETS[key];
  if (!cfg) throw new Error(`unknown target: ${key}`);
  const platDir = path.join(OUT_DIR, key);
  const outFile = path.join(platDir, cfg.exe);

  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
    console.log(`[fetch-node] ✓ ${key} already exists, skip`);
    return;
  }
  ensureDir(platDir);

  const archivePath = path.join(platDir, `_download.${cfg.kind.replace(".", "_")}`);
  await download(cfg.url, archivePath);

  if (cfg.kind === "zip") {
    await extractZip(archivePath, cfg.entry, outFile);
  } else {
    await extractTarGz(archivePath, cfg.entry, outFile);
  }
  fs.unlinkSync(archivePath);
  console.log(`[fetch-node] ✓ ${key} -> ${outFile}`);
}

async function main() {
  ensureDir(OUT_DIR);
  // .gitignore 保护：避免把巨大的 node 二进制提交进仓库
  const gi = path.join(OUT_DIR, ".gitignore");
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, "*\n!.gitignore\n");
  }

  const all = process.argv.includes("--all");
  const keys = all ? Object.keys(TARGETS) : [currentKey()];
  console.log(`[fetch-node] version=${VERSION}, targets=${keys.join(", ")}`);

  for (const k of keys) {
    try {
      await fetchOne(k);
    } catch (e) {
      console.error(`[fetch-node] ✗ ${k}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

main();
