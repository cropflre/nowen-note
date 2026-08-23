import { resolveAttachmentAccessUrl } from "@/lib/noteAttachmentAccessBridge";
import {
  normalizePublicWebOrigin,
  resolvePublicWebOrigin,
} from "@/lib/publicWebOrigin";

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
 *   - 移动端显式配置公开 Web 根地址时，只在“下载出口”把附件签名路径搬到该地址；
 *     图片/视频渲染仍沿用真实 API origin，避免破坏 LAN / Local-first 访问性能。
 *
 * 同源判断只看 origin，不依赖具体协议/端口的硬编码。
 */

/** 检测是否为移动设备 */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * 为一次主动附件下载生成最终 URL。
 *
 * `resolveAttachmentAccessUrl()` 仍负责选择当前会话可达的签名地址；当调用方额外提供
 * `publicOrigin`（来自管理员设置 / PUBLIC_WEB_ORIGIN / 构建配置）时，仅把
 * `/api/attachments/<id>` 之后的 path/query/hash 搬到公开 Web 根地址。
 *
 * 签名不绑定 host，因此不会改变 exp/sig/scope 的有效性；同时从附件路径锚点开始重建，
 * 可避免源 API 与公开地址都带反代前缀时出现 `/prefix/prefix/api/...` 重复。
 */
export function resolveAttachmentDownloadUrl(url: string, publicOrigin = ""): string {
  const resolved = resolveAttachmentAccessUrl(url);

  // 离线附件可能已经是 blob URL；它不经过后端，也不能追加 download 查询参数。
  if (/^(?:blob:|data:)/i.test(resolved)) return resolved;

  const flagged = withDownloadFlag(resolved);
  const normalizedPublicOrigin = normalizePublicWebOrigin(publicOrigin);
  if (!normalizedPublicOrigin) return flagged;

  try {
    const fallback = typeof window !== "undefined" ? window.location.href : "http://localhost/";
    const parsed = new URL(flagged, fallback);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return flagged;

    const attachmentPathIndex = parsed.pathname.indexOf("/api/attachments/");
    if (attachmentPathIndex < 0) return flagged;
    const attachmentPath = parsed.pathname.slice(attachmentPathIndex);
    return `${normalizedPublicOrigin}${attachmentPath}${parsed.search}${parsed.hash}`;
  } catch {
    return flagged;
  }
}

export async function downloadAttachment(url: string, filename: string): Promise<void> {
  if (!url) throw new Error("缺少下载链接");

  const mobile = isMobileDevice();
  // 只使用“显式配置”的公开地址：把 currentOrigin 置空可阻止 resolvePublicWebOrigin
  // 回退到当前页面 origin。这样未配置 PUBLIC_WEB_ORIGIN 的局域网用户保持原行为。
  const configuredPublicOrigin = mobile
    ? resolvePublicWebOrigin({ currentOrigin: "" }).origin
    : "";

  // 关键：附加 ?download=1。后端 attachments 路由对图片默认走 inline（无 Content-Disposition），
  // 这会让浏览器复用预览缓存的响应，<a download> 在同源下也可能被绕过去预览，造成
  // "点了一下没反应、第二次才下载"的现象。带上 ?download=1 后服务器始终回 attachment，
  // 浏览器一次性、稳定地走下载流。
  const downloadUrl = resolveAttachmentDownloadUrl(url, configuredPublicOrigin);

  // 移动端统一走 fetch+blob：<a download> 在 iOS Safari 上基本不生效，
  // 直接导航到 URL 会打开预览而非下载。fetch+blob + objectURL 是移动端最可靠的方案。
  if (!mobile && isSameOrigin(downloadUrl)) {
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
