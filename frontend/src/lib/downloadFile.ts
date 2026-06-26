/**
 * downloadFile —— 通用附件下载工具
 * ---------------------------------------------------------------------------
 * 解决"第一次点击不下载、第二次才下载"的问题。
 *
 * 根因：以前所有场景都走 fetch → blob → a.click()，但 fetch 是异步的；
 * 等 fetch 完成后再 click() 时，浏览器的"用户手势"上下文已经超时，
 * 第一次点击会被静默拦截；第二次点击因为命中缓存 fetch 几乎瞬时，才能下载。
 *
 * 修复策略：
 *   - 同源：走原生 <a download>，同步触发，永远不丢失用户手势。
 *   - 跨源（桌面客户端连远端服务器场景）：仍然走 fetch+blob，
 *     因为跨源下 <a download> 的 filename 属性会被忽略，体验更糟。
 *   - 移动端降级：iOS Safari 等对 <a download> 支持差，
 *     同源也走 fetch+blob 保证 filename 生效。
 *
 * 同源判断只看 origin，不依赖具体协议/端口的硬编码。
 */

/** 检测是否为移动设备 */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function downloadAttachment(url: string, filename: string): Promise<void> {
  if (!url) throw new Error("缺少下载链接");

  // 关键：附加 ?download=1。后端 attachments 路由对图片默认走 inline（无 Content-Disposition），
  // 这会让浏览器复用预览缓存的响应，<a download> 在同源下也可能被绕过去预览，造成
  // "点了一下没反应、第二次才下载"的现象。带上 ?download=1 后服务器始终回 attachment，
  // 浏览器一次性、稳定地走下载流。
  const downloadUrl = withDownloadFlag(url);

  // 移动端统一走 fetch+blob：<a download> 在 iOS Safari 上基本不生效，
  // 直接导航到 URL 会打开预览而非下载。fetch+blob + objectURL 是移动端最可靠的方案。
  if (!isMobileDevice() && isSameOrigin(downloadUrl)) {
    // 桌面同源——原生 <a download>，同步触发，零手势丢失风险
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = filename || "";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }

  // 移动端 或 跨源——fetch 成 blob 再触发，保留 download 属性
  const res = await fetch(downloadUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename || "";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 下一帧再 revoke，避免部分浏览器还没启动下载就被回收
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
  }
}

// 给 URL 追加 download=1 query。已有就保留，不重复追加。
// 用纯字符串处理避免 new URL 在相对路径下抛错的边界情况。
function withDownloadFlag(url: string): string {
  // 已经带 download=1 了，直接返回
  if (/[?&]download=1(?:&|$|#)/.test(url)) return url;
  // 区分 hash
  const hashIdx = url.indexOf("#");
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}download=1${hash}`;
}

// 内部判断同源——只看 origin，不依赖具体协议/端口的硬编码
function isSameOrigin(url: string): boolean {
  try {
    // 相对路径必然同源
    if (url.startsWith("/") && !url.startsWith("//")) return true;
    const u = new URL(url, window.location.href);
    return u.origin === window.location.origin;
  } catch {
    // 解析失败按跨源处理（更保守）
    return false;
  }
}
