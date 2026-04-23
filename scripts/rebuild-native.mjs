#!/usr/bin/env node
/**
 * rebuild-native.mjs
 * --------------------------------------------------
 * 将 backend/ 下的原生模块（主要是 better-sqlite3）重新编译为
 * 当前 Electron 版本可用的 ABI 版本。
 *
 * 背景：
 *   走"让后端跑在 Electron 自身（ELECTRON_RUN_AS_NODE=1）"方案后，
 *   better-sqlite3 的 .node 必须使用 Electron 内置的 node headers 编译，
 *   否则会在 require 阶段抛 "was compiled against a different Node.js version" 等错误。
 *
 *   electron-builder 自带的 `install-app-deps` 只扫根 node_modules，进不到 backend，
 *   所以需要显式调用 @electron/rebuild。
 *
 * 用法：
 *   node scripts/rebuild-native.mjs
 *
 * 要求：
 *   npm i -D @electron/rebuild
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

async function main() {
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const electronDep =
    rootPkg.devDependencies?.electron || rootPkg.dependencies?.electron;
  if (!electronDep) {
    console.error("[rebuild-native] 根 package.json 未找到 electron 依赖");
    process.exit(1);
  }
  // 去掉 ^ ~ >= 等前缀
  const electronVersion = electronDep.replace(/^[^\d]*/, "");
  console.log("[rebuild-native] target electron:", electronVersion);

  let rebuild;
  try {
    ({ rebuild } = await import("@electron/rebuild"));
  } catch (e) {
    console.error(
      "[rebuild-native] 缺少依赖 @electron/rebuild。请先安装：\n" +
        "  npm i -D @electron/rebuild\n" +
        "然后再运行本脚本。"
    );
    process.exit(1);
  }

  const backendDir = path.join(ROOT, "backend");
  if (!fs.existsSync(path.join(backendDir, "node_modules"))) {
    console.error(
      "[rebuild-native] backend/node_modules 不存在，请先 `cd backend && npm install`"
    );
    process.exit(1);
  }

  console.log(`[rebuild-native] rebuilding native modules under ${backendDir} ...`);
  const start = Date.now();
  await rebuild({
    buildPath: backendDir,
    electronVersion,
    force: true,
    // 只 rebuild 真正需要原生编译的模块（避免把 jszip/mammoth 之类纯 JS 的也扫一遍）
    onlyModules: ["better-sqlite3"],
  });
  console.log(
    `[rebuild-native] ✓ done in ${((Date.now() - start) / 1000).toFixed(1)}s`
  );
}

main().catch((err) => {
  console.error("[rebuild-native] failed:", err?.message || err);
  process.exit(1);
});
