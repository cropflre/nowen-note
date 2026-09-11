import { stabilizeClipboardAttachmentLinks } from "@/lib/fileShareClipboard";

/**
 * 统一的剪贴板复制工具
 * ---------------------------------------------------------------------------
 * 为什么单独抽：
 *   项目里 8+ 处直接调 `navigator.clipboard.writeText`，存在三类隐患：
 *     1. 非 https / 非 secure context（部分自部署 http 场景、Capacitor WebView）
 *        下 `navigator.clipboard` 是 undefined，原始调用会直接抛异常。
 *     2. 老 iOS Safari / 老 Edge 不支持异步剪贴板 API。
 *     3. 附件渲染层会把稳定 `/api/attachments/:id` 换成带 exp/sig/scope 的临时
 *        访问 URL；如果复制入口直接拿运行时 URL，会把 12h 后必然失效的地址当
 *        “外链分享”发出去。
 *
 *   这里统一处理：
 *     - 复制前把 user-scope 临时附件 URL 升级为稳定 file-share capability；
 *     - 优先 navigator.clipboard.writeText；
 *     - 失败 / 不可用时降级到 textarea + document.execCommand("copy")；
 *     - 调用方拿到 boolean 结果，自己决定 toast 文案。
 *
 * 不做的事：
 *   - 不内置 toast——避免硬绑业务层的提示组件，复用方按需自己提示
 *   - 不处理富文本 ClipboardItem——目前业务只需要纯文本；HTML 字符串中的附件 URL
 *     仍会在 stabilizeClipboardAttachmentLinks 中安全替换
 *
 * @returns 复制是否成功
 */
export async function copyText(text: string): Promise<boolean> {
  if (text == null) return false;

  let value: string;
  try {
    value = await stabilizeClipboardAttachmentLinks(String(text));
  } catch (error) {
    // 稳定分享创建失败时宁可复制失败，也不能回退泄漏一个看起来成功、实际会过期的 URL。
    console.error("[clipboard] stable attachment share failed:", error);
    return false;
  }

  // Path 1: 现代异步 API（secureContext / https / localhost）
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 落入下面的降级路径
  }

  // Path 2: textarea + execCommand 降级
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    // 一系列样式让它不可见、不引发滚动跳动
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.padding = "0";
    ta.style.border = "none";
    ta.style.outline = "none";
    ta.style.boxShadow = "none";
    ta.style.background = "transparent";
    ta.style.opacity = "0";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
