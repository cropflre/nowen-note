/**
 * electron-builder 配置
 * @type {import('electron-builder').Configuration}
 */
const path = require("path");
const os = require("os");

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

module.exports = {
  appId: "com.nowen.note",
  productName: "Nowen Note",
  directories: {
    output: OUT_DIR,
    // 图标、entitlements 等打包资源统一放 build/ 下
    buildResources: "build",
  },
  // GitHub Releases 作为自动更新 feed
  // 发布时需设置 GH_TOKEN 环境变量；私有仓库需 private: true
  publish: [
    {
      provider: "github",
      owner: "cropflre",
      repo: "nowen-note",
      releaseType: "release",
    },
  ],
  files: [
    "electron/**/*",
    "!electron/builder.config.js",
    "!electron/node/**/*",
    // 显式带上根 package.json 声明的生产依赖。
    // electron-builder 默认会自动打包 dependencies 下的包，这里显式写一遍作为兜底
    // 和可读性标注（尤其是 bonjour-service —— Electron 主进程用，必须进 app.asar）。
    "package.json",
    "node_modules/**/*",
  ],
  // ==== 文件关联：双击 .md / .markdown / .txt 用 Nowen Note 打开 ====
  fileAssociations: [
    {
      ext: ["md", "markdown"],
      name: "Markdown Document",
      description: "Markdown Document",
      role: "Editor",
      // mac 用 .icns；Windows 使用安装包内的 exe 图标，这里可留空
      // icon: "build/md.icns",
    },
    {
      ext: ["txt"],
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
      filter: ["**/*"],
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
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] }, // electron-updater 需要 zip 做增量
    ],
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
    notarize: false, // 交给 afterSign 钩子或 CI 单独处理更稳妥；可按需切 true
  },
  // 可选：公证钩子，见下方 afterSign.js
  // afterSign: "build/afterSign.js",
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
