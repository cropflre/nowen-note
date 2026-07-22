/**
 * electron-builder 配置
 * @type {import('electron-builder').Configuration}
 */
const path = require("path");
const os = require("os");
const fs = require("fs");

// ===== 打包前校验：better-sqlite3 原生模块必须已 rebuild 为 Electron ABI + 目标平台 =====
// 防止忘记 `npm run rebuild:native` 就打包，或在 Linux 上为 Win 目标编出 Linux .so，
// 导致安装后 ERR_DLOPEN_FAILED / "is not a valid Win32 application"。
//
// argv 中可能包含 --win / --mac / --linux（electron-builder 的平台开关）；
// 没有则按 process.platform 推断。
function inferTargetPlatformFromArgv() {
  const argv = process.argv.join(" ");
  if (/\s--win(\s|=|$)/.test(argv)) return "win32";
  if (/\s--mac(\s|=|$)/.test(argv)) return "darwin";
  if (/\s--linux(\s|=|$)/.test(argv)) return "linux";
  return process.platform;
}

function inferTargetArch(targetPlatform) {
  const explicit = process.env.npm_config_target_arch || process.env.TARGET_ARCH;
  if (explicit) return explicit;
  if (targetPlatform === "darwin" && process.env.NOWEN_MAC_ARCH) {
    return process.env.NOWEN_MAC_ARCH === "arm64" ? "arm64" : "x64";
  }
  return process.arch;
}

/**
 * 通过文件魔数识别 .node 目标平台 + 架构，避免 stamp 被错误标注时假通过。
 *   Windows PE:   "MZ"（不解析 arch，Win 我们只发 x64）
 *   Linux ELF:    "\x7FELF"，第 19 字节 e_machine 区分 x86_64(0x3E)/aarch64(0xB7)
 *   macOS Mach-O: 0xFEEDFACE/0xCEFAEDFE/0xFEEDFACF/0xCFFAEDFE/0xCAFEBABE
 *                 magic 后紧跟 cputype（CPU_TYPE_X86_64=0x01000007 / CPU_TYPE_ARM64=0x0100000C）
 *                 0xCAFEBABE 是 fat binary，含 x64+arm64，arch 返回 "universal"
 *
 * 返回 { platform, arch }，识别不出来对应字段为 "unknown"。
 */
function detectNodeFilePlatform(nodeFile) {
  try {
    const fd = fs.openSync(nodeFile, "r");
    const buf = Buffer.alloc(20);
    fs.readSync(fd, buf, 0, 20, 0);
    fs.closeSync(fd);
    // Windows PE
    if (buf[0] === 0x4d && buf[1] === 0x5a) {
      return { platform: "win32", arch: "x64" }; // 我们只发 x64，简化
    }
    // Linux ELF
    if (
      buf[0] === 0x7f &&
      buf[1] === 0x45 &&
      buf[2] === 0x4c &&
      buf[3] === 0x46
    ) {
      // ELF e_machine 在 LE 下位于 offset 0x12
      const eMachine = buf.readUInt16LE(0x12);
      const arch =
        eMachine === 0x3e ? "x64" : eMachine === 0xb7 ? "arm64" : "unknown";
      return { platform: "linux", arch };
    }
    // macOS Mach-O
    const m = buf.readUInt32BE(0);
    if (m === 0xcafebabe) {
      // fat binary，含多架构
      return { platform: "darwin", arch: "universal" };
    }
    if (
      m === 0xfeedface ||
      m === 0xcefaedfe ||
      m === 0xfeedfacf ||
      m === 0xcffaedfe
    ) {
      // little-endian (CEFAEDFE/CFFAEDFE) 时 cputype 用 readUInt32LE，否则 BE
      const isLE = m === 0xcefaedfe || m === 0xcffaedfe;
      const cputype = isLE ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
      const arch =
        cputype === 0x01000007
          ? "x64"
          : cputype === 0x0100000c
            ? "arm64"
            : "unknown";
      return { platform: "darwin", arch };
    }
    return { platform: "unknown", arch: "unknown" };
  } catch {
    return { platform: "unknown", arch: "unknown" };
  }
}

// ===== ABI 符号实测：扫描 .node 内 "node_register_module_v<N>" =====
// 这是最可靠的 ABI 校验：编译器会把 NODE_MODULE_VERSION 直接拼进入口符号名。
// 历史教训（2026-05-25）：prebuild-install 缓存命中错位，stamp 写 electron=33.0.0、
// platform/arch 全对，但实际下载的是 Node ABI(115) 而非 Electron ABI(130) 的 .node，
// 安装到用户机后必爆 "NODE_MODULE_VERSION 115 vs 130"。
// 这里直接读文件字节串验证，杜绝任何中间环节的"假对齐"。
const NODE_MODULE_VERSION_BY_ELECTRON_MAJOR = {
  28: 119,
  29: 121,
  30: 123,
  31: 125,
  32: 128,
  33: 130,
  34: 133,
  35: 136,
};

function detectNodeAbiVersion(nodeFile) {
  // 读全文件然后正则——.node 通常 ~2MB，可以接受
  const buf = fs.readFileSync(nodeFile);
  const s = buf.toString("latin1");
  const re = /node_register_module_v(\d+)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(s))) found.add(parseInt(m[1], 10));
  return [...found];
}

function checkNativeModule() {
  const nodeFile = path.resolve(
    __dirname,
    "..",
    "backend",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );
  if (!fs.existsSync(nodeFile)) {
    throw new Error(
      `[builder] better-sqlite3 原生模块不存在：${nodeFile}\n` +
        `请先运行 npm run rebuild:native 编译为 Electron ABI！`
    );
  }
  const stat = fs.statSync(nodeFile);
  console.log(
    `[builder] ✓ better-sqlite3.node found (${(stat.size / 1024 / 1024).toFixed(1)} MB, ` +
      `mtime=${stat.mtime.toISOString()})`
  );

  const stampFile = path.resolve(path.dirname(nodeFile), ".electron-abi.json");
  if (!fs.existsSync(stampFile)) {
    throw new Error(
      `[builder] 未找到 Electron ABI stamp（${stampFile}）。\n` +
        `这说明 better_sqlite3.node 没有经过 rebuild-native 重新编译，\n` +
        `打出来的包到用户机会报 ERR_DLOPEN_FAILED。\n` +
        `修复：执行 npm run rebuild:native 后再打包。`
    );
  }
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
  } catch (e) {
    throw new Error(`[builder] stamp 文件解析失败：${e.message}`);
  }
  const rootPkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")
  );
  const electronDep =
    rootPkg.devDependencies?.electron || rootPkg.dependencies?.electron;
  const expectedElectron = (electronDep || "").replace(/^[^\d]*/, "");
  if (stamp.electronVersion !== expectedElectron) {
    throw new Error(
      `[builder] better_sqlite3.node 是为 Electron ${stamp.electronVersion} 编译的，\n` +
        `但当前 package.json 声明的 electron 版本是 ${expectedElectron}。\n` +
        `请重新执行 npm run rebuild:native。`
    );
  }

  // ===== 目标平台/架构强校验 =====
  // 这是 2026-05 事故（Linux 上打 Win 包 → 装包后 "not a valid Win32 application"）
  // 的根治修复：只看 electronVersion 不足，必须还要对齐 platform + arch。
  const targetPlatform = inferTargetPlatformFromArgv();
  const targetArch = inferTargetArch(targetPlatform);
  const stampPlatform = stamp.platform;
  const stampArch = stamp.arch;
  if (!stampPlatform || !stampArch) {
    throw new Error(
      `[builder] stamp 缺少 platform/arch 字段（旧版 rebuild-native 产物）。\n` +
        `请重新执行 npm run rebuild:native。`
    );
  }
  if (stampPlatform !== targetPlatform || stampArch !== targetArch) {
    throw new Error(
      `[builder] ✗ better_sqlite3.node 的 platform/arch 与打包目标不匹配！\n` +
        `   stamp  : ${stampPlatform}-${stampArch}\n` +
        `   target : ${targetPlatform}-${targetArch}\n` +
        `   修复：npm run rebuild:native -- --target-platform=${targetPlatform} --target-arch=${targetArch}`
    );
  }

  // 文件魔数兜底校验（stamp 可能被手工改过 / rebuild-native 漏写 arch 字段）
  // 历史教训（2026-05 mac Intel ERR_DLOPEN_FAILED）：mac 同时打 arm64+x64 时，
  // 仅靠 stamp 校验，arm64 包里会塞着 x64 的 .node。所以这里 platform + arch 都要查。
  const detected = detectNodeFilePlatform(nodeFile);
  const expectPlatform =
    targetPlatform === "win32"
      ? "win32"
      : targetPlatform === "darwin"
        ? "darwin"
        : "linux";
  if (detected.platform !== expectPlatform) {
    throw new Error(
      `[builder] ✗ better_sqlite3.node 文件格式不匹配目标平台！\n` +
        `   expected (by magic) : ${expectPlatform}\n` +
        `   actual               : ${detected.platform}\n` +
        `   这份 .node 打进安装包后会报 ERR_DLOPEN_FAILED / "not a valid Win32 application"。\n` +
        `   修复：npm run rebuild:native -- --target-platform=${targetPlatform} --target-arch=${targetArch}`
    );
  }
  // arch 校验：universal（fat binary）算兼容；其余必须严格相等
  if (
    detected.arch !== "universal" &&
    detected.arch !== "unknown" &&
    detected.arch !== targetArch
  ) {
    throw new Error(
      `[builder] ✗ better_sqlite3.node 的 CPU 架构与打包目标不匹配！\n` +
        `   expected (by magic) : ${targetPlatform}-${targetArch}\n` +
        `   actual               : ${detected.platform}-${detected.arch}\n` +
        `   这份 .node 打进 ${targetPlatform}-${targetArch} 安装包后会报 ERR_DLOPEN_FAILED。\n` +
        `   修复：npm run rebuild:native -- --target-platform=${targetPlatform} --target-arch=${targetArch}`
    );
  }

  if (stamp.nodeMtime && stamp.nodeMtime !== stat.mtime.toISOString()) {
    console.warn(
      `[builder] ⚠ stamp 中记录的 .node mtime 与当前文件不一致：\n` +
        `   stamp: ${stamp.nodeMtime}\n` +
        `   actual: ${stat.mtime.toISOString()}\n` +
        `   建议重新执行 npm run rebuild:native。`
    );
  }
  console.log(
    `[builder] ✓ ABI stamp verified (electron=${stamp.electronVersion}, ` +
      `platform=${stampPlatform}-${stampArch}, mode=${stamp.mode || "native-rebuild"}, ` +
      `rebuiltAt=${stamp.rebuiltAt})`
  );

  // ===== 最终守门：ABI 符号实测 =====
  const electronMajor = parseInt(expectedElectron.split(".")[0], 10);
  const expectedAbi = NODE_MODULE_VERSION_BY_ELECTRON_MAJOR[electronMajor];
  if (!expectedAbi) {
    console.warn(
      `[builder] ⚠ 未知 Electron major=${electronMajor}，跳过 ABI 符号实测。\n` +
        `   请在 NODE_MODULE_VERSION_BY_ELECTRON_MAJOR 中补一行映射。`
    );
    return;
  }
  const detectedAbi = detectNodeAbiVersion(nodeFile);
  if (!detectedAbi.includes(expectedAbi)) {
    throw new Error(
      `[builder] ✗ better_sqlite3.node ABI 符号实测失败！\n` +
        `   expected NODE_MODULE_VERSION : ${expectedAbi}（Electron ${electronMajor}）\n` +
        `   detected in .node            : [${detectedAbi.join(", ") || "none"}]\n` +
        `   这份 .node 装到用户机会爆 "NODE_MODULE_VERSION X vs ${expectedAbi}"。\n` +
        `   修复：先删 backend\\node_modules\\better-sqlite3\\build，\n` +
        `         然后清 ~/.npm/_prebuilds 下的 better-sqlite3 缓存，\n` +
        `         再执行 npm run rebuild:native。`
    );
  }
  console.log(
    `[builder] ✓ ABI symbol verified: node_register_module_v${expectedAbi}`
  );
}

// 允许把输出目录放到工作区外，避免 IDE / Defender 对打包产物做文件监听锁
// 用法：set NOWEN_BUILD_OUT=1 && npm run electron:build
const OUT_DIR = process.env.NOWEN_BUILD_OUT
  ? path.join(os.tmpdir(), "nowen-note-build")
  : "dist-electron";

// ===== 跨平台打 Windows 目标时的 rcedit / 代码签名处理 =====
//
// 背景：
//   在 Linux（Debian）上跨平台打 Windows exe 时，electron-builder 会：
//     1) 通过 wine 调 rcedit.exe 修改 exe 的图标、版本号、产品名
//     2) 如果提供了 CSC_LINK，用 osslsigncode 或 signtool 做代码签名
//   rcedit 本身没问题，但首次会从 GitHub 下载 winCodeSign 压缩包（~60MB），
//   国内网络可能卡很久甚至失败。
//
// 环境变量：
//   NOWEN_SKIP_RCEDIT=1         完全跳过 rcedit（exe 图标/版本信息用 electron 默认）
//                               （适合没配 CSC、且首次 debian 打包想快速出包时）
//   CSC_LINK / CSC_KEY_PASSWORD 有则正常签名；没配则 electron-builder 自动跳过
//
// 判定策略：
//   - 显式 NOWEN_SKIP_RCEDIT=1  -> 强制 false
//   - 否则默认 true（保持原行为：注入图标、版本元信息、走签名流程）
const SKIP_RCEDIT = process.env.NOWEN_SKIP_RCEDIT === "1";
const SIGN_AND_EDIT_EXECUTABLE = !SKIP_RCEDIT;

// ===== Linux 包元信息（deb 必填，否则 electron-builder 会 warn）=====
// 这些字段同时被 AppImage 和 deb 使用
const LINUX_MAINTAINER =
  process.env.NOWEN_LINUX_MAINTAINER || "Nowen <noreply@nowen.local>";
const LINUX_VENDOR = process.env.NOWEN_LINUX_VENDOR || "Nowen";
const LINUX_HOMEPAGE =
  process.env.NOWEN_LINUX_HOMEPAGE || "https://github.com/cropflre/nowen-note";

// ===== 体积优化：精简后端 node_modules =====
// 后端通过 esbuild bundle 成单文件（backend/dist/index.js），
// 但仍有少量"必须保留为 external"的包：
//   - better-sqlite3            原生 .node 模块
//   - sqlite-vec / sqlite-vec-{platform}-{arch}  平台二进制 .so/.dll/.dylib
//   - bonjour-service           涉及 multicast-dns 的动态行为，传递依赖较深
// 其他业务依赖已全部 inline 进 bundle，运行时不再需要。
//
// 我们用"白名单顶层目录"的方式精准保留这些包及其运行时传递依赖。
// 注意：prebuild-install 链（detect-libc / napi-build-utils / tar-fs 等）只在
// npm install 阶段使用，运行时不会被 require，因此全部排除。
const BACKEND_KEEP_PACKAGES = [
  // better-sqlite3 + 运行时传递依赖
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  // sqlite-vec + 全平台二进制（让同一份 backend/node_modules 可跨平台打包）
  "sqlite-vec",
  "sqlite-vec-windows-x64",
  "sqlite-vec-darwin-x64",
  "sqlite-vec-darwin-arm64",
  "sqlite-vec-linux-x64",
  "sqlite-vec-linux-arm64",
  // bonjour-service + 运行时传递依赖
  "bonjour-service",
  "multicast-dns",
  "dns-packet",
  "@leichtgewicht",        // 整个 scope (含 ip-codec)
  "thunky",
];

// 生成 electron-builder filter 规则（路径相对 from 目录，即 backend/node_modules 根）
//
// 策略：
//   1. 先用 "!**" 排除一切
//   2. 对白名单包的整棵子树重新加回
//   3. 再去掉每个包里的 docs / tests / *.md / *.ts 等非运行时文件
function buildBackendNodeModulesFilter() {
  const rules = [];
  // 第一步：排除一切
  rules.push("!**/*");
  // 第二步：白名单包的顶层目录整个加回
  for (const pkg of BACKEND_KEEP_PACKAGES) {
    // 对 @scope/xxx 这种路径，electron-builder 的 glob 能正确处理 "@xxx/**"
    rules.push(`${pkg}/**/*`);
  }
  // 第三步：在保留的包里，剔除显然不需要的文件/目录
  rules.push("!**/{test,tests,docs,doc,examples,example,benchmark,benchmarks}/**");
  rules.push("!**/*.{md,markdown,ts,map}");
  // 注意：不能排除 *.d.ts ？其实 d.ts 和 .ts 已被上一条覆盖
  rules.push("!**/CHANGELOG*");
  rules.push("!**/LICENSE*");
  rules.push("!**/{AUTHORS,CONTRIBUTORS,HISTORY}*");
  // better-sqlite3 自带源码（src/ 是 C++ 源码，deps/ 是 sqlite amalgamation；
  // 只要 build/Release/*.node 就够 runtime 跑，src/deps 可以剥掉）
  rules.push("!better-sqlite3/src/**");
  rules.push("!better-sqlite3/deps/**");
  rules.push("!better-sqlite3/docs/**");
  rules.push("!better-sqlite3/benchmark/**");
  return rules;
}

module.exports = {
  appId: "com.nowen.note",
  productName: "Nowen Note",
  // 打包前自动校验原生模块，避免漏跑 rebuild:native 导致安装后崩溃
  beforeBuild() {
    checkNativeModule();
    return true; // 返回 true 表示继续打包
  },
  directories: {
    output: OUT_DIR,
    // 图标、entitlements 等打包资源统一放 build/ 下
    buildResources: "build",
  },
  // 仅打包中英两种语言；默认会有 100+ 种 locale，约占 36MB
  electronLanguages: ["en-US", "zh-CN"],
  // GitHub Releases 作为自动更新 feed
  // 发布时需设置 GH_TOKEN 环境变量；私有仓库需 private: true
  //
  // Channel 策略：
  //   full 版发布走 electron-builder 默认的 "latest" channel（latest.yml），
  //   lite 版在 builder.lite.config.js 显式声明 channel: "lite"（latest-lite.yml）。
  //   两者完整互不影响：
  //     - full 客户端只从 latest*.yml 拉取 → 永远收不到 lite 增量
  //     - lite 客户端只从 latest-lite*.yml 拉取 → 永远收不到 full 增量
  //   这样即便同一 GitHub Release 同时上传了 full + lite 二进制，自动更新
  //   也不会出现"full 安装包被误升级成 lite"的灾难。
  publish: [
    {
      provider: "github",
      owner: "cropflre",
      repo: "nowen-note",
      releaseType: "release",
      // channel 省略 = "latest"（保留 electron-builder 默认行为）
    },
  ],
  files: [
    "electron/**/*",
    "!electron/builder.config.js",
    "!electron/builder.lite.config.js",
    "!electron/node/**/*",
    // package.json 用于 electron-builder 读取 dependencies 并自动收集运行时依赖
    "package.json",
    // node_modules/**/* 已删除：electron-builder 会自动从 package.json 的 dependencies
    // 收集运行时依赖，无需手动指定整个 node_modules 目录
  ],
  // ==== 文件关联：双击 .md / .markdown / .txt 用 Nowen Note 打开 ====
  // 注意：AppImage 构建器不支持 ext 为数组，必须拆成多个独立条目
  fileAssociations: [
    {
      ext: "md",
      name: "Markdown Document",
      description: "Markdown Document",
      role: "Editor",
    },
    {
      ext: "markdown",
      name: "Markdown Document",
      description: "Markdown Document",
      role: "Editor",
    },
    {
      ext: "txt",
      name: "Plain Text Document",
      description: "Plain Text Document",
      role: "Editor",
    },
  ],
  // 不再内嵌 node：后端以 ELECTRON_RUN_AS_NODE 模式跑在 Electron 自身
  // 原生模块（better-sqlite3）通过 `electron-builder install-app-deps` 对齐 ABI
  extraResources: [
    {
      from: "backend/dist",
      to: "backend/dist",
      filter: ["**/*"],
    },
    {
      from: "backend/node_modules",
      to: "backend/node_modules",
      filter: buildBackendNodeModulesFilter(),
    },
    {
      from: "backend/package.json",
      to: "backend/package.json",
    },
    {
      from: "backend/templates",
      to: "backend/templates",
      filter: ["**/*"],
    },
    {
      from: "frontend/dist",
      to: "frontend/dist",
      filter: ["**/*"],
    },
  ],
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
    icon: "electron/icon.png",
    // ==== Windows 代码签名（EV 证书推荐） ====
    // 通过环境变量传入，避免把敏感信息写进仓库：
    //   CSC_LINK        - 证书文件 (base64 或本地路径)
    //   CSC_KEY_PASSWORD- 证书密码
    // CI 未提供证书时 electron-builder 会自动跳过签名。
    //
    // signAndEditExecutable：
    //   默认 true -> 通过 rcedit 修改 exe 图标/版本号，并在有证书时签名
    //   设 NOWEN_SKIP_RCEDIT=1 则跳过（跨平台首次打 Win 不想等 winCodeSign 下载时可用）
    signAndEditExecutable: SIGN_AND_EDIT_EXECUTABLE,
    signDlls: false,
    // 若使用 Azure Code Signing / Cloud HSM，可改用 signingHashAlgorithms + signtoolOptions
    signingHashAlgorithms: ["sha256"],
    verifyUpdateCodeSignature: true,
    publisherName: "Nowen",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Nowen Note",
  },
  portable: {
    artifactName: "${productName}-${version}-portable.${ext}",
  },
  mac: {
    // ==== mac 架构选择 ====
    // 历史教训（2026-05 Intel Mac ERR_DLOPEN_FAILED）：
    //   原配置 arch: ["arm64", "x64"]，electron-builder 一次构建会同时输出
    //   两份 dmg/zip，但 backend/node_modules/better-sqlite3 只能 rebuild 出
    //   一种架构的 .node；另一架构的安装包打开就 dlopen 失败。
    // 修复：每次只打一个架构，由外层脚本 (release.sh) 跑两遍，每次先
    //   `rebuild:native --target-arch=<arch>` 再 electron-builder。
    // 通过环境变量 NOWEN_MAC_ARCH=x64|arm64 控制；默认 x64（覆盖 Intel + 走 Rosetta）。
    target: [
      {
        target: "dmg",
        arch: [process.env.NOWEN_MAC_ARCH === "arm64" ? "arm64" : "x64"],
      },
      {
        target: "zip",
        arch: [process.env.NOWEN_MAC_ARCH === "arm64" ? "arm64" : "x64"],
      },
    ],
    // 两个 mac 架构分两次构建，文件名必须带 ${arch}，否则后一次会覆盖前一次，
    // Release 资产看似有 Intel/Apple Silicon，实际可能指向同一份错架构包。
    artifactName: "${productName}-${version}-${arch}.${ext}",
    icon: "electron/icon.png",
    category: "public.app-category.productivity",
    // ==== macOS 代码签名 + 公证 ====
    // 通过环境变量提供（推荐用 GitHub Actions secrets）：
    //   CSC_LINK / CSC_KEY_PASSWORD               - Developer ID Application 证书
    //   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD    - 公证所需（或用 APPLE_API_KEY）
    //   APPLE_TEAM_ID                             - 团队 ID
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: false, // 交给 afterSign 钩子处理；本地缺少 Apple 凭据时会自动跳过
  },
  // macOS 公证钩子。仅 darwin 生效；本地缺少 Apple 凭据时不会阻断构建。
  afterSign: "build/afterSign.js",
  linux: {
    target: ["AppImage", "deb"],
    icon: "electron/icon.png",
    // FreeDesktop 规范分类：https://specifications.freedesktop.org/menu-spec/latest/apa.html
    // Office 是顶级分类；笔记类一般还加 TextTools / Utility
    category: "Office",
    // Linux mimeType 绑定：系统双击 .md 时会优先提示用 Nowen Note 打开
    mimeTypes: ["text/markdown", "text/plain"],
    // deb 需要 maintainer；AppImage 也会读 vendor 写进 metadata
    // 可通过环境变量 NOWEN_LINUX_MAINTAINER / NOWEN_LINUX_VENDOR / NOWEN_LINUX_HOMEPAGE 覆盖
    maintainer: LINUX_MAINTAINER,
    vendor: LINUX_VENDOR,
    synopsis: "Modern note-taking application",
    description:
      "Nowen Note — 一个现代化的笔记应用，支持 Markdown、全文搜索、跨设备局域网同步。",
    // 桌面文件额外字段
    desktop: {
      entry: {
        StartupWMClass: "Nowen Note",
        Keywords: "note;markdown;editor;nowen;",
      },
    },
    // Linux x64 / arm64 会分两次构建；文件名必须带架构，避免互相覆盖。
    artifactName: "${productName}-${version}-${arch}.${ext}",
  },
  // deb 专属字段（maintainer/description 已在上面 linux 里兜底，这里补 priority / section）
  deb: {
    priority: "optional",
    // section 对应 Debian 软件分类：https://packages.debian.org/sections
    // editors / utils / text 都可；editors 更贴合
    // （注意：deb.category 字段不存在，分类用 fpm 的 section）
  },
  appImage: {
    // AppImage 一般不需要额外配；保留空对象方便以后加
  },
};
