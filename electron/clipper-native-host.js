#!/usr/bin/env node
/**
 * Clipper Native Messaging 宿主入口。
 *
 * 这是**独立进程**，由浏览器按清单里的 path 拉起，不是 Electron 主进程。
 * 因此它不能 require electron —— 运行时只有普通 Node（或打包后的
 * Node 单文件），任何 electron API 调用都会直接崩。
 *
 * 协议（Chrome / Firefox 通用）：
 *   stdin/stdout 上传输 [4 字节小端长度][UTF-8 JSON]
 *   每条消息独立，请求与响应一一对应。
 *
 * 职责边界（第三十五条）：
 * - 这里只处理 discover / launch / pair —— 都是小消息；
 * - 网页正文、图片、附件**不走这条通道**，Chrome 单条消息上限 1MB，
 *   带图剪藏必然超限。内容一律走 127.0.0.1 HTTP。
 *
 * 安全：
 * - 不接受任何"直接写数据库"或"返回管理员令牌"的消息；
 * - 配对必须由用户在 Desktop 窗口内确认，扩展无法静默取得凭据。
 */

const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  setRuntimeDir,
  handleHostMessage,
  resolveDefaultRuntimeDir,
} = require("./clipper-host");

// ---------------------------------------------------------------------------
// Native Messaging 帧编解码
// ---------------------------------------------------------------------------

function writeMessage(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

/**
 * 逐帧读取 stdin。
 *
 * 必须自己做缓冲：stdin 的 chunk 边界与消息边界无关，
 * 一个 chunk 可能含半条消息，也可能含两条。
 */
function createFrameReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      // 防御异常长度：正常控制消息都很小，超过 1MB 说明帧同步已错乱，
      // 继续解析只会读出垃圾，不如直接退出让浏览器重连。
      if (length > 1024 * 1024) {
        process.exit(1);
      }
      if (buffer.length < 4 + length) return;
      const json = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      let message = null;
      try {
        message = JSON.parse(json);
      } catch {
        writeMessage({ ok: false, error: "INVALID_JSON" });
        continue;
      }
      onMessage(message);
    }
  };
}

// ---------------------------------------------------------------------------
// 启动 Desktop
// ---------------------------------------------------------------------------

/**
 * 拉起 Nowen Desktop。
 *
 * 可执行路径由环境变量或清单同目录推断：宿主脚本与主程序一起分发，
 * 因此相对位置是已知的。detached + unref 是必须的 ——
 * 否则浏览器关闭这个 host 进程时会把 Desktop 一起带走。
 */
function launchDesktop(args = []) {
  const exe = process.env.NOWEN_DESKTOP_EXECUTABLE
    || process.env.NOWEN_DESKTOP_PATH
    || "";
  if (!exe) {
    return Promise.reject(new Error("NOWEN_DESKTOP_EXECUTABLE not configured"));
  }
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(exe, args, {
        detached: true,
        stdio: "ignore",
        cwd: path.dirname(exe),
      });
      child.unref();
      resolve(true);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 配对。
 *
 * 宿主进程本身**无法**弹出确认界面（它没有窗口）。
 * 因此这里只负责唤起 Desktop 并让它进入配对界面，
 * 真正的凭据签发由 Desktop 完成后写入 runtime 文件，
 * 扩展随后再 discover 一次即可拿到。
 *
 * 这样设计保证了：凭据永远由用户在 Desktop 里确认，
 * 扩展或网页无法绕过 UI 静默取得。
 */
async function requestPairing() {
  await launchDesktop(["--clipper-pair"]);
  return { token: "" };
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

function main() {
  try {
    const dir = process.env.NOWEN_USER_DATA || resolveDefaultRuntimeDir();
    if (dir) setRuntimeDir(dir);
  } catch {
    // 目录解析失败时仍然继续：discover 会回报未运行，
    // 扩展会走 Pending Queue 暂存，用户的剪藏不会丢。
  }

  const read = createFrameReader((message) => {
    handleHostMessage(message, { launchDesktop, requestPairing })
      .then((response) => writeMessage(response))
      .catch((error) => writeMessage({
        ok: false,
        error: "HOST_ERROR",
        detail: error?.message || String(error),
      }));
  });

  process.stdin.on("data", read);
  process.stdin.on("end", () => process.exit(0));
  // 浏览器关闭通道时 stdout 会 EPIPE，静默退出即可，不要打印堆栈：
  // Native Messaging 通道里任何非协议输出都会破坏帧同步。
  process.stdout.on("error", () => process.exit(0));
}

if (require.main === module) {
  main();
}

module.exports = { createFrameReader, launchDesktop };
