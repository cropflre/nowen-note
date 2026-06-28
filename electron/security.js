/**
 * Electron 安全工具函数
 * ---------------------------------------------------------------------------
 * SEC-ELECTRON-01-B: 统一 IPC 来源校验和外部 URL 安全检查。
 *
 * 独立模块，避免 main.js ↔ credentials.js 循环依赖。
 */

/**
 * 验证外部 URL 协议是否允许通过 shell.openExternal 打开。
 * 只允许 http/https/mailto，禁止 file/javascript/data/vbscript 等危险协议。
 */
function isAllowedExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * 判断 event.senderFrame 是否来自主窗口的可信 renderer。
 * 允许：file:// 本地 frontend/dist、开发环境 localhost
 */
function isTrustedMainWindowSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame) return false;
    const url = frame.url || "";
    if (url.startsWith("file://")) return true;
    if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 判断 event.senderFrame 是否来自 setupWindow 的 data: 页面。
 */
function isTrustedSetupWindowSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame) return false;
    const url = frame.url || "";
    return url.startsWith("data:");
  } catch {
    return false;
  }
}

/**
 * 统一 IPC 来源校验：只允许主窗口调用。
 * 返回 null 表示校验通过，返回错误对象表示拒绝。
 */
function assertMainWindowSender(event) {
  if (!isTrustedMainWindowSender(event)) {
    console.warn("[security] blocked IPC from untrusted sender:", event.senderFrame?.url || "unknown");
    return { ok: false, error: "UNTRUSTED_SENDER" };
  }
  return null;
}

/**
 * 判断主窗口导航是否允许。
 *
 * 安全策略：
 *   - 只允许同源 http/https 导航和 hash 路由变化
 *   - 拒绝 data: / javascript: / vbscript: / chrome: / devtools: / mailto: / about: 等
 *   - file:// 不泛允许，避免任意本地文件进入主窗口
 *   - origin 为 "null" 的 URL 不因 origin 相同被误放行
 */
function isAllowedMainWindowNavigation(targetUrl, currentUrl) {
  try {
    const target = new URL(targetUrl);
    const current = new URL(currentUrl);

    // http/https 协议：只允许同源导航
    if (target.protocol === "http:" || target.protocol === "https:") {
      return target.origin === current.origin;
    }

    // file:// 协议：不泛允许，避免任意本地文件进入主窗口
    // 生产环境主窗口通过 loadFile 加载本地文件，但不允许跨文件导航
    if (target.protocol === "file:") {
      return false;
    }

    // hash 路由变化：允许（同源页面内的 hash 变化）
    // 注意：URL 解析后 hash 变化不会改变 origin，上面的 http/https 同源判断已覆盖

    // 以下协议一律拒绝，不允许加载进主窗口
    // data: / javascript: / vbscript: / chrome: / devtools: / mailto: / about:
    return false;
  } catch {
    // URL 解析失败拒绝
    return false;
  }
}

module.exports = {
  isAllowedExternalUrl,
  isAllowedMainWindowNavigation,
  isTrustedMainWindowSender,
  isTrustedSetupWindowSender,
  assertMainWindowSender,
};
