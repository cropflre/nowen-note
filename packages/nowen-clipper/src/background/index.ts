/**
 * Background Service Worker：
 *
 *   1. 注册右键菜单、快捷键，把用户触发引导到"抽取 → 处理 → 上传"流水线
 *   2. 驱动剪藏流程：给 content script 发 EXTRACT_REQUEST，收到 HTML 后做
 *      图片内联 / 格式转换 / 调用后端 API
 *   3. 截图功能：通过 chrome.tabs.captureVisibleTab 实现可视区域截图和全页截图
 *   4. 通过 chrome.notifications 把结果告诉用户（尤其是 popup 已经关闭的场景）
 *   5. 快速捕捉模式：通过 badge / browserAction 点击直接剪藏
 */

import { getConfig, isConfigured, normalizeBaseUrl } from "../lib/storage";
import { importNote, NowenApiError } from "../lib/api";
import { buildContentBundle, inlineImages } from "../lib/transform";
import type {
  ClipMode,
  ClipProgress,
  ClipRequest,
  ExtractRequest,
  ExtractResponse,
} from "../lib/protocol";

// ========== 右键菜单 ==========

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "nowen-clip-selection",
        title: "剪藏选中内容到 Nowen Note",
        contexts: ["selection"],
      });
      chrome.contextMenus.create({
        id: "nowen-clip-page",
        title: "剪藏整个页面到 Nowen Note",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: "nowen-clip-simplified",
        title: "剪藏简化内容到 Nowen Note",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: "nowen-clip-fullpage",
        title: "完全克隆页面到 Nowen Note",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: "nowen-clip-screenshot",
        title: "截图当前可视区域到 Nowen Note",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: "nowen-clip-full-screenshot",
        title: "截图整个页面到 Nowen Note",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: "nowen-clip-link",
        title: "剪藏这个链接到 Nowen Note",
        contexts: ["link"],
      });
    });
  } catch (e) {
    console.warn("[nowen-clipper] create contextMenus failed:", e);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "nowen-clip-selection") {
    void runClip({ type: "CLIP_REQUEST", mode: "selection", tabId: tab.id });
  } else if (info.menuItemId === "nowen-clip-page") {
    void runClip({ type: "CLIP_REQUEST", mode: "article", tabId: tab.id });
  } else if (info.menuItemId === "nowen-clip-simplified") {
    void runClip({ type: "CLIP_REQUEST", mode: "simplified", tabId: tab.id });
  } else if (info.menuItemId === "nowen-clip-fullpage") {
    void runClip({ type: "CLIP_REQUEST", mode: "fullpage", tabId: tab.id });
  } else if (info.menuItemId === "nowen-clip-screenshot") {
    void runClip({ type: "CLIP_REQUEST", mode: "screenshot", tabId: tab.id });
  } else if (info.menuItemId === "nowen-clip-full-screenshot") {
    void runClip({ type: "CLIP_REQUEST", mode: "fullScreenshot", tabId: tab.id });
  } else if (info.menuItemId === "nowen-clip-link" && info.linkUrl) {
    void clipLinkOnly(info.linkUrl, tab);
  }
});

// ========== 快捷键 ==========

chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === "clip-page") {
    void runClip({ type: "CLIP_REQUEST", mode: "article", tabId: tab.id });
  } else if (command === "clip-selection") {
    void runClip({ type: "CLIP_REQUEST", mode: "selection", tabId: tab.id });
  }
});

// ========== popup 调用 ==========

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "CLIP_REQUEST") return undefined;
  console.log("[nowen-clipper] 收到 CLIP_REQUEST, mode =", msg.mode, "完整消息:", JSON.stringify(msg));
  // 异步响应：返回 true，通过 sendResponse 回传最终结果
  (async () => {
    try {
      const result = await runClip(msg as ClipRequest);
      sendResponse(result);
    } catch (e: any) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// ========== 核心流水线 ==========

interface ClipResult {
  ok: boolean;
  error?: string;
  noteId?: string;
  noteTitle?: string;
  images?: { ok: number; failed: number; skipped: number };
}

async function runClip(req: ClipRequest): Promise<ClipResult> {
  console.log("[nowen-clipper] runClip 开始, mode =", req.mode);

  const cfg = await getConfig();
  if (!isConfigured(cfg)) {
    notify(
      "请先设置 Nowen Note",
      "右键扩展图标 → 选项，填入服务器地址并登录账号。",
    );
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      /* ignore */
    }
    return { ok: false, error: "未配置服务器地址或未登录" };
  }

  // 截图模式走专门流程
  if (req.mode === "screenshot" || req.mode === "fullScreenshot") {
    console.log("[nowen-clipper] 进入截图流程, mode =", req.mode);
    return runScreenshotClip(req);
  }

  sendProgress({ type: "CLIP_PROGRESS", phase: "extract", message: "正在抽取页面内容..." });

  const extractMode: "article" | "selection" | "simplified" | "fullpage" =
    req.mode === "simplified" ? "simplified" : req.mode === "selection" ? "selection" : req.mode === "fullpage" ? "fullpage" : "article";
  console.log("[nowen-clipper] extractMode =", extractMode);

  const extracted = await requestExtract(req.tabId, extractMode);
  if (!extracted.ok || !extracted.data) {
    notify("剪藏失败", extracted.error || "内容抽取失败");
    return { ok: false, error: extracted.error };
  }

  const data = extracted.data;
  let html = data.html;

  // fullpage 模式：完整克隆的自包含 HTML 文档，跳过图片内联和格式转换，直接上传
  if (req.mode === "fullpage") {
    sendProgress({ type: "CLIP_PROGRESS", phase: "upload", message: "正在上传完整页面到 Nowen Note..." });
    const notebookName = (req.overrideNotebook ?? cfg.defaultNotebook).trim() || "Web 剪藏";
    const tags = parseTags(req.overrideTags ?? cfg.defaultTags);

    // 构建附加信息（评论 + 来源）注入到 <head> 内部，
    // 不能放在文档最前面，否则 <!DOCTYPE html> 不在开头，
    // 前端 detectFormat / isFullHtmlDocument 会识别失败。
    const metaParts: string[] = [];
    if (req.comment?.trim()) metaParts.push(`<!-- clipper-comment: ${req.comment.trim()} -->`);
    if (tags.length) metaParts.push(`<!-- clipper-tags: ${tags.join(",")} -->`);
    if (cfg.includeSource) metaParts.push(`<!-- clipper-source: ${data.url} -->`);
    let content = html;
    if (metaParts.length > 0) {
      const metaBlock = "\n" + metaParts.join("\n") + "\n";
      // 注入到 <head> 后面（在 <head> 标签与其内容之间）
      if (content.includes("<head>")) {
        content = content.replace("<head>", "<head>" + metaBlock);
      } else if (content.includes("<HEAD>")) {
        content = content.replace("<HEAD>", "<HEAD>" + metaBlock);
      } else {
        // 兜底：如果没有 <head> 标签，放在 <!DOCTYPE html> 之后
        const dtMatch = content.match(/<!DOCTYPE[^>]*>/i);
        if (dtMatch) {
          const idx = (dtMatch.index ?? 0) + dtMatch[0].length;
          content = content.slice(0, idx) + metaBlock + content.slice(idx);
        } else {
          // 最后兜底：直接追加到末尾
          content = content + metaBlock;
        }
      }
    }
    const contentText = data.text.slice(0, 5000);

    try {
      const resp = await importNote(cfg, {
        title: data.title,
        content,
        contentText,
        notebookName,
      });
      const noteId = resp.notes?.[0]?.id;
      sendProgress({
        type: "CLIP_PROGRESS",
        phase: "done",
        message: `已保存到「${notebookName}」`,
        noteId,
      });
      notify("剪藏成功", `完整页面已保存到「${notebookName}」`);
      return { ok: true, noteId, noteTitle: data.title };
    } catch (e) {
      const msg = describeError(e);
      sendProgress({ type: "CLIP_PROGRESS", phase: "error", message: msg });
      notify("剪藏失败", msg);
      return { ok: false, error: msg };
    }
  }

  // 图片处理（简化模式不需要内联图片，因为已经移除了）
  let images = { ok: 0, failed: 0, skipped: 0 };
  if (req.mode !== "simplified" && cfg.imageMode === "inline") {
    sendProgress({
      type: "CLIP_PROGRESS",
      phase: "download-images",
      message: "正在下载并内联图片...",
    });
    const result = await inlineImages(html);
    html = result.html;
    images = { ok: result.ok, failed: result.failed, skipped: result.skipped };
  } else if (cfg.imageMode === "skip") {
    html = html.replace(/<img\b[^>]*>/gi, "");
  }

  // 构建 content bundle
  sendProgress({
    type: "CLIP_PROGRESS",
    phase: "transform",
    message: "正在转换格式...",
  });
  const tags = parseTags(req.overrideTags ?? cfg.defaultTags);
  const { content, contentText } = buildContentBundle({
    title: data.title,
    html,
    sourceUrl: data.url,
    siteName: data.siteName,
    format: cfg.outputFormat,
    includeSource: cfg.includeSource,
    tags,
    comment: req.comment,
  });

  // 上传
  sendProgress({ type: "CLIP_PROGRESS", phase: "upload", message: "正在上传到 Nowen Note..." });
  const notebookName = (req.overrideNotebook ?? cfg.defaultNotebook).trim() || "Web 剪藏";
  try {
    const resp = await importNote(cfg, {
      title: data.title,
      content,
      contentText,
      notebookName,
    });
    const noteId = resp.notes?.[0]?.id;
    sendProgress({
      type: "CLIP_PROGRESS",
      phase: "done",
      message: `已保存到「${notebookName}」`,
      noteId,
      images,
    });
    notify(
      "剪藏成功",
      `已保存到「${notebookName}」${images.failed ? `（${images.failed} 张图片下载失败）` : ""}`,
    );
    return { ok: true, noteId, noteTitle: data.title, images };
  } catch (e) {
    const msg = describeError(e);
    sendProgress({ type: "CLIP_PROGRESS", phase: "error", message: msg });
    notify("剪藏失败", msg);
    return { ok: false, error: msg };
  }
}

// ========== 截图流水线 ==========

/** 截图剪藏：可视区域截图 或 全页截图 */
async function runScreenshotClip(req: ClipRequest): Promise<ClipResult> {
  const cfg = await getConfig();

  // 等待 popup 关闭 + 页面聚焦恢复，避免截到 popup 且避免触发 quota
  await sleep(800);

  if (req.mode === "screenshot") {
    // 可视区域截图
    sendProgress({ type: "CLIP_PROGRESS", phase: "screenshot", message: "正在截取当前屏幕..." });
    const dataUrl = await captureWithRetry();
    if (!dataUrl) {
      const msg = "截图失败：无法截取当前屏幕";
      sendProgress({ type: "CLIP_PROGRESS", phase: "error", message: msg });
      notify("截图失败", msg);
      return { ok: false, error: msg };
    }
    return await uploadScreenshot(cfg, req, dataUrl, "屏幕截图");
  }

  // 全页截图：使用 chrome.debugger 一次性截取整个页面长图
  sendProgress({ type: "CLIP_PROGRESS", phase: "screenshot", message: "正在截取整个页面..." });

  try {
    const fullPageDataUrl = await captureFullPageViaDebugger(req.tabId);
    return await uploadScreenshot(cfg, req, fullPageDataUrl, "整页截图");
  } catch (e: any) {
    const msg = `全页截图失败：${String(e?.message || e)}`;
    sendProgress({ type: "CLIP_PROGRESS", phase: "error", message: msg });
    notify("截图失败", msg);
    return { ok: false, error: msg };
  }
}

/**
 * 使用 chrome.debugger (CDP) 一次性截取整个页面长图。
 * 流程：
 *   attach → 通过 CDP 注入 CSS 禁用 fixed/sticky → 获取布局指标
 *   → 设置设备指标以适配整页 → 截图 → 移除注入的 CSS → 恢复设备指标 → detach
 *
 * 关键：通过 CDP 的 CSS.addRule / Runtime.evaluate 注入样式来禁用 fixed/sticky，
 * 而不是通过 content script 修改 inline style——因为 setDeviceMetricsOverride 会触发
 * 页面重布局，content script 设置的 inline style 可能被页面 JS 的 resize 监听器覆盖。
 */
async function captureFullPageViaDebugger(tabId: number): Promise<string> {
  const target = { tabId };

  // 1. 附加 debugger
  await chrome.debugger.attach(target, "1.3");

  try {
    // 2. 通过 CDP 的 Runtime.evaluate 注入 <style> 标签，
    //    对所有 fixed/sticky 元素添加 position: absolute !important 覆盖。
    //    这样即使 setDeviceMetricsOverride 导致页面重布局，样式表仍然生效。
    const injectResult = (await chrome.debugger.sendCommand(
      target,
      "Runtime.evaluate",
      {
        expression: `
          (function() {
            // 先收集所有 fixed/sticky 元素
            var fixedEls = [];
            var allEls = document.querySelectorAll('*');
            for (var i = 0; i < allEls.length; i++) {
              var cs = window.getComputedStyle(allEls[i]);
              if (cs.position === 'fixed' || cs.position === 'sticky') {
                fixedEls.push(allEls[i]);
              }
            }
            // 创建一个 style 标签，只针对 fixed/sticky 元素添加覆盖
            var style = document.createElement('style');
            style.id = '__nowen_clipper_disable_fixed__';
            style.textContent = '[data-nowen-was-fixed] { position: absolute !important; }';
            document.head.appendChild(style);
            // 给 fixed/sticky 元素打标记
            for (var j = 0; j < fixedEls.length; j++) {
              fixedEls[j].setAttribute('data-nowen-was-fixed', fixedEls[j].style.position || '');
            }
            return fixedEls.length;
          })()
        `,
        returnByValue: true,
      },
    )) as { result: { value: number } };

    console.log(
      "[nowen-clipper] 通过 CDP 禁用了",
      injectResult?.result?.value ?? 0,
      "个 fixed/sticky 元素",
    );

    // 等待样式生效
    await sleep(200);

    // 3. 获取页面布局指标（含 contentSize = 完整页面尺寸）
    const layoutMetrics = (await chrome.debugger.sendCommand(
      target,
      "Page.getLayoutMetrics",
    )) as {
      contentSize: { width: number; height: number };
      cssContentSize?: { width: number; height: number };
    };

    // 优先用 cssContentSize（Chrome 92+），否则用 contentSize
    const { width, height } = layoutMetrics.cssContentSize || layoutMetrics.contentSize;

    // 限制最大高度，避免超大页面导致 Chrome 崩溃（最大 16384px）
    const maxHeight = 16384;
    const captureHeight = Math.min(height, maxHeight);

    // 4. 设置设备指标以强制页面按完整宽高渲染
    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width: Math.ceil(width),
      height: Math.ceil(captureHeight),
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 等待渲染稳定
    await sleep(500);

    // 5. 截取完整页面——clip 参数指定截取区域
    const screenshot = (await chrome.debugger.sendCommand(
      target,
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width,
          height: captureHeight,
          scale: 1,
        },
      },
    )) as { data: string };

    // 6. 移除注入的样式 + 清理标记属性
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `
        (function() {
          var style = document.getElementById('__nowen_clipper_disable_fixed__');
          if (style) style.remove();
          var marked = document.querySelectorAll('[data-nowen-was-fixed]');
          for (var i = 0; i < marked.length; i++) {
            marked[i].removeAttribute('data-nowen-was-fixed');
          }
        })()
      `,
    });

    // 7. 恢复原始设备指标
    await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride", {});

    // 返回 data URL
    return `data:image/png;base64,${screenshot.data}`;
  } finally {
    // 8. 确保 detach debugger
    try {
      await chrome.debugger.detach(target);
    } catch {
      // detach 失败不影响结果
    }
  }
}

/** 上传截图到后端 */
async function uploadScreenshot(
  cfg: ReturnType<typeof getConfig> extends Promise<infer T> ? T : never,
  req: ClipRequest,
  dataUrl: string,
  titleSuffix: string,
): Promise<ClipResult> {
  sendProgress({ type: "CLIP_PROGRESS", phase: "upload", message: "正在上传截图..." });

  // 获取页面标题
  let pageTitle = titleSuffix;
  try {
    const tab = await chrome.tabs.get(req.tabId);
    pageTitle = `${tab.title || "页面"} - ${titleSuffix}`;
  } catch {
    /* ignore */
  }

  const notebookName = (req.overrideNotebook ?? cfg.defaultNotebook).trim() || "Web 剪藏";
  const tags = parseTags(req.overrideTags ?? cfg.defaultTags);

  // 构建包含截图的 HTML
  let pageUrl = "";
  try {
    const tab = await chrome.tabs.get(req.tabId);
    pageUrl = tab.url || "";
  } catch {
    /* ignore */
  }

  const imgHtml = `<img src="${dataUrl}" alt="${escapeHtml(titleSuffix)}" />`;
  const { content, contentText } = buildContentBundle({
    title: pageTitle,
    html: imgHtml,
    sourceUrl: pageUrl,
    siteName: "",
    format: cfg.outputFormat,
    includeSource: cfg.includeSource,
    tags,
    comment: req.comment,
  });

  try {
    const resp = await importNote(cfg, {
      title: pageTitle,
      content,
      contentText,
      notebookName,
    });
    const noteId = resp.notes?.[0]?.id;
    sendProgress({
      type: "CLIP_PROGRESS",
      phase: "done",
      message: `截图已保存到「${notebookName}」`,
      noteId,
    });
    notify("截图剪藏成功", `已保存到「${notebookName}」`);
    return { ok: true, noteId, noteTitle: pageTitle };
  } catch (e) {
    const msg = describeError(e);
    sendProgress({ type: "CLIP_PROGRESS", phase: "error", message: msg });
    notify("截图剪藏失败", msg);
    return { ok: false, error: msg };
  }
}

// ========== content script 通信 ==========

/**
 * 发消息到 content script 抽取。
 *
 * 关键：**始终先注入最新版 content.js**，确保 listener 是最新的。
 *
 * 原因：扩展更新/刷新后，旧页面上仍可能运行着旧版 content script。
 * 如果先发消息，旧版 script 会响应并返回旧逻辑的结果（比如缺少 fallback 的
 * extractArticle）。content.js 内部有防重复注册机制（移除旧 listener + 注册新的），
 * 所以重复注入是安全的。
 */
async function requestExtract(
  tabId: number,
  mode: "article" | "selection" | "simplified" | "fullpage",
): Promise<ExtractResponse> {
  const msg: ExtractRequest = { type: "EXTRACT_REQUEST", mode };
  console.log("[nowen-clipper] requestExtract: tabId =", tabId, "mode =", mode);

  // 始终先注入最新版 content script（防止旧版本响应消息）
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e: any) {
    console.warn("[nowen-clipper] 注入 content.js 失败:", e?.message || e);
    // 注入失败不阻断——页面上可能已有可用的 content script
  }

  // 发消息给（刚注入的）content script
  try {
    const res = (await chrome.tabs.sendMessage(tabId, msg)) as ExtractResponse;
    if (res && res.type === "EXTRACT_RESPONSE") {
      console.log("[nowen-clipper] requestExtract 成功, ok =", res.ok, "mode =", res.data?.mode);
      return res;
    }
    // 如果返回了非预期的响应格式
    return {
      type: "EXTRACT_RESPONSE",
      ok: false,
      error: "Content script 返回了非预期的响应格式",
    };
  } catch (e: any) {
    return {
      type: "EXTRACT_RESPONSE",
      ok: false,
      error: `无法在该页面运行剪藏（${String(e?.message || e)}）。某些浏览器特殊页面（如设置页、扩展商店）不支持剪藏。`,
    };
  }
}


/** 右键"剪藏这个链接"的极简模式：只存 URL/锚点，不下载对端内容 */
async function clipLinkOnly(url: string, tab: chrome.tabs.Tab) {
  const cfg = await getConfig();
  if (!isConfigured(cfg)) {
    void chrome.runtime.openOptionsPage();
    return;
  }
  const title = tab.title || url;
  const html = `<h1>${escapeHtml(title)}</h1><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`;
  const bundle = buildContentBundle({
    title,
    html,
    sourceUrl: url,
    siteName: new URL(url).hostname,
    format: cfg.outputFormat,
    includeSource: cfg.includeSource,
    tags: parseTags(cfg.defaultTags),
  });
  try {
    await importNote(cfg, {
      title,
      content: bundle.content,
      contentText: bundle.contentText,
      notebookName: cfg.defaultNotebook || "Web 剪藏",
    });
    notify("链接已保存", title);
  } catch (e) {
    notify("剪藏失败", describeError(e));
  }
}

// ========== 工具 ==========

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带重试的 captureVisibleTab 调用。
 * 遇到 MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND 限制时，
 * 指数退避重试最多 4 次（500ms → 1000ms → 2000ms → 4000ms）。
 */
async function captureWithRetry(maxRetries = 4): Promise<string | null> {
  let delay = 500;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(undefined as any, { format: "png" });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // 仅在速率限制错误时重试
      if (msg.includes("MAX_CAPTURE") && attempt < maxRetries) {
        console.warn(`[nowen-clipper] captureVisibleTab quota hit, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        delay *= 2; // 指数退避
        continue;
      }
      // 非速率限制错误 或 重试耗尽
      console.error("[nowen-clipper] captureVisibleTab failed:", msg);
      return null;
    }
  }
  return null;
}

function sendProgress(p: ClipProgress) {
  try {
    chrome.runtime.sendMessage(p).catch(() => {});
  } catch {
    /* popup 已关闭 */
  }
}

function notify(title: string, message: string) {
  try {
    chrome.notifications?.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message: message.slice(0, 300),
      priority: 1,
    });
  } catch {
    /* ignore */
  }
}

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function describeError(e: unknown): string {
  if (e instanceof NowenApiError) {
    if (e.status === 401) return "登录已过期或失效，请在扩展选项中重新登录。";
    if (e.status === 403) return "权限不足：" + e.message;
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ========== keepalive：避免剪藏中途 service worker 被回收 ==========
// MV3 SW 会在没有事件时 30 秒后被挂起。运行中的 runClip 因为 Promise 在等
// fetch，SW 不会立即被回收；这里不特意保活，通过消息通信持续活跃即可。

// 被当作 entry 时需要一个 export 让 TS 觉得是 module
export {};
