/**
 * Content script：常驻每个页面，响应 background 的消息请求。
 *
 * 功能：
 *   1. 响应 EXTRACT_REQUEST：执行 Readability / 选区抽取并回传 background
 *   2. 响应 PAGE_DIMENSIONS_REQUEST：返回页面滚动尺寸（用于全页截图）
 *   3. 响应 SCROLL_TO_REQUEST：将页面滚动到指定位置（用于全页截图拼接）
 *
 * 防重复注册：扩展更新/重新加载后，旧版本的 content script 可能仍在页面上。
 * 通过 window 全局标记 + 移除旧 listener 来确保只有一个（最新的）监听器生效。
 */

import { extractArticle, extractSelection, extractSimplified, extractFullPage } from "../lib/extractor";
import type {
  ExtractRequest,
  ExtractResponse,
  PageDimensionsRequest,
  PageDimensionsResponse,
  ScrollToRequest,
  ScrollToResponse,
} from "../lib/protocol";

// 版本标记——用于确认 content script 是否已更新
const CONTENT_SCRIPT_VERSION = "0.4.0";

// 防重复注册：如果已经有旧版本的 listener，先移除它
const win = window as any;
if (typeof win.__nowenClipperListener === "function") {
  console.log("[nowen-clipper content] 移除旧版本 listener");
  chrome.runtime.onMessage.removeListener(win.__nowenClipperListener);
}

type MessageType = ExtractRequest | PageDimensionsRequest | ScrollToRequest;

function messageHandler(
  msg: MessageType,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (r: ExtractResponse | PageDimensionsResponse | ScrollToResponse) => void,
): boolean | undefined {
  if (!msg || !msg.type) return undefined;

  console.log(`[nowen-clipper content v${CONTENT_SCRIPT_VERSION}] 收到消息:`, msg.type);

  if (msg.type === "EXTRACT_REQUEST") {
    try {
      let data;
      console.log(`[nowen-clipper content] EXTRACT_REQUEST mode = "${msg.mode}"`);
      if (msg.mode === "simplified") {
        data = extractSimplified();
      } else if (msg.mode === "selection") {
        data = extractSelection();
      } else if (msg.mode === "fullpage") {
        data = extractFullPage();
      } else {
        data = extractArticle();
      }
      if (!data) {
        sendResponse({
          type: "EXTRACT_RESPONSE",
          ok: false,
          error:
            msg.mode === "selection"
              ? "未检测到选中的内容，请先在页面上选择一段文字或图片。"
              : "无法从当前页面抽取正文，尝试用「选区剪藏」。",
        });
        return;
      }
      console.log(`[nowen-clipper content] 抽取成功: mode=${data.mode}, html长度=${data.html.length}, 含<img>=${(data.html.match(/<img/gi) || []).length}张`);
      sendResponse({ type: "EXTRACT_RESPONSE", ok: true, data });
    } catch (e: any) {
      sendResponse({
        type: "EXTRACT_RESPONSE",
        ok: false,
        error: String(e?.message || e),
      });
    }
    return undefined;
  }

  if (msg.type === "PAGE_DIMENSIONS_REQUEST") {
    try {
      sendResponse({
        type: "PAGE_DIMENSIONS_RESPONSE",
        ok: true,
        data: {
          scrollWidth: Math.max(
            document.documentElement.scrollWidth,
            document.body?.scrollWidth || 0,
          ),
          scrollHeight: Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight || 0,
          ),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
      });
    } catch (e: any) {
      sendResponse({
        type: "PAGE_DIMENSIONS_RESPONSE",
        ok: false,
        error: String(e?.message || e),
      });
    }
    return undefined;
  }

  if (msg.type === "SCROLL_TO_REQUEST") {
    try {
      window.scrollTo({ top: msg.y, behavior: "instant" as ScrollBehavior });
      // 等待一帧让滚动生效
      requestAnimationFrame(() => {
        sendResponse({
          type: "SCROLL_TO_RESPONSE",
          ok: true,
          actualY: window.scrollY,
        });
      });
      return true; // 异步响应
    } catch (e: any) {
      sendResponse({
        type: "SCROLL_TO_RESPONSE",
        ok: false,
        actualY: 0,
      });
    }
    return undefined;
  }

  return undefined;
}

// 注册新 listener 并保存到 window 全局，供后续版本移除
chrome.runtime.onMessage.addListener(messageHandler as any);
win.__nowenClipperListener = messageHandler;

console.log(`[nowen-clipper content] v${CONTENT_SCRIPT_VERSION} 已注册 at`, location.href);
