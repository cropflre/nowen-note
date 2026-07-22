/**
 * electron-builder 配置 —— **Lite 发行版**（无内置 backend）。
 *
 * 适用场景：只想连接远端/局域网 Nowen 服务器的用户，不需要本机自带 SQLite 后端。
 * 相较 full 版：
 *   - 不打包 backend/dist + backend/node_modules + 不校验 better-sqlite3 的原生 ABI
 *   - 安装体积大幅缩小（~70MB → ~25MB 量级，实际以产物为准）
 *   - 启动时直接打开"选择服务器"流程，没有 full 模式可切
 *
 * 与 full 的共存策略：
 *   - appId 加 ".lite" 后缀：安装路径、注册表 key、autoUpdate feed 互不干扰
 *   - productName 加 " Lite"：用户在开始菜单/启动台/Dock 能区分两个版本
 *   - 产物文件名加 "-lite" 后缀：便于分发与识别
 *
 * 运行时识别 lite 的两种冗余手段：
 *   1) extraMetadata 把 nowenLiteOnly=true 注入 app.asar 内的 package.json
 *   2) 主进程 isLiteOnlyBuild() 另行判定 `backend/dist/index.js` 是否存在（更可靠）
 *   任一命中即认为是 lite-only 包。
 *
 * @type {import('electron-builder').Configuration}
 */
const path = require("path");
const os = require("os");

// full 配置里的环境变量 / 路径策略保持一致（产物可外迁到 %TEMP%，避免 IDE 监听锁）
const OUT_DIR = process.env.NOWEN_BUILD_OUT
  ? path.join(os.tmpdir(), "nowen-note-lite-build")
  : "dist-electron-lite";

// rcedit 跳过开关（与 full 同）
const SKIP_RCEDIT = process.env.NOWEN_SKIP_RCEDIT === "1";
const SIGN_AND_EDIT_EXECUTABLE = !SKIP_RCEDIT;

// Linux 元信息（与 full 同；仅 synopsis/description 变更以区分 lite）
const LINUX_MAINTAINER =
  process.env.NOWEN_LINUX_MAINTAINER || "Nowen <noreply@nowen.local>";
const LINUX_VENDOR = process.env.NOWEN_LINUX_VENDOR || "Nowen";

module.exports = {
  // appId 加 .lite 后缀 —— 关键：避免与 full 安装包互覆盖、autoUpdate 串 feed
  appId: "com.nowen.note.lite",
  productName: "Nowen Note Lite",

  /**
   * 没有 backend 就不跑 better-sqlite3 的 ABI 校验。留一个 beforeBuild 只做前端产物存在性检查。
   */
  beforeBuild() {
    const fs = require("fs");
    const feDist = path.resolve(__dirname, "..", "frontend", "dist", "index.html");
    if (!fs.existsSync(feDist)) {
      throw new Error(
        `[builder.lite] frontend/dist/index.html 不存在：${feDist}\n` +
          `请先运行 npm run build:frontend（或通过 scripts/build-lite.mjs 统一触发）`,
      );
    }
    return true;
  },

  directories: {
    output: OUT_DIR,
    buildResources: "build",
  },

  // 继续只打中英两种语言，控制体积
  electronLanguages: ["en-US", "zh-CN"],

  /**
   * 把 `nowenLiteOnly: true` 合并进 app.asar 内的 package.json。
   * 除此之外 electron-builder 还会顺带把版本号等元信息同步 —— 这里只补一个自定义字段，
   * 不覆盖 name/version/main 等关键字段。
   */
  extraMetadata: {
    nowenLiteOnly: true,
  },

  /**
   * Lite 版使用独立的 GitHub Release 通道（避免 full 的 latest.yml 覆盖 lite，反之亦然）。
   * 约定：lite 走同一仓库但 channel="lite"，full 默认 channel="latest"。
   * 若后续走不同仓库，只需改这里的 owner/repo。
   */
  publish: [
    {
      provider: "github",
      owner: "cropflre",
      repo: "nowen-note",
      releaseType: "release",
      channel: "lite",
    },
  ],

  /**
   * files：仅包含 electron 主进程代码 + 根 package.json + renderer node_modules。
   * 显式排除 electron/node/**（fetch-node 产物）与 backend 资源（在 extraResources 里也不加）。
   */
  files: [
    "electron/**/*",
    "!electron/builder.config.js",
    "!electron/builder.lite.config.js",
    "!electron/node/**/*",
    "package.json",
    "node_modules/**/*",
  ],

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

  /**
   * Lite 仅带前端产物。**不带 backend/dist、不带 backend/node_modules**。
   * 主进程的 isLiteOnlyBuild() 会因为找不到 resources/backend/dist/index.js
   * 而返回 true，从而：
   *   - 强制 mode=lite
   *   - 首启弹 setup 窗口
   *   - 菜单/托盘隐藏"切换到本地模式"
   */
  extraResources: [
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
    signAndEditExecutable: SIGN_AND_EDIT_EXECUTABLE,
    signDlls: false,
    signingHashAlgorithms: ["sha256"],
    verifyUpdateCodeSignature: true,
    publisherName: "Nowen",
    // 产物名加 -lite 后缀，便于跟 full 分发包并排
    artifactName: "${productName}-${version}-lite-setup.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Nowen Note Lite",
    // 关键：独立安装目录，避免与 full 的 "Nowen Note" 相互覆盖
    // 默认 %LOCALAPPDATA%\Programs\Nowen Note Lite
  },
  portable: {
    artifactName: "${productName}-${version}-lite-portable.${ext}",
  },

  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    icon: "electron/icon.png",
    category: "public.app-category.productivity",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: false,
    // bundleId 实际上由顶层 appId 决定，这里冗余不写
  },
  dmg: {
    artifactName: "${productName}-${version}-lite.${ext}",
  },

  linux: {
    target: ["AppImage", "deb"],
    icon: "electron/icon.png",
    category: "Office",
    mimeTypes: ["text/markdown", "text/plain"],
    maintainer: LINUX_MAINTAINER,
    vendor: LINUX_VENDOR,
    synopsis: "Nowen Note (Lite) — remote-only client",
    description:
      "Nowen Note Lite — 仅包含前端客户端的轻量发行版，需连接远端 Nowen Note 服务器；安装体积更小，启动更快。",
    desktop: {
      entry: {
        StartupWMClass: "Nowen Note Lite",
        Keywords: "note;markdown;editor;nowen;lite;",
      },
    },
    artifactName: "${productName}-${version}-lite.${ext}",
  },
  deb: {
    priority: "optional",
  },
  appImage: {
    artifactName: "${productName}-${version}-lite.${ext}",
  },
};
