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

function runtimeFilePath() {
  if (!runtimeDir) throw new Error("clipper-host: setRuntimeDir() 必须先调用");
  return path.join(runtimeDir, RUNTIME_FILE);
}

/**
 * 写入运行时连接信息。
 *
 * Backend 端口每次启动都不同（动态取空闲端口），所以必须落盘让
 * Native Host 能找到当前实例。原子写避免读到半截 JSON。
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

module.exports = {
  RUNTIME_FILE,
  setRuntimeDir,
  publishRuntime,
  clearRuntime,
  readRuntime,
  probeBackend,
  waitForBackend,
  buildHostManifest,
  handleHostMessage,
};
