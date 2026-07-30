/**
 * Stable release wrapper around the full desktop builder configuration.
 *
 * Keep the large platform/ABI configuration in builder.base.config.js while
 * Build scripts validate generated updater metadata after electron-builder exits.
 */
const base = require("./builder.base.config.js");

module.exports = {
  ...base,
  files: [
    ...(Array.isArray(base.files) ? base.files : []),
    "!electron/builder.base.config.js",
    "!electron/builder.lite.base.config.js",
  ],
  nsis: {
    ...(base.nsis || {}),
    artifactName: "Nowen-Note-${version}-setup.${ext}",
  },
  portable: {
    ...(base.portable || {}),
    artifactName: "Nowen-Note-${version}-portable.${ext}",
    // Portable EXE 必须先解压整个应用再启动 Electron。ZIP 解压明显快于默认 LZMA，
    // 以少量体积增长换取 Windows 端更短的双击等待时间。
    useZip: true,
    // NSIS 在 Electron 进程启动前显示该图，避免大型 portable 包解压时毫无反馈。
    splashImage: "build/portable-splash.bmp",
  },
  mac: {
    ...(base.mac || {}),
    artifactName: "Nowen-Note-${version}-${arch}.${ext}",
  },
  linux: {
    ...(base.linux || {}),
    artifactName: "Nowen-Note-${version}-${arch}.${ext}",
  },
};
