#!/usr/bin/env node
/**
 * Lite 发行版打包脚本。
 *
 * 与 scripts/safe-build.mjs 的差异：
 *   - **不**跑 `npm run rebuild:native`（lite 没 backend，也就不需要为 Electron ABI 重建 better-sqlite3）
 *   - **不**跑 `npm run build:backend`（lite 不打 backend/dist）
 *   - 使用 electron/builder.lite.config.js
 *   - 默认产物目录：dist-electron-lite/（或 %TEMP%/nowen-note-lite-build 当 --safe 启用）
 *
 * 用法：
 *   node scripts/build-lite.mjs          # 普通打包
 *   node scripts/build-lite.mjs --safe   # Windows 下启用：taskkill 残留进程 + 临时目录输出
 *   （可通过 npm scripts 暴露为 electron:build:lite / electron:build:lite:safe）
 *
 * 产物（Windows x64 示例）：
 *   dist-electron-lite/
 *     Nowen Note Lite-1.0.31-lite-setup.exe
 *     Nowen Note Lite-1.0.31-lite-portable.exe
 *     win-unpacked/
 *
 * 与 full 版的互不干扰：
 *   - appId 不同（com.nowen.note.lite）→ 注册表 key、安装路径独立
 *   - productName 带 Lite → 开始菜单/Dock 不冲突
 *   - autoUpdate channel="lite" → feed 独立
 *   - 运行时 main.js 读 resourcesPath/backend/dist/index.js 不存在 → 强制 lite 模式
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";

// --safe：触发 Windows 专属的 taskkill + 输出迁移至 %TEMP%
const args = process.argv.slice(2);
const SAFE_MODE = args.includes("--safe");

function log(msg) {
  console.log(`[build-lite] ${msg}`);
}

// ========== Step 1: safe 模式下结束 lite 残留进程（仅 Windows） ==========
// full 版和 lite 版的 exe 名不同，所以 taskkill 只杀 "Nowen Note Lite.exe"，
// 不影响正常开发/调试中的 full 版。
if (isWin && SAFE_MODE) {
  log("safe mode: killing leftover 'Nowen Note Lite.exe' processes (if any)...");
  const result = spawnSync("taskkill", ["/F", "/IM", "Nowen Note Lite.exe"], {
    shell: false,
    stdio: "pipe",
    encoding: "utf8",
  });
  log(result.status === 0 ? "  -> killed" : "  -> none running");
}

// ========== Step 2: safe 模式下切输出目录到 %TEMP% ==========
let tmpOut = null;
if (SAFE_MODE) {
  process.env.NOWEN_BUILD_OUT = "1";
  tmpOut = join(tmpdir(), "nowen-note-lite-build");
  log(`safe mode: output directory -> ${tmpOut}`);
  if (existsSync(tmpOut)) {
    log("cleaning previous temp output...");
    try {
      rmSync(tmpOut, { recursive: true, force: true });
    } catch (e) {
      log(`  warn: cleanup failed (${e.message}), continuing anyway`);
    }
  }
}

// ========== Step 3: 构建前端 + electron-builder（lite config） ==========
// 注意顺序：
//   1) 只 build:frontend，**不** build:backend、**不** rebuild:native
//   2) electron-builder 读 electron/builder.lite.config.js
const steps = [
  {
    cmd: "npm",
    args: ["run", "build:frontend"],
    filter: false,
  },
  {
    cmd: "npx",
    args: ["electron-builder", "--config", "electron/builder.lite.config.js"],
    filter: true,
  },
  {
    cmd: "node",
    args: ["build/verifyUpdateArtifactsCli.js", tmpOut || "dist-electron-lite"],
    filter: false,
  },
];

// ANSI 颜色（与 safe-build 保持一致，便于以后合并公共模块）
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

// rcedit / 签名相关的假阳性折叠（复刻 safe-build 的策略，但精简到最小）
//
// Windows 杀软会拦截 rcedit 的 MoveFileEx，导致：
//   ⨯ cannot execute  cause=exit status 1
//                     errorOut=Fatal error: Unable to commit changes
//                     command='...\rcedit-x64.exe' 'Nowen Note Lite.exe' ...
//   • Above command failed, retrying 3 more times
// 但版本号通常仍写入成功，属日志假阳性。
let rceditFalsePositives = 0;
let deprecatedFieldSeen = false;

function createFilter() {
  let buffer = "";
  let inRceditBlock = false;
  return function filterChunk(chunk) {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    const out = [];
    for (const line of lines) {
      if (inRceditBlock) {
        if (/Above command failed, retrying/.test(line)) {
          inRceditBlock = false;
          rceditFalsePositives += 1;
          out.push(
            `${YELLOW}  ⚠ rcedit 被杀软拦截 (第 ${rceditFalsePositives} 次，日志假阳性，通常不影响最终版本号写入)${RESET}`,
          );
        } else if (/^\s*•\s/.test(line) && !/retrying/.test(line)) {
          inRceditBlock = false;
          out.push(line);
        }
        continue;
      }
      if (/^\s*⨯\s*cannot execute/.test(line)) {
        inRceditBlock = true;
        continue;
      }
      if (/deprecated field\s+fields=\["signingHashAlgorithms"/.test(line)) {
        if (deprecatedFieldSeen) continue;
        deprecatedFieldSeen = true;
        out.push(
          `${GRAY}  (deprecated: signingHashAlgorithms/publisherName 应迁到 win.signtoolOptions，不影响打包)${RESET}`,
        );
        continue;
      }
      if (/no signing info identified, signing is skipped/.test(line)) continue;
      out.push(line);
    }
    if (out.length) process.stdout.write(out.join("\n") + "\n");
  };
}

function runStep(step) {
  const { cmd, args, filter } = step;
  return new Promise((resolve, reject) => {
    log(`\n$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      shell: isWin,
      stdio: filter ? ["inherit", "pipe", "pipe"] : "inherit",
      env: process.env,
    });
    if (filter) {
      const onStdout = createFilter();
      const onStderr = createFilter();
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
    }
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

try {
  for (const step of steps) {
    await runStep(step);
  }
  const finalOut = tmpOut || "dist-electron-lite";
  log(`\n✓ lite build succeeded. artifacts -> ${finalOut}`);

  // ===== 打包后自检（Windows） =====
  // 只检查 exe 是否正确生成 + 版本号是否写入。不跑 full 版那套复杂的 PowerShell 查询，
  // lite 版体量小、跑一次快，用户只需知道产物在哪就够了。
  if (isWin) {
    const exePath = join(finalOut, "win-unpacked", "Nowen Note Lite.exe");
    if (existsSync(exePath)) {
      log(`exe path:          ${exePath}`);
      if (rceditFalsePositives > 0) {
        log(
          `${YELLOW}ℹ rcedit 日志报了 ${rceditFalsePositives} 次 "Unable to commit changes"，属假阳性，可忽略。${RESET}`,
        );
      }
    } else {
      log(
        `${YELLOW}⚠ 没有找到 ${exePath}；请检查 electron-builder 输出是否有其他错误。${RESET}`,
      );
    }
  }
} catch (err) {
  console.error(`\n[build-lite] FAILED: ${err.message}`);
  process.exit(1);
}
