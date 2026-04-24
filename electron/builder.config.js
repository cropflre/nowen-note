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
      owner: "nowen",
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
    signAndEditExecutable: true,
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
    category: "Office",
    // Linux mimeType 绑定：系统双击 .md 时会优先提示用 Nowen Note 打开
    mimeTypes: ["text/markdown", "text/plain"],
  },
};
