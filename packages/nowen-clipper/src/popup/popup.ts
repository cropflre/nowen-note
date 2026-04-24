/**
 * Popup 页交互：
 *
 * - 读取配置，若未填 serverUrl / token → 引导到 options
 * - 选剪藏模式（简化内容 / 完整内容 / 整页截图 / 屏幕截图 / 选区）
 * - 输入笔记本名 + 标签 + 评论
 * - 点击按钮向 background 发送 CLIP_REQUEST；监听 CLIP_PROGRESS 更新 UI
 * - 快速捕捉模式：勾选后下次点击扩展图标直接剪藏
 */

import { getConfig, isConfigured, setConfig, normalizeBaseUrl } from "../lib/storage";
import type { ClipMode, ClipProgress, ClipRequest } from "../lib/protocol";

async function init() {
  const cfg = await getConfig();
  const elNot = document.getElementById("not-configured")!;
  const elMain = document.getElementById("main")!;
  const elServer = document.getElementById("server-preview")!;

  if (!isConfigured(cfg)) {
    elNot.classList.remove("hidden");
    elMain.classList.add("hidden");
    document.getElementById("open-options")!.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
    return;
  }

  elServer.textContent = shortUrl(cfg.serverUrl);
  (document.getElementById("notebook") as HTMLInputElement).value = cfg.defaultNotebook || "";
  (document.getElementById("tags") as HTMLInputElement).value = cfg.defaultTags || "";
  (document.getElementById("quick-capture") as HTMLInputElement).checked = cfg.quickCapture || false;

  // 获取当前页面标题
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.title) {
      const titleEl = document.getElementById("page-title")!;
      titleEl.textContent = tab.title;
      titleEl.title = tab.title;
    }
  } catch {
    /* ignore */
  }

  // 快速捕捉模式
  document.getElementById("quick-capture")!.addEventListener("change", async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    await setConfig({ quickCapture: checked });
  });

  document.getElementById("clip")!.addEventListener("click", clip);
  document.getElementById("open-options-footer")!.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

async function clip() {
  const btn = document.getElementById("clip") as HTMLButtonElement;
  const progress = document.getElementById("progress")!;
  const progressText = document.getElementById("progress-text")!;
  const resultEl = document.getElementById("result")!;

  resultEl.classList.add("hidden");
  progress.classList.remove("hidden");
  progressText.textContent = "准备中...";
  btn.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showResult(false, "未找到当前标签页");
    btn.disabled = false;
    progress.classList.add("hidden");
    return;
  }

  const mode = (document.getElementById("clip-mode") as HTMLSelectElement).value as ClipMode;
  const comment = (document.getElementById("comment") as HTMLTextAreaElement).value.trim();

  console.log("[nowen-clipper popup] 选择的模式:", mode);

  const req: ClipRequest = {
    type: "CLIP_REQUEST",
    mode,
    tabId: tab.id,
    overrideNotebook: (document.getElementById("notebook") as HTMLInputElement).value.trim(),
    overrideTags: (document.getElementById("tags") as HTMLInputElement).value.trim(),
    comment: comment || undefined,
  };

  // 截图模式：popup 必须先关闭，否则 captureVisibleTab 会截到 popup 且触发 quota 限制
  if (mode === "screenshot" || mode === "fullScreenshot") {
    progressText.textContent = "正在准备截图，popup 即将关闭...";
    // 发送请求后立即关闭 popup；结果通过 notification 通知用户
    chrome.runtime.sendMessage(req).catch(() => {});
    // 给一点时间让 background 收到消息
    setTimeout(() => window.close(), 100);
    return;
  }

  // 非截图模式：保持 popup 打开，显示进度
  const handler = (msg: ClipProgress) => {
    if (msg?.type !== "CLIP_PROGRESS") return;
    progressText.textContent = msg.message;
  };
  chrome.runtime.onMessage.addListener(handler);

  try {
    const res = (await chrome.runtime.sendMessage(req)) as {
      ok: boolean;
      error?: string;
      noteTitle?: string;
      images?: { ok: number; failed: number; skipped: number };
    };
    progress.classList.add("hidden");
    if (res?.ok) {
      const imgInfo = res.images
        ? `图片 ${res.images.ok} 张${res.images.failed ? `（${res.images.failed} 张失败）` : ""}`
        : "";
      showResult(true, `✅ 已剪藏：「${res.noteTitle || "无标题"}」${imgInfo ? "，" + imgInfo : ""}`);
    } else {
      showResult(false, `❌ ${res?.error || "未知错误"}`);
    }
  } catch (e: any) {
    progress.classList.add("hidden");
    showResult(false, `❌ ${String(e?.message || e)}`);
  } finally {
    chrome.runtime.onMessage.removeListener(handler);
    btn.disabled = false;
  }
}

function showResult(ok: boolean, text: string) {
  const el = document.getElementById("result")!;
  el.classList.remove("hidden", "ok", "err");
  el.classList.add(ok ? "ok" : "err");
  el.textContent = text;
}

function shortUrl(u: string): string {
  try {
    const x = new URL(normalizeBaseUrl(u));
    return x.host;
  } catch {
    return u;
  }
}

void init();
