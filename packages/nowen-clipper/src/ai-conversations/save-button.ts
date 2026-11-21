import type { QuickStatus } from "./types";

export interface SaveButtonActions {
  save(): Promise<QuickStatus>;
  status(): Promise<QuickStatus>;
  stop(): Promise<QuickStatus>;
  open(): Promise<QuickStatus>;
  /** The person closed the button with ✕: keep it away from now on. The button has already removed itself. */
  dismiss(): void;
  /** Only a real click by the person may read and save the conversation; tests substitute this check. */
  trusted?(event: Event): boolean;
}

const CSS = `
:host { all: initial; }
.wrap { position: fixed; right: 16px; top: 42%; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  max-width: min(300px, calc(100vw - 32px)); color: #1f2937;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
button { font: inherit; cursor: pointer; }
.row { position: relative; display: flex; }
.close { position: absolute; top: -8px; left: -8px; display: none; place-items: center; width: 20px; height: 20px; padding: 0; border: 1px solid #d0d7e2;
  border-radius: 50%; background: #fff; color: #64748b; font-size: 14px; line-height: 1; box-shadow: 0 2px 6px rgba(15, 23, 42, .18); }
.close:hover { background: #f3f6fd; color: #1f2937; }
.row:hover .close, .row:focus-within .close { display: grid; }
.main { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 6px 14px; border: 1px solid #d0d7e2; border-radius: 999px;
  background: #fff; color: inherit; box-shadow: 0 6px 18px rgba(15, 23, 42, .14); white-space: nowrap; }
.main::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #5b7cfa; flex: none; }
.main:hover { background: #f3f6fd; }
.main:disabled { cursor: progress; }
.wrap[data-state="saving"] .main::before { background: #f5a524; }
.wrap[data-state="saved"] .main { color: #047857; border-color: #a7dcc6; }
.wrap[data-state="saved"] .main::before { background: #10b981; }
.wrap[data-state="error"] .main::before { background: #e5484d; }
.detail { margin: 0; padding: 8px 10px; border: 1px solid #e3e8f0; border-radius: 10px; background: #fff; color: #475569; font-size: 12px;
  box-shadow: 0 6px 18px rgba(15, 23, 42, .1); overflow-wrap: anywhere; cursor: pointer; }
.wrap[data-state="error"] .detail { color: #b42318; border-color: #f4c7c3; }
.more { display: none; gap: 6px; }
.wrap:hover .more, .wrap:focus-within .more { display: flex; }
.more button { padding: 4px 10px; border: 1px solid #d0d7e2; border-radius: 999px; background: #fff; color: #334155; font-size: 12px; }
.more button:hover { background: #f3f6fd; }
button:focus-visible { outline: 2px solid #5b7cfa; outline-offset: 2px; }
[hidden] { display: none !important; }
@media (prefers-color-scheme: dark) {
  .wrap { color: #e5e9f3; }
  .main, .detail, .more button { background: #1c2333; border-color: #3a4560; color: #e5e9f3; }
  .main:hover, .more button:hover { background: #26304a; }
  .close { background: #1c2333; border-color: #3a4560; color: #aab4c8; }
  .close:hover { background: #26304a; color: #fff; }
  .wrap[data-state="saved"] .main { color: #6ee7b7; border-color: #2f6f58; }
  .detail { color: #c3cbdb; }
  .wrap[data-state="error"] .detail { color: #fda29b; border-color: #7a2e2a; }
}
@media print { .wrap { display: none; } }
`;

const LABELS: Record<QuickStatus["state"], string> = { idle: "存到 Nowen", saving: "正在保存…", saved: "已存 · 点击更新", error: "存到 Nowen" };
/** Server and extension messages start with a code such as `AI_MEMORY_DISABLED：` or `[409] `; people only need the sentence. */
const friendly = (text: string) => text.replace(/^[A-Z][A-Z0-9_]+：/, "").replace(/^\[\d{3}\]\s*/, "");

/** The 「存到 Nowen」 button on supported AI chat pages. A closed shadow root keeps the page from reading or restyling it. */
export function createSaveButton(doc: Document, actions: SaveButtonActions) {
  const host = doc.createElement("nowen-ai-save");
  const root = host.attachShadow({ mode: "closed" });
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = doc.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const style = element("style", "", CSS);
  const wrap = element("div", "wrap");
  const row = element("div", "row");
  const main = element("button", "main");
  const close = element("button", "close", "×");
  const detail = element("p", "detail");
  const more = element("div", "more");
  const open = element("button", "", "打开笔记");
  const stop = element("button", "", "停止自动保存");
  for (const button of [main, close, open, stop]) button.type = "button";
  close.setAttribute("aria-label", "隐藏「存到 Nowen」按钮");
  close.title = "隐藏按钮（可在扩展弹窗里重新显示）";
  detail.setAttribute("role", "status");
  detail.title = "点击收起";
  row.append(main, close);
  more.append(open, stop);
  wrap.append(row, detail, more);
  root.append(style, wrap);

  const trusted = actions.trusted || ((event: Event) => event.isTrusted);
  let current: QuickStatus = { state: "idle", automatic: false, canOpen: false };
  let busy = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  /** A message the person put away; it stays hidden until a different one comes. */
  let dismissed = "";
  function render(status: QuickStatus) {
    current = status;
    wrap.dataset.state = status.state;
    main.textContent = status.state === "saved" && status.automatic ? "已存 · 自动保存中" : LABELS[status.state];
    main.title = status.state === "saved" ? (status.automatic ? "新消息会自动存进 Nowen；点一下立即再存一次" : "有新消息时再点一下") : "把这段对话存进 Nowen 的「AI 对话」笔记本";
    main.disabled = busy;
    detail.textContent = status.message ? friendly(status.message) : "";
    detail.hidden = !status.message || detail.textContent === dismissed;
    open.hidden = !status.canOpen;
    stop.hidden = !status.automatic;
    more.hidden = open.hidden && stop.hidden;
    clearTimeout(poll);
    // Content waiting on this device is sent later by the extension; keep the label honest meanwhile.
    if (status.state === "saving") poll = setTimeout(() => void refresh(), 4000);
  }
  async function run(task: () => Promise<QuickStatus>, saving = false) {
    if (busy) return;
    busy = true;
    if (saving) render({ ...current, state: "saving", message: undefined });
    try { const next = await task(); busy = false; render(next); }
    catch (error) { busy = false; render({ ...current, state: "error", message: error instanceof Error ? error.message : "保存失败，请重试。" }); }
  }
  async function refresh() {
    if (busy || !host.isConnected) return;
    try { const next = await actions.status(); if (!busy) render(next); }
    catch { /* Keep showing the last known state; the next click reports the real error. */ }
  }
  function hide() { clearTimeout(poll); host.remove(); }
  main.addEventListener("click", (event) => { if (trusted(event)) { dismissed = ""; void run(actions.save, true); } });
  close.addEventListener("click", (event) => { if (trusted(event)) { hide(); actions.dismiss(); } });
  detail.addEventListener("click", () => { dismissed = detail.textContent || ""; detail.hidden = true; });
  open.addEventListener("click", (event) => { if (trusted(event)) void run(actions.open); });
  stop.addEventListener("click", (event) => { if (trusted(event)) void run(actions.stop); });
  render(current);
  return {
    /** Shows the button for the current conversation and reads its saved state. */
    show() {
      if (host.isConnected) return;
      render({ state: "idle", automatic: false, canOpen: false });
      doc.documentElement.append(host);
      void refresh();
    },
    hide,
    refresh,
    /** For tests only: the closed shadow root is otherwise unreachable. */
    root,
  };
}
