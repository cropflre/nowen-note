#!/usr/bin/env node
/**
 * rebuild-native.mjs
 * --------------------------------------------------
 * 将 backend/ 下的原生模块（主要是 better-sqlite3）准备为
 * 当前 Electron 版本 + 目标平台可用的二进制。
 *
 * 两种模式：
 *   1) 同平台 rebuild（host == target）
 *        - 调 @electron/rebuild 真编译
 *        - 覆盖 electron ABI、目标平台的 PE/ELF/Mach-O 文件格式
 *   2) 跨平台 prepare（host != target，例如 Linux 上打 Win 包）
 *        - @electron/rebuild 只能编 host 架构，编出来装到目标平台会
 *          报 "is not a valid Win32 application" / "wrong ELF class" 等
 *        - 改为通过 prebuild-install 直接下载 better-sqlite3 官方为
 *          该 Electron 版本 + 目标 platform/arch 预编译好的 .node
 *
 * 关键陷阱（历史教训）：
 *   A) `npm ci` 会先让 prebuild-install 下载 **裸 Node 版** prebuilt
 *      (NODE_MODULE_VERSION=115，非 Electron ABI)，装包后崩。
 *      → 必须在 rebuild/download 前先清掉旧 build/prebuilds。
 *   B) 只校验 electronVersion 不校验 platform/arch 时，Linux 上编出的
 *      `.so` 可以糊弄 stamp 通过，打进 Win 安装包后 dlopen 失败。
 *      → 现在 stamp 里写入 platform + arch，builder.config.js 强校验。
 *
 * 用法：
 *   node scripts/rebuild-native.mjs
 *       同平台构建（默认）
 *   node scripts/rebuild-native.mjs --target-platform=win32 --target-arch=x64
 *       跨平台准备（例：Linux 上打 Win 包前）
 *   环境变量等价：TARGET_PLATFORM / TARGET_ARCH
 *
 * 要求：
 *   npm i -D @electron/rebuild
 *   Windows（同平台 rebuild）还需要 VS Build Tools（含 C++）+ Python 3
 *   跨平台 prepare 不需要编译工具链，只需要网络能下载 better-sqlite3 prebuilt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

/** 递归删除目录（Node 14.14+ 支持 fs.rmSync 的 recursive） */
function rimrafSync(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

/** 解析 --key=value 或 --key value 形式的命令行参数 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = "true";
      }
    }
  }
  return out;
}

/**
 * 通过读取文件魔数判断 `.node` 的目标平台和 CPU 架构，避免 stamp 被手工篡改后仍然放行。
 *   Windows PE:   "MZ"        (0x4D 0x5A)，本项目只发 x64
 *   Linux ELF:    "\x7FELF"   e_machine 区分 x64/arm64
 *   macOS Mach-O: 解析 cputype；fat binary 视为 universal
 */
function detectNodeFilePlatform(nodeFile) {
  try {
    const fd = fs.openSync(nodeFile, "r");
    const buf = Buffer.alloc(20);
    fs.readSync(fd, buf, 0, 20, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x4d && buf[1] === 0x5a) return { platform: "win32", arch: "x64" };
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      const eMachine = buf.readUInt16LE(0x12);
      const arch = eMachine === 0x3e ? "x64" : eMachine === 0xb7 ? "arm64" : "unknown";
      return { platform: "linux", arch };
    }
    const m = buf.readUInt32BE(0);
    if (m === 0xcafebabe) return { platform: "darwin", arch: "universal" };
    if (m === 0xfeedface || m === 0xcefaedfe || m === 0xfeedfacf || m === 0xcffaedfe) {
      const isLE = m === 0xcefaedfe || m === 0xcffaedfe;
      const cputype = isLE ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
      const arch = cputype === 0x01000007 ? "x64" : cputype === 0x0100000c ? "arm64" : "unknown";
      return { platform: "darwin", arch };
    }
    return { platform: "unknown", arch: "unknown" };
  } catch {
    return { platform: "unknown", arch: "unknown" };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetPlatform =
    args["target-platform"] || process.env.TARGET_PLATFORM || process.platform;
  const targetArch =
    args["target-arch"] || process.env.TARGET_ARCH || process.arch;
  const hostPlatform = process.platform;
  const hostArch = process.arch;
  // --prebuild 或 NOWEN_FORCE_PREBUILD=1：即使同平台也强制走 prebuild-install，
  // 用于本地缺少可用 C++ 工具链（例如 VS 18 还没被 node-gyp 识别）的应急情况。
  const forcePrebuild =
    args["prebuild"] === "true" ||
    args["force-prebuild"] === "true" ||
    process.env.NOWEN_FORCE_PREBUILD === "1";
  const isCross =
    forcePrebuild ||
    targetPlatform !== hostPlatform ||
    targetArch !== hostArch;

  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const electronDep =
    rootPkg.devDependencies?.electron || rootPkg.dependencies?.electron;
  if (!electronDep) {
    console.error("[rebuild-native] 根 package.json 未找到 electron 依赖");
    process.exit(1);
  }
  const electronVersion = electronDep.replace(/^[^\d]*/, "");

  console.log(`[rebuild-native] host:   ${hostPlatform}-${hostArch}`);
  console.log(`[rebuild-native] target: ${targetPlatform}-${targetArch}`);
  console.log(
    `[rebuild-native] mode:   ${
      isCross
        ? forcePrebuild && targetPlatform === hostPlatform && targetArch === hostArch
          ? "FORCED-PREBUILD (prebuild-install)"
          : "CROSS (prebuild-install)"
        : "NATIVE (@electron/rebuild)"
    }`
  );
  console.log(`[rebuild-native] electron: ${electronVersion}`);

  const backendDir = path.join(ROOT, "backend");
  if (!fs.existsSync(path.join(backendDir, "node_modules"))) {
    console.error(
      "[rebuild-native] backend/node_modules 不存在，请先 `cd backend && npm install`"
    );
    process.exit(1);
  }

  // ===== 关键步骤 1：清掉旧产物（npm ci 时 prebuild-install 拉的 Node 版 .node）=====
  const bsRoot = path.join(backendDir, "node_modules", "better-sqlite3");
  const bsBuildDir = path.join(bsRoot, "build");
  const bsPrebuildsDir = path.join(bsRoot, "prebuilds");
  if (fs.existsSync(bsBuildDir)) {
    console.log(`[rebuild-native] 清理旧的编译产物：${bsBuildDir}`);
    rimrafSync(bsBuildDir);
  }
  if (fs.existsSync(bsPrebuildsDir)) {
    console.log(`[rebuild-native] 清理旧的 prebuilds：${bsPrebuildsDir}`);
    rimrafSync(bsPrebuildsDir);
  }

  const nodFile = path.join(bsBuildDir, "Release", "better_sqlite3.node");
  const start = Date.now();

  if (isCross) {
    // ===== 跨平台分支：用 prebuild-install 直接下 target 平台的 .node =====
    // @electron/rebuild 只能编出 host 架构，跨平台编出来装不上。
    // better-sqlite3 官方为每个 Electron ABI × 每个平台都发布了 prebuilt 包，
    // 直接拉即可。
    console.log(
      `[rebuild-native] cross-platform prepare via prebuild-install ` +
        `(runtime=electron, target=${electronVersion}, platform=${targetPlatform}, arch=${targetArch})`
    );
    // 优先用 backend 内的 prebuild-install shim：直接调 .cmd 比 npx 在 Windows 上稳得多
    // （npx 在 PowerShell 里可能因 spawn 找不到 npx.cmd 而退出码 null）。
    const isWin = process.platform === "win32";
    const binShim = path.join(
      backendDir,
      "node_modules",
      ".bin",
      isWin ? "prebuild-install.cmd" : "prebuild-install"
    );
    const useShim = fs.existsSync(binShim);
    const cmd = useShim ? binShim : isWin ? "npx.cmd" : "npx";
    const cmdArgs = [
      ...(useShim ? [] : ["--yes", "prebuild-install"]),
      "--runtime=electron",
      `--target=${electronVersion}`,
      `--platform=${targetPlatform}`,
      `--arch=${targetArch}`,
      "--tag-prefix=v",
      "--verbose",
    ];
    console.log(`[rebuild-native] exec: ${cmd} ${cmdArgs.join(" ")}`);
    const res = spawnSync(cmd, cmdArgs, {
      cwd: bsRoot,
      stdio: "inherit",
      // Windows 上 spawn .cmd 文件必须 shell:true，否则 status=null。
      shell: isWin,
      env: {
        ...process.env,
        // 禁止 prebuild-install 当成"源码构建回退"——跨平台必须拿到预编译，
        // 拿不到就直接失败而不是尝试在 host 编译出错 ABI 的产物。
        npm_config_build_from_source: "false",
      },
    });
    if (res.status !== 0) {
      console.error(
        `[rebuild-native] prebuild-install 失败（退出码 ${res.status}）\n` +
          `  可能原因：\n` +
          `    1) 网络无法访问 GitHub Releases（better-sqlite3 prebuilt 托管在那里）\n` +
          `    2) 该 electron ABI × platform × arch 组合没有官方 prebuilt\n` +
          `  建议：\n` +
          `    - 换到 ${targetPlatform} 机器上直接 native rebuild\n` +
          `    - 或为网络设置代理：HTTPS_PROXY / HTTP_PROXY`
      );
      process.exit(1);
    }
  } else {
    // ===== 同平台分支：@electron/rebuild 真编译 =====
    let rebuild;
    try {
      ({ rebuild } = await import("@electron/rebuild"));
    } catch {
      console.error(
        "[rebuild-native] 缺少依赖 @electron/rebuild。请先 npm i -D @electron/rebuild。"
      );
      process.exit(1);
    }
    // 强制走源码编译，不要被 prebuild-install 捡回裸 Node 版
    process.env.npm_config_build_from_source = "true";
    process.env.PREBUILD_INSTALL_FORCE_BUILD = "true";
    console.log(`[rebuild-native] rebuilding native modules under ${backendDir} ...`);
    await rebuild({
      buildPath: backendDir,
      electronVersion,
      force: true,
      onlyModules: ["better-sqlite3"],
      disablePreGypCopy: true,
    });
  }

  const elapsed = (Date.now() - start) / 1000;
  console.log(`[rebuild-native] ✓ done in ${elapsed.toFixed(1)}s`);

  // ===== 验证产物 =====
  if (!fs.existsSync(nodFile)) {
    console.error(
      `[rebuild-native] ⚠ 未找到 ${nodFile}，打包后 Electron 启动会报 ERR_DLOPEN_FAILED！`
    );
    process.exit(1);
  }
  const stat = fs.statSync(nodFile);
  const detected = detectNodeFilePlatform(nodFile);
  const expectDetected =
    targetPlatform === "win32"
      ? "win32"
      : targetPlatform === "darwin"
        ? "darwin"
        : "linux";
  if (detected.platform !== expectDetected) {
    console.error(
      `[rebuild-native] ✗ 产物平台不匹配！\n` +
        `   期望: ${expectDetected}（${targetPlatform}-${targetArch}）\n` +
        `   实际: ${detected.platform}-${detected.arch}（根据文件魔数识别）\n` +
        `   这份 .node 拷到目标机器一定 dlopen 失败。`
    );
    process.exit(1);
  }
  if (detected.arch !== "universal" && detected.arch !== "unknown" && detected.arch !== targetArch) {
    console.error(
      `[rebuild-native] ✗ 产物 CPU 架构不匹配！\n` +
        `   期望: ${targetPlatform}-${targetArch}\n` +
        `   实际: ${detected.platform}-${detected.arch}（根据文件魔数识别）\n` +
        `   这份 .node 打进 ${targetArch} 安装包后会 ERR_DLOPEN_FAILED。`
    );
    process.exit(1);
  }
  console.log(
    `[rebuild-native] ✓ verified: ${nodFile} ` +
      `(${(stat.size / 1024 / 1024).toFixed(1)} MB, detected=${detected.platform}-${detected.arch})`
  );

  // ===== 写 stamp =====
  const stampPath = path.join(bsBuildDir, "Release", ".electron-abi.json");
  fs.writeFileSync(
    stampPath,
    JSON.stringify(
      {
        electronVersion,
        platform: targetPlatform,
        arch: targetArch,
        detectedPlatform: detected.platform,
        detectedArch: detected.arch,
        rebuiltAt: new Date().toISOString(),
        nodeMtime: stat.mtime.toISOString(),
        mode: isCross ? "cross-prebuild" : "native-rebuild",
        hostPlatform,
        hostArch,
      },
      null,
      2
    )
  );
  console.log(`[rebuild-native] ✓ stamped: ${stampPath}`);
}

main().catch((err) => {
  console.error("[rebuild-native] failed:", err?.message || err);
  process.exit(1);
});
