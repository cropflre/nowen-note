#!/usr/bin/env node
/**
 * 安全打包脚本 —— 规避 Windows 下 electron-builder 常见的 rcedit/文件锁问题。
 *
 * 背景：
 *   Windows 平台打包 Electron 应用时，`rcedit-x64.exe` 要改 `Nowen Note.exe` 的
 *   版本号/图标元信息。这个步骤经常因为以下原因报 `Unable to commit changes`：
 *     1. 之前开发/调试残留的 `Nowen Note.exe` 进程还握着文件句柄；
 *     2. 企业 EDR / Defender / 腾讯电脑管家 对新生成的 PE 做实时扫描，扫描瞬间独占文件；
 *     3. IDE（CodeBuddy / VSCode）对工作区内文件有文件监听/只读句柄；
 *     4. `dist-electron/` 目录里残留上次产物，只读属性或 Everything 索引挂着。
 *
 * 本脚本串联三件事：
 *   - `taskkill` 结束所有 `Nowen Note.exe` 残留进程；
 *   - 设 `NOWEN_BUILD_OUT=1`，让 builder.config.js 把产物输出改到 `%TEMP%\nowen-note-build`，
 *     彻底脱离工作区，避免 IDE 监听；
 *   - 清理临时输出目录，再起 electron-builder 子进程。
 *
 * 用法：
 *   npm run electron:build:safe
 *
 * 只在 Windows 上做 taskkill，其他平台直接透传。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";

function log(msg) {
  console.log(`[safe-build] ${msg}`);
}

// Step 1: 杀残留进程（Windows only）
if (isWin) {
  log("killing leftover 'Nowen Note.exe' processes (if any)...");
  // /F 强制，/IM 按映像名；没进程时 taskkill 会返回非零，忽略即可
  const result = spawnSync("taskkill", ["/F", "/IM", "Nowen Note.exe"], {
    shell: false,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status === 0) {
    log("  -> killed");
  } else {
    // ERROR: 没找到进程 —— 这是期望的正常状态
    log("  -> none running");
  }
}

// Step 2: 设环境变量，切换产物输出目录到 %TEMP%
process.env.NOWEN_BUILD_OUT = "1";
const tmpOut = join(tmpdir(), "nowen-note-build");
log(`output directory -> ${tmpOut}`);

// Step 3: 清理旧产物，防止只读/锁定文件导致 builder 提前报错
if (existsSync(tmpOut)) {
  log("cleaning previous temp output...");
  try {
    rmSync(tmpOut, { recursive: true, force: true });
  } catch (e) {
    log(`  warn: cleanup failed (${e.message}), continuing anyway`);
  }
}

// Step 4: 起 electron-builder
// 注意：这里不用 `npm run electron:build`，因为它会再套一层 npm，导致 Ctrl+C 杀不干净。
// 我们直接串行跑 rebuild:native + build:all + electron-builder。
//
// 对 electron-builder 这一步，我们捕获 stdout/stderr 做"日志降噪"：
// 企业杀软（Defender/EDR/电脑管家）会拦截 rcedit 的 MoveFileEx，造成日志里一堆红字
//   ⨯ cannot execute  cause=exit status 1
//     errorOut=Fatal error: Unable to commit changes
//     command='...\rcedit-x64.exe' '...\Nowen Note.exe' --set-version-string ...
//   • Above command failed, retrying 3 more times
// 但实际上版本号最终还是写进去了（打包完自检 FileVersion=1.0.2 就是证据）。
// 所以把这几行折叠成一条黄色提示，避免误导用户以为"打包失败"。
const steps = [
  { cmd: "npm", args: ["run", "rebuild:native"], filter: false },
  { cmd: "npm", args: ["run", "build:all"], filter: false },
  {
    cmd: "npx",
    args: ["electron-builder", "--config", "electron/builder.config.js"],
    filter: true,
  },
];

// ANSI 颜色
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

// rcedit 假阳性相关的标记。一个完整的"失败块"由以下几行组成：
//   ⨯ cannot execute  cause=exit status 1                  <- 触发
//                     errorOut=Fatal error: Unable to commit changes
//                     command='...\rcedit-x64.exe' ...
//                     workingDir=
//   • Above command failed, retrying 3 more times
// 我们检测到 `⨯ cannot execute` + 紧接着出现 `rcedit` 字样时，
// 把整块吃掉，只打印一行黄色提示。
//
// `deprecated field fields=["signingHashAlgorithms","publisherName"]`
// 也是纯噪音（每签一个文件就重复打一次），只打一次就够。
let rceditFalsePositives = 0;
let deprecatedFieldSeen = false;

function createFilter() {
  let buffer = "";
  // 当前是否正处在"rcedit 失败块"里，需要吞到 `Above command failed` 为止
  let inRceditBlock = false;

  return function filterChunk(chunk) {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    // 保留最后一段（可能是不完整的行）到下次
    buffer = lines.pop() ?? "";

    const out = [];
    for (const raw of lines) {
      const line = raw;

      if (inRceditBlock) {
        // 在 rcedit 失败块里，吞所有行，直到遇到 "Above command failed, retrying"
        // 或者遇到一个看起来不属于错误续行的新消息（以 "  •" 或 "  ⨯" 开头的非续行）
        if (/Above command failed, retrying/.test(line)) {
          inRceditBlock = false;
          rceditFalsePositives += 1;
          out.push(
            `${YELLOW}  ⚠ rcedit 被杀软拦截 (第 ${rceditFalsePositives} 次，日志假阳性，通常不影响最终版本号写入)${RESET}`,
          );
        } else if (/^\s*•\s/.test(line) && !/retrying/.test(line)) {
          // 进入了下一个正常步骤，结束吞噬
          inRceditBlock = false;
          out.push(line);
        }
        // 其它情况（errorOut=... / command=... / workingDir= / 空行）全部吞掉
        continue;
      }

      // 检测 rcedit 失败块的起点
      if (/^\s*⨯\s*cannot execute/.test(line)) {
        inRceditBlock = true;
        continue;
      }

      // 折叠 deprecated field 警告（只保留第一次）
      if (/deprecated field\s+fields=\["signingHashAlgorithms"/.test(line)) {
        if (deprecatedFieldSeen) continue;
        deprecatedFieldSeen = true;
        out.push(
          `${GRAY}  (deprecated: signingHashAlgorithms/publisherName 应迁到 win.signtoolOptions，不影响打包，后续类似警告已折叠)${RESET}`,
        );
        continue;
      }

      // "no signing info identified, signing is skipped" 也是每个 PE 都打一遍的噪音
      if (/no signing info identified, signing is skipped/.test(line)) {
        continue;
      }

      out.push(line);
    }

    if (out.length) {
      process.stdout.write(out.join("\n") + "\n");
    }
  };
}

function runStep(step) {
  const { cmd, args, filter } = step;
  return new Promise((resolve, reject) => {
    log(`\n$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      // Windows 必须 shell:true 才能找到 npm/npx 的 .cmd 包装
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
  log(`\n✓ build succeeded. artifacts -> ${tmpOut}`);

  // ===== 打包后自检 =====
  // electron-builder 对 `rcedit` 失败是"非致命"的：日志里会出现
  //   ⨯ Fatal error: Unable to commit changes
  //   • Above command failed, retrying 3 more times
  // 但继续往下跑 signtool / nsis / portable 也能成功产出安装包。
  //
  // 企业杀软（Defender/电脑管家/EDR）偶尔会在 rcedit 的 MoveFileEx 瞬间拦截，
  // 造成日志报错，但 rcedit 的修改其实**大多数时候仍然持久化**了。
  // 所以日志里看到的红叉是"假阳性" —— 真实结果要看最终 exe 的版本信息。
  //
  // 这里我们读一下 `win-unpacked/Nowen Note.exe` 的 FileVersion，
  // 显式告诉用户：版本号写进去了没有。
  if (isWin) {
    const exePath = join(tmpOut, "win-unpacked", "Nowen Note.exe");
    if (existsSync(exePath)) {
      const ps = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Item '${exePath}').VersionInfo | Select-Object FileVersion, ProductName, FileDescription | ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8" },
      );
      if (ps.status === 0 && ps.stdout) {
        try {
          const info = JSON.parse(ps.stdout.trim());
          const version = info.FileVersion ?? "";
          const isDefault = !version || version.startsWith("33.");
          log(`exe FileVersion:   ${version || "<empty>"}`);
          log(`exe ProductName:   ${info.ProductName ?? "<empty>"}`);
          log(`exe Description:   ${info.FileDescription ?? "<empty>"}`);

          if (rceditFalsePositives > 0 && !isDefault) {
            log(
              `\n${YELLOW}ℹ rcedit 日志报了 ${rceditFalsePositives} 次 "Unable to commit changes"，` +
                `但实测版本号 ${version} 已正确写入，属日志层面的假阳性，可忽略。${RESET}`,
            );
          } else if (isDefault) {
            log("\n⚠ rcedit 似乎真的没写入版本号（FileVersion 仍是 Electron 默认值）。");
            log("  安装包能用，但右键属性会显示成 Electron 33.x。");
            log("  可以重跑一次 npm run electron:build:safe 试试。");
          }
        } catch {
          // JSON 解析失败就跳过，不影响主流程
        }
      }
    }
  }
} catch (err) {
  console.error(`\n[safe-build] FAILED: ${err.message}`);
  process.exit(1);
}
