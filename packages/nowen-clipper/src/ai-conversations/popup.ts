import type { CaptureGrant, CapturePreview } from "./types";

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
  element<HTMLInputElement>("ai-source-name").value = `我的 ${provider}`;
  let previewId = "";
  let currentPreview: CapturePreview | undefined;
  let busy = false;
  const report = (text: string) => { element("ai-capture-status").textContent = text; };
  async function send(type: string, payload: object = {}): Promise<any> {
    const response = await chrome.runtime.sendMessage({ type, tabId, ...payload });
    if (!response?.ok) throw new Error(response?.error || "扩展暂时无法处理请求，请重新打开弹窗。");
    return response;
  }
  function render(status: CaptureStatus) {
    if (status.grant && !busy && !currentPreview) element<HTMLInputElement>("ai-source-name").value = status.grant.source.displayName;
    const receipt = status.grant?.receipt;
    const pending = status.pending ? `；本地待同步 ${status.pending} 项${status.blocked ? `（${status.blocked} 项需处理）` : ""}` : "";
    report(status.warning || status.grant?.error || `${status.grant?.automatic ? "此会话已开启自动保存" : "自动保存已关闭"}${receipt ? `；Nowen 已持久化到版本 ${receipt.revision}` : "；尚无服务端保存回执"}${pending}`);
    const link = element<HTMLAnchorElement>("ai-note-link");
    link.classList.toggle("hidden", !status.noteUrl);
    if (status.noteUrl) link.href = status.noteUrl;
  }
  async function act(task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    element<HTMLButtonElement>("ai-preview").disabled = true;
    element<HTMLButtonElement>("ai-save").disabled = true;
    try { await task(); }
    catch (error) { report(error instanceof Error ? error.message : "操作失败，请重试。"); }
    finally {
      busy = false;
      element<HTMLButtonElement>("ai-preview").disabled = false;
      element<HTMLButtonElement>("ai-save").disabled = !previewId;
    }
  }
  element("ai-preview").addEventListener("click", () => void act(async () => {
    report("正在读取当前页面可访问的对话，仅预览，还未保存...");
    const result = await send("AI_PREVIEW");
    previewId = result.previewId;
    currentPreview = result.preview;
    const preview = currentPreview!;
    element("ai-preview-panel").classList.remove("hidden");
    element("ai-preview-title").textContent = `${preview.snapshot.title} · ${preview.snapshot.messages.length} 条可见消息 · 部分归档`;
    element<HTMLTextAreaElement>("ai-preview-content").value = preview.snapshot.messages.map((message) => `## ${message.role === "user" ? "用户" : "AI"}${message.captureState === "streaming" ? "（生成中，不保存）" : ""}\n\n${message.text}`).join("\n\n---\n\n");
    element("ai-capture-warnings").textContent = preview.warnings.join("\n");
    element<HTMLInputElement>("ai-autosave").disabled = !preview.stableIds;
    if (!preview.stableIds) element<HTMLInputElement>("ai-autosave").checked = false;
    report("请检查完整预览、来源账户与下方个人笔记本，再确认保存。");
  }));
  element("ai-save").addEventListener("click", () => void act(async () => {
    if (element<HTMLSelectElement>("workspace").value !== "personal") throw new Error("AI 对话归档目前仅支持个人空间，请选择个人笔记本。");
    report("正在暂存并向 Nowen 提交...");
    const result = await send("AI_SAVE", {
      previewId, notebookId: element<HTMLSelectElement>("notebook").value,
      sourceName: element<HTMLInputElement>("ai-source-name").value,
      automatic: element<HTMLInputElement>("ai-autosave").checked,
    });
    previewId = "";
    currentPreview = undefined;
    render(result);
  }));
  panel.querySelectorAll<HTMLButtonElement>("[data-ai-action]").forEach((button) => {
    button.addEventListener("click", () => void act(async () => {
      const action = button.dataset.aiAction!;
      if (action === "clear" && !window.confirm("清空当前 Nowen 账号的 AI 暂存队列？尚未保存的本地内容将被删除；已经发出的请求可能已在服务端保存，清空无法撤回。此操作不能撤销。")) return;
      if (action === "revoke" && !window.confirm("撤销此来源的采集授权并停止其所有会话？未确认保存的暂存内容会保留，不会删除第三方原文。")) return;
      render(await send("AI_MANAGE", { action }));
    }));
  });
  void send("AI_STATUS").then(render).catch((error: Error) => report(error.message));
  const poll = window.setInterval(() => { if (!busy && !currentPreview) void send("AI_STATUS").then(render).catch(() => undefined); }, 2000);
  window.addEventListener("pagehide", () => window.clearInterval(poll), { once: true });
}
