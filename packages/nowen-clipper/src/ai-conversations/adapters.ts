import type { AIProvider, CapturedMessage, CapturePreview } from "./types";

export function detectConversation(rawUrl: string): { provider: AIProvider; id: string; url: string } | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const chatgpt = ["chatgpt.com", "chat.openai.com"].includes(url.hostname)
    && url.pathname.match(/^\/c\/([a-zA-Z0-9-]+)\/?$/);
  const doubao = url.hostname === "www.doubao.com"
    && url.pathname.match(/^\/chat\/([a-zA-Z0-9_-]+)\/?$/);
  if (!chatgpt && !doubao) return null;
  const match = chatgpt || doubao;
  if (!match) return null;
  return { provider: chatgpt ? "chatgpt" : "doubao", id: match[1], url: `${url.origin}${url.pathname}` };
}

export async function textHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}

function visible(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], script, style, template, nav, aside')) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
  }
  return true;
}

function accountMarker(doc: Document): string | null {
  // Only explicit rendered account identity. Never inspect application state, cookies or tokens.
  const element = doc.querySelector('[data-testid="account-menu"] [data-account-id], [data-testid="user-menu-button"][data-account-id]');
  return element && visible(element) ? element.getAttribute("data-account-id") : null;
}

function messageNodes(doc: Document, provider: AIProvider): Array<{ element: Element; role: "user" | "assistant" }> {
  if (provider === "chatgpt") {
    return Array.from(doc.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'))
      .filter(visible).map((element) => ({ element, role: element.getAttribute("data-message-author-role") as "user" | "assistant" }));
  }
  // Doubao's visible send/receive message containers. Unknown markup fails closed.
  return Array.from(doc.querySelectorAll('[data-testid="send_message"], [data-testid="receive_message"]'))
    .filter(visible).map((element) => ({ element, role: element.getAttribute("data-testid") === "send_message" ? "user" : "assistant" }));
}

/** Called ONLY after a user gesture or a previously verified exact-conversation grant. */
export async function extractConversation(doc: Document, rawUrl: string): Promise<CapturePreview> {
  const identity = detectConversation(rawUrl);
  if (!identity) throw new Error("AI_PLATFORM_UNSUPPORTED：当前不是受支持的 ChatGPT / 豆包会话地址，请使用普通选区剪藏。");
  const nodes = messageNodes(doc, identity.provider);
  if (!nodes.length) throw new Error("AI_MESSAGE_PARSE_FAILED：页面结构未识别，请使用普通选区剪藏。未保存任何对话。");
  if (nodes.length > 500) throw new Error("AI_MESSAGE_PARSE_FAILED：当前页面超过 500 条消息，请通过历史文件导入。");
  const messages: CapturedMessage[] = [];
  const ids = new Set<string>();
  const occurrences = new Map<string, number>();
  let stableIds = true;
  let chars = 0;
  let unavailableAssets = false;
  const globallyStreaming = !!doc.querySelector('[data-testid="stop-button"], [data-testid="stop-generating-button"], button[aria-label="停止生成"], button[aria-label="Stop generating"]');
  for (const { element, role } of nodes) {
    const clone = element.cloneNode(true) as Element;
    const originalDescendants = Array.from(element.querySelectorAll("*"));
    clone.querySelectorAll("*").forEach((node, index) => { if (!visible(originalDescendants[index])) node.remove(); });
    clone.querySelectorAll('script, style, template, button, [hidden], [aria-hidden="true"], iframe, object').forEach((node) => node.remove());
    if (clone.querySelector("img, video, audio, a[download]")) unavailableAssets = true;
    clone.querySelectorAll("img, video, audio").forEach((node) => node.replaceWith(doc.createTextNode("[附件未下载]")));
    const text = (clone.textContent || "").replace(/\r\n/g, "\n").trim();
    if (!text) continue;
    chars += text.length;
    if (chars > 800_000) throw new Error("AI_MESSAGE_PARSE_FAILED：对话超过单次采集限制，请通过文件导入。");
    const hash = await textHash(clone.innerHTML);
    let id = element.getAttribute("data-message-id") || element.closest("[data-message-id]")?.getAttribute("data-message-id") || "";
    if (!id) {
      stableIds = false;
      const key = `${role}:${hash}`;
      const count = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, count);
      id = `inferred:${key}:${count}`;
    }
    if (ids.has(id)) throw new Error("AI_MESSAGE_PARSE_FAILED：消息身份存在歧义，请使用选区剪藏。");
    ids.add(id);
    const streaming = element.matches('[data-is-streaming="true"], [data-streaming="true"]')
      || !!element.querySelector('[data-is-streaming="true"], [data-streaming="true"]')
      || (globallyStreaming && role === "assistant" && element === nodes.at(-1)?.element);
    messages.push({ externalMessageId: id, localSequence: messages.length, role, blocks: [{ type: "markdown", text }], text, contentHash: hash, capturedHtml: clone.innerHTML, captureState: streaming ? "streaming" : "stable" });
  }
  if (!messages.length) throw new Error("AI_MESSAGE_PARSE_FAILED：未检测到可保存的文字消息。");
  const warnings = ["当前只保存页面可读取的消息，历史内容可能未全部加载；完整性标记为部分。"];
  if (!stableIds) warnings.push("页面未提供稳定消息 ID，仅支持首次手动快照；自动保存已禁用。");
  if (messages.some((m) => m.captureState === "streaming")) warnings.push("正在生成的回复不会保存，请等生成结束后重新预览。");
  if (unavailableAssets) warnings.push("图片、附件、音频及工具结果未下载；仅保留可见文字或引用。");
  return {
    snapshot: { provider: identity.provider, accountScope: "", externalConversationId: identity.id, title: doc.title.replace(/\s*[-–|]\s*(ChatGPT|豆包).*$/i, "").slice(0, 200) || "AI 对话", sourceUrl: identity.url, messages, completeness: "partial", capturedAt: new Date().toISOString() },
    stableIds, accountMarker: accountMarker(doc), warnings,
  };
}
