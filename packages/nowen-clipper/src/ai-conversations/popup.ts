import type { CaptureGrant } from "./types";

interface CaptureStatus {
  ok: boolean;
  grant?: CaptureGrant;
  pending: number;
  blocked: number;
  currentPending: number;
  noteUrl?: string;
  warning?: string;
  error?: string;
}
export function initAIConversationPanel(tab: chrome.tabs.Tab | undefined) {
  const rawUrl = tab?.url || "";
  let provider = "";
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname)) provider = "ChatGPT";
    if (url.protocol === "https:" && url.hostname === "www.doubao.com") provider = "豆包";
  } catch { return; }
  if (!provider || tab?.id === undefined) return;
  const tabId = tab.id;
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = element("ai-conversation-panel");
  panel.classList.remove("hidden");
  element("ai-provider").textContent = provider;
  let busy = false;
  const report = (text: string) => { element("ai-capture-status").textContent = text.replace(/^[A-Z][A-Z0-9_]+：/, ""); };
  async function send(type: string, payload: object = {}): Promise<any> {
    const response = await chrome.runtime.sendMessage({ type, tabId, ...payload });
    if (!response?.ok) throw new Error(response?.error || "扩展暂时无法处理请求，请重新打开弹窗。");
    return response;
  }
  function render(status: CaptureStatus) {
    const grant = status.grant;
    const pending = status.pending ? `；本机还有 ${status.pending} 项待同步${status.blocked ? `（${status.blocked} 项需处理）` : ""}` : "";
    const saved = !grant ? "还没有保存这段对话。" : grant.receipt ? (grant.automatic ? "已存到 Nowen，新消息会自动保存。" : "已存到 Nowen，有新消息时再点一下。") : "正在保存…";
    report(`${status.warning || grant?.error || saved}${pending}`);
    const link = element<HTMLAnchorElement>("ai-note-link");
    link.classList.toggle("hidden", !status.noteUrl);
    if (status.noteUrl) link.href = status.noteUrl;
  }
  async function act(task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    element<HTMLButtonElement>("ai-quick-save").disabled = true;
    try { await task(); }
    catch (error) { report(error instanceof Error ? error.message : "操作失败，请重试。"); }
    finally {
      busy = false;
      element<HTMLButtonElement>("ai-quick-save").disabled = false;
    }
  }
  element("ai-quick-save").addEventListener("click", () => void act(async () => {
    report("正在读取并保存这段对话…");
    render(await send("AI_QUICK_SAVE"));
  }));
  panel.querySelectorAll<HTMLButtonElement>("[data-ai-action]").forEach((button) => {
    button.addEventListener("click", () => void act(async () => {
      const action = button.dataset.aiAction!;
      if (action === "clear" && !window.confirm("清空当前 Nowen 账号的 AI 暂存队列？尚未保存的本地内容将被删除；已经发出的请求可能已在服务端保存，清空无法撤回。此操作不能撤销。")) return;
      render(await send("AI_MANAGE", { action }));
    }));
  });
  void send("AI_STATUS").then(render).catch((error: Error) => report(error.message));
  const poll = window.setInterval(() => { if (!busy) void send("AI_STATUS").then(render).catch(() => undefined); }, 2000);
  window.addEventListener("pagehide", () => window.clearInterval(poll), { once: true });
}
