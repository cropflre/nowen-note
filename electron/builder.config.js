/**
 * Stable release wrapper around the full desktop builder configuration.
 *
 * Keep the large platform/ABI configuration in builder.base.config.js while
 * Build scripts validate generated updater metadata after electron-builder exits.
 */
const path = require("path");
const base = require("./builder.base.config.js");
const {
  assertLinuxNativeBinaryCompatible,
  formatCompatibilityReport,
} = require("../scripts/lib/linux-native-compat.cjs");

function resolveTargetPlatform(context) {
  if (context?.electronPlatformName) return context.electronPlatformName;
  const argv = process.argv.join(" ");
  if (/\s--linux(?:\s|=|$)/.test(argv)) return "linux";
  if (/\s--win(?:\s|=|$)/.test(argv)) return "win32";
  if (/\s--mac(?:\s|=|$)/.test(argv)) return "darwin";
  return process.platform;
}

async function beforeBuild(context) {
  const result = typeof base.beforeBuild === "function"
    ? await base.beforeBuild(context)
    : true;

  if (resolveTargetPlatform(context) !== "linux") return result;

  const targetArch = process.env.npm_config_target_arch || process.env.TARGET_ARCH || process.arch;
  const nodeFile = path.resolve(
    __dirname,
    "..",
    "backend",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  const report = assertLinuxNativeBinaryCompatible(nodeFile, {
    expectedArch: targetArch,
  });
  console.log(formatCompatibilityReport(report));
  return result;
}

module.exports = {
  ...base,
  beforeBuild,
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
