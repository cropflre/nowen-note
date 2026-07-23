/**
 * Content script：常驻每个页面，响应 background 的消息请求。
 *
 * 功能：
 *   1. 响应 EXTRACT_REQUEST：执行 Readability / 选区抽取并回传 background
 *   2. 响应 PAGE_DIMENSIONS_REQUEST：返回页面滚动尺寸（用于全页截图）
 *   3. 响应 SCROLL_TO_REQUEST：将页面滚动到指定位置（用于全页截图拼接）
 *
 * 防重复注入：
 *   - manifest 的 content_scripts 已声明式注入；如果 background 又用 executeScript
 *     注入第二次，两次脚本会共用同一个 isolated world，顶层 `const` 会因重名抛
 *     SyntaxError，导致整段脚本作废。
 *   - 解决：整个脚本包成 IIFE，并在每次注入时安全替换旧 listener。
 *     即使插件刚更新、旧标签页残留标记，也会重新建立消息通道。
 */

import { extractArticle, extractSelection, extractSimplified, extractFullPage } from "../lib/extractor";
import { installContentScriptListener } from "../lib/content-script-runtime";
import { CONTENT_SCRIPT_PROTOCOL_VERSION } from "../lib/protocol";
import type {
  ContentScriptPingRequest,
  ContentScriptPingResponse,
  ExtractRequest,
  ExtractResponse,
  PageDimensionsRequest,
  PageDimensionsResponse,
  ScrollToRequest,
  ScrollToResponse,
} from "../lib/protocol";

(function initNowenClipperContent() {
  const win = window as unknown as Record<string, unknown>;

  // 版本标记——用于确认 content script 是否已更新
  const CONTENT_SCRIPT_VERSION = "0.5.0";

  type MessageType = ContentScriptPingRequest | ExtractRequest | PageDimensionsRequest | ScrollToRequest;

  function messageHandler(
    msg: MessageType,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: ContentScriptPingResponse | ExtractResponse | PageDimensionsResponse | ScrollToResponse) => void,
  ): boolean | undefined {
    if (!msg || !msg.type) return undefined;

    console.log(`[nowen-clipper content v${CONTENT_SCRIPT_VERSION}] 收到消息:`, msg.type);

    if (msg.type === "CONTENT_SCRIPT_PING") {
      sendResponse({
        type: "CONTENT_SCRIPT_PONG",
        protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
        contentVersion: CONTENT_SCRIPT_VERSION,
      });
      return undefined;
    }

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

  installContentScriptListener(win, chrome.runtime as any, CONTENT_SCRIPT_VERSION, messageHandler as any);

  console.log(`[nowen-clipper content] v${CONTENT_SCRIPT_VERSION} 已注册 at`, location.href);
})();
