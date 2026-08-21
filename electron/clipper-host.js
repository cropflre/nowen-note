// electron/clipper-host.js
//
// Clipper Native Messaging 主机（Phase 8）。
//
// 解决的问题：用户点「保存到 Nowen」时，Desktop 可能没在运行。
// 浏览器扩展无法自己启动本机程序，也不该看到
// "Connection refused 127.0.0.1:xxxxx" 这种技术错误。
//
// 分工：
//   Native Messaging  负责发现 / 启动 / 唤醒 Desktop、配对、交换连接信息
//   localhost HTTP    负责真正的网页内容传输（HTML / Markdown / 图片 / 截图 / 附件）
//
// 不用 Native Messaging 传网页内容的原因：它有严格的消息体积上限
// （Chrome 单条 1MB），带图片的剪藏很容易超限；而且二进制要额外编码，
// 白白多一层开销。它只适合传"去哪里连"这类小信息。
//
// 安全：
//   - 只在 127.0.0.1 / ::1 上监听（Embedded Backend 自身也如此）；
//   - 交给扩展的是独立 Clipper 凭据，不是桌面端管理员 JWT；
//   - 凭据签发必须由用户在 Desktop 里确认，不能被网页静默触发。

const fs = require("fs");
const path = require("path");
const http = require("http");

/** 运行时连接信息文件：Native Host 读它来告诉扩展"往哪连"。 */
const RUNTIME_FILE = "clipper-runtime.json";

let runtimeDir = "";
let currentPort = 0;

function setRuntimeDir(dir) {
  runtimeDir = dir;
}

/**
 * 推断 Desktop 的数据目录（供独立 Native Host 进程使用）。
 *
 * 主进程能直接调 app.getPath("userData")，但 Native Host 是浏览器拉起的
 * 普通 Node 进程，拿不到 electron API，只能按平台约定重建路径。
 *
 * 必须与 Electron 的 userData 规则保持一致，否则 Host 读不到运行时文件，
 * 表现为"Desktop 明明开着却提示未运行"。
 */
function resolveDefaultRuntimeDir() {
  const appName = "nowen-note";
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return "";
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(base, appName, "nowen-data");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", appName, "nowen-data");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, appName, "nowen-data");
}

function runtimeFilePath() {
  if (!runtimeDir) throw new Error("clipper-host: setRuntimeDir() 必须先调用");
  return path.join(runtimeDir, RUNTIME_FILE);
}

/**
 * 写入运行时连接信息。
 *
 * Backend 优先使用固定端口，但冲突时会动态回退，所以必须落盘让
 * Native Host 找到当前实例的实际端口。原子写避免读到半截 JSON。
 */
function publishRuntime({ port, token }) {
  currentPort = port;
  const file = runtimeFilePath();
  const payload = {
    port,
    // 凭据只在用户已完成配对时才有值；未配对时为空，扩展会走配对流程。
    token: token || "",
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    // 0600：这个文件里有 Clipper 凭据，不能让同机其他用户读到。
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn("[clipper-host] publish runtime failed:", e?.message || e);
  }
}

/** Desktop 退出时清理，避免扩展连到已死的端口后长时间等待。 */
function clearRuntime() {
  try {
    fs.rmSync(runtimeFilePath(), { force: true });
  } catch {
    /* ignore */
  }
  currentPort = 0;
}

function readRuntime() {
  try {
    const raw = fs.readFileSync(runtimeFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.port === "number" && parsed.port > 0) return parsed;
  } catch {
    /* 文件不存在或损坏都视为"未运行" */
  }
  return null;
}

/**
 * 探测 Backend 是否真的就绪。
 *
 * 只看 runtime 文件不够：Desktop 可能被强杀而文件残留，
 * 此时扩展仍会拿到一个已失效的端口。
 */
function probeBackend(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 等待 Backend 就绪。
 *
 * 用于"Desktop 未运行 → 启动 → 等待可用"这条链路：
 * 启动过程可能要几秒，期间扩展应显示"正在打开 Nowen"，
 * 而不是立刻报连接失败。
 */
async function waitForBackend(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeBackend(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * 生成 Native Messaging 主机清单。
 *
 * 各浏览器读取位置不同（Chrome/Edge 在 NativeMessagingHosts 目录，
 * Firefox 用 native-messaging-hosts），因此只负责产出清单内容，
 * 具体安装位置交由安装器决定。
 */
function buildHostManifest({ hostName, executablePath, allowedExtensionIds = [], firefox = false }) {
  const manifest = {
    name: hostName,
    description: "Nowen Note Clipper Native Host",
    path: executablePath,
    type: "stdio",
  };
  if (firefox) {
    manifest.allowed_extensions = allowedExtensionIds;
  } else {
    manifest.allowed_origins = allowedExtensionIds.map((id) => `chrome-extension://${id}/`);
  }
  return manifest;
}

/**
 * 处理来自扩展的 Native Messaging 请求。
 *
 * 只支持三种消息，且都不涉及网页内容：
 *   discover  —— Desktop 是否在运行、连接信息是什么
 *   launch    —— 启动 Desktop 并等待就绪
 *   pair      —— 引导用户在 Desktop 内确认并签发凭据
 *
 * launchDesktop 由调用方注入（Electron 主进程知道自己的可执行路径），
 * 这样本模块可以在没有 Electron 的环境里被单独测试。
 */
async function handleHostMessage(message, deps = {}) {
  const { launchDesktop, requestPairing } = deps;
  const type = message && typeof message.type === "string" ? message.type : "";

  if (type === "discover") {
    const runtime = readRuntime();
    if (!runtime) return { ok: true, running: false };
    const alive = await probeBackend(runtime.port);
    if (!alive) {
      // 残留文件：明确回报未运行，让扩展走 launch 流程。
      return { ok: true, running: false, stale: true };
    }
    return {
      ok: true,
      running: true,
      port: runtime.port,
      // 未配对时 token 为空，扩展据此决定是否需要 pair。
      paired: !!runtime.token,
      token: runtime.token || "",
    };
  }

  if (type === "launch") {
    const existing = readRuntime();
    if (existing && await probeBackend(existing.port)) {
      return { ok: true, running: true, port: existing.port, token: existing.token || "" };
    }
    if (typeof launchDesktop !== "function") {
      return { ok: false, error: "LAUNCH_UNSUPPORTED" };
    }
    try {
      // --clipper-background：以后台模式启动，不抢用户当前窗口焦点。
      await launchDesktop(["--clipper-background"]);
    } catch (e) {
      return { ok: false, error: "LAUNCH_FAILED", detail: e?.message || String(e) };
    }
    // 启动后需要重新读文件：端口是新进程写入的。
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const runtime = readRuntime();
      if (runtime && await probeBackend(runtime.port)) {
        return { ok: true, running: true, port: runtime.port, token: runtime.token || "" };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return { ok: false, error: "LAUNCH_TIMEOUT" };
  }

  if (type === "pair") {
    if (typeof requestPairing !== "function") {
      return { ok: false, error: "PAIR_UNSUPPORTED" };
    }
    try {
      // 必须由用户在 Desktop 里确认；不能被网页或扩展静默触发。
      const result = await requestPairing();
      if (!result || !result.token) return { ok: false, error: "PAIR_DECLINED" };
      return { ok: true, port: currentPort || readRuntime()?.port || 0, token: result.token };
    } catch (e) {
      return { ok: false, error: "PAIR_FAILED", detail: e?.message || String(e) };
    }
  }

  return { ok: false, error: "UNKNOWN_MESSAGE" };
}

/** Native Messaging 宿主名称：清单文件名与扩展里的调用名必须一致。 */
const HOST_NAME = "cn.nowen.note.clipper";

/**
 * 各浏览器读取 Native Messaging 清单的目录。
 *
 * 位置由浏览器规定，不能自选。用户级目录（非系统级）不需要管理员权限，
 * 因此安装包免提权即可完成注册。
 */
function nativeHostDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return [];

  if (process.platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    return [
      { dir: path.join(support, "Google", "Chrome", "NativeMessagingHosts"), firefox: false },
      { dir: path.join(support, "Microsoft Edge", "NativeMessagingHosts"), firefox: false },
      { dir: path.join(support, "Chromium", "NativeMessagingHosts"), firefox: false },
      { dir: path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts"), firefox: true },
    ];
  }

  if (process.platform === "win32") {
    // Windows 上清单位置由注册表指定，不是固定目录。
    // 这里给出清单落盘位置，注册表写入由 registerWindowsHost 处理。
    const base = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [{ dir: path.join(base, "NowenNote", "NativeMessagingHosts"), firefox: false }];
  }

  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    { dir: path.join(config, "google-chrome", "NativeMessagingHosts"), firefox: false },
    { dir: path.join(config, "microsoft-edge", "NativeMessagingHosts"), firefox: false },
    { dir: path.join(config, "chromium", "NativeMessagingHosts"), firefox: false },
    { dir: path.join(home, ".mozilla", "native-messaging-hosts"), firefox: true },
  ];
}

/**
 * 安装 Native Messaging 清单。
 *
 * 幂等：每次启动都可以调，内容一致则等于无操作。必须每次调用而不是
 * 只在安装时调一次 —— 应用升级后可执行路径可能变化（尤其是便携版
 * 与 AppImage），清单里的旧路径会让浏览器拉起一个不存在的程序。
 *
 * 失败不抛：浏览器没装、目录无权限都属正常情况，
 * 剪藏功能会退化为"需要先手动打开 Desktop"，而不是整个应用起不来。
 */
function installHostManifests({ executablePath, allowedExtensionIds = [], hostName = HOST_NAME }) {
  const installed = [];
  const failed = [];

  for (const target of nativeHostDirs()) {
    try {
      // 只装到浏览器已经存在的配置目录里（其父目录存在即视为已安装）。
      // 无脑创建会在用户机器上留下一堆没用的空目录。
      const parent = path.dirname(target.dir);
      if (!fs.existsSync(parent) && process.platform !== "win32") continue;

      fs.mkdirSync(target.dir, { recursive: true });
      const manifest = buildHostManifest({
        hostName,
        executablePath,
        allowedExtensionIds,
        firefox: target.firefox,
      });
      const file = path.join(target.dir, `${hostName}.json`);
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
      installed.push(file);
    } catch (error) {
      failed.push({ dir: target.dir, error: error?.message || String(error) });
    }
  }

  return { installed, failed };
}

/**
 * Windows 注册表注册。
 *
 * Windows 上浏览器不扫目录，而是读注册表键
 * HKCU\Software\<Vendor>\<Browser>\NativeMessagingHosts\<HostName>
 * 其默认值指向清单文件的绝对路径。
 *
 * 用 HKCU 而非 HKLM：不需要管理员权限，卸载时也只影响当前用户。
 */
function registerWindowsHost({ manifestPath, hostName = HOST_NAME, execFileSync }) {
  if (process.platform !== "win32") return { registered: [], failed: [] };

  const runner = execFileSync || require("child_process").execFileSync;
  const keys = [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${hostName}`,
  ];
  const registered = [];
  const failed = [];

  for (const key of keys) {
    try {
      runner("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      registered.push(key);
    } catch (error) {
      // 该浏览器未安装时 reg add 仍会成功（只是建了个没人读的键），
      // 因此这里失败通常意味着策略限制，记录即可。
      failed.push({ key, error: error?.message || String(error) });
    }
  }

  return { registered, failed };
}

/**
 * 一站式注册：写清单 + Windows 注册表。
 *
 * 由主进程在启动时调用。整体 try/catch 包裹，任何失败都只降级剪藏能力。
 */
function ensureNativeHostRegistered({ executablePath, allowedExtensionIds = [] }) {
  const result = installHostManifests({ executablePath, allowedExtensionIds });
  let registry = { registered: [], failed: [] };
  if (process.platform === "win32" && result.installed.length > 0) {
    registry = registerWindowsHost({ manifestPath: result.installed[0] });
  }
  return { ...result, registry };
}

/**
 * 生成 Native Messaging 宿主启动器。
 *
 * 为什么需要它：清单里的 path 必须是**可直接执行的文件**，
 * 而 `.js` 不是。同时宿主脚本需要一个 Node 运行时 ——
 * 不能假设用户机器装了 Node。
 *
 * 解法：用 Electron 自带的可执行文件配合 ELECTRON_RUN_AS_NODE=1
 * （让它退化为纯 Node，不创建窗口），由启动器脚本负责设置环境变量。
 *
 * 启动器还顺便注入 NOWEN_DESKTOP_EXECUTABLE，
 * 让宿主在 Desktop 未运行时知道该拉起哪个程序。
 *
 * 每次启动重写：应用升级或移动目录后路径会变，
 * 旧启动器会指向不存在的可执行文件。
 */
function ensureHostLauncher({ dir, hostScript, nodeExecutable, runAsNode = true, desktopExecutable }) {
  if (!dir) throw new Error("clipper-host: ensureHostLauncher 需要 dir");
  fs.mkdirSync(dir, { recursive: true });

  const desktop = desktopExecutable || nodeExecutable;
  const isWin = process.platform === "win32";
  const file = path.join(dir, isWin ? "nowen-clipper-host.cmd" : "nowen-clipper-host.sh");

  const body = isWin
    ? [
      "@echo off",
      // 关掉命令回显与变量延迟展开，避免路径里的特殊字符被吞。
      "setlocal",
      runAsNode ? "set ELECTRON_RUN_AS_NODE=1" : "",
      `set "NOWEN_DESKTOP_EXECUTABLE=${desktop}"`,
      // %* 透传浏览器附加的参数（清单调用时会带上扩展来源）。
      `"${nodeExecutable}" "${hostScript}" %*`,
      "",
    ].filter(Boolean).join("\r\n")
    : [
      "#!/bin/sh",
      runAsNode ? "export ELECTRON_RUN_AS_NODE=1" : "",
      `export NOWEN_DESKTOP_EXECUTABLE="${desktop}"`,
      `exec "${nodeExecutable}" "${hostScript}" "$@"`,
      "",
    ].filter(Boolean).join("\n");

  fs.writeFileSync(file, body, "utf8");
  if (!isWin) {
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      // 权限设置失败时清单仍会写入，但浏览器无法执行；
      // 这属于降级而非致命错误。
    }
  }
  return file;
}

module.exports = {
  RUNTIME_FILE,
  HOST_NAME,
  setRuntimeDir,
  resolveDefaultRuntimeDir,
  publishRuntime,
  clearRuntime,
  readRuntime,
  probeBackend,
  waitForBackend,
  buildHostManifest,
  handleHostMessage,
  nativeHostDirs,
  installHostManifests,
  registerWindowsHost,
  ensureHostLauncher,
  ensureNativeHostRegistered,
};
