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

// ⚠️ 必须在所有其他 import 之前！为 turndown 等依赖 DOM 的库提供 Service Worker polyfill。
import "../lib/sw-polyfill";

import { getConfig, isConfigured, normalizeBaseUrl } from "../lib/storage";
import { importNote, enhanceClip, NowenApiError, type AIEnhanceResult } from "../lib/api";
import { buildContentBundle, inlineImages } from "../lib/transform";
import { requestExtractFromTab } from "../lib/content-script-bridge";
import type {
  AIEnhanceMode,
  AIEnhanceTasks,
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

  const extracted = await requestExtractFromTab(req.tabId, extractMode);
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
  let tags = parseTags(req.overrideTags ?? cfg.defaultTags);
  let pageTitle = data.title;

  // ========== AI 优化（可选）==========
  // 默认行为：用 cfg.aiEnhanceEnabled。popup 可临时反向覆盖（req.aiEnhance）。
  // simplified / article / selection 都可走 AI（fullpage/screenshot 已在前面分支跳过）。
  const aiEnabled = req.aiEnhance ?? cfg.aiEnhanceEnabled;
  const aiTasks: AIEnhanceTasks = req.aiTasks ?? cfg.aiEnhanceTasks;
  const aiMode: AIEnhanceMode = req.aiMode ?? cfg.aiEnhanceMode;
  let aiInfo: { ok: boolean; error?: string } | undefined;
  let aiBlock = ""; // 在 buildContentBundle 之后注入的 AI 块（与 outputFormat 同语言）

  if (aiEnabled && hasAnyTask(aiTasks) && data.text && data.text.trim().length >= 20) {
    sendProgress({
      type: "CLIP_PROGRESS",
      phase: "ai-enhance",
      message: "AI 正在优化内容...",
    });
    try {
      const aiResp = await enhanceClip(cfg, {
        title: data.title,
        url: data.url,
        siteName: data.siteName,
        contentText: data.text,
        tasks: aiTasks,
        language: cfg.aiEnhanceLanguage,
        customInstruction: cfg.aiCustomInstruction || undefined,
        maxInputChars: cfg.aiMaxInputChars,
      });

      if (aiResp.ok && aiResp.enhanced) {
        // 应用标题覆盖（如果用户勾了 title 任务）
        if (aiResp.enhanced.title) {
          pageTitle = aiResp.enhanced.title;
        }
        // 合并 AI 标签（去重）
        if (aiResp.enhanced.tags && aiResp.enhanced.tags.length) {
          const set = new Set(tags.map((t) => t.toLowerCase()));
          for (const t of aiResp.enhanced.tags) {
            if (!set.has(t.toLowerCase())) {
              tags.push(t);
              set.add(t.toLowerCase());
            }
          }
        }
        // 生成 AI 块（用于 prepend / append / replace）
        aiBlock = composeAIBlock(aiResp.enhanced, cfg.outputFormat);
        aiInfo = { ok: true };
      } else {
        const err = aiResp.error || "AI 返回失败";
        console.warn("[nowen-clipper] AI 优化失败:", err);
        aiInfo = { ok: false, error: err };
        if (cfg.aiFailureStrategy === "fail") {
          notify("AI 优化失败", err);
          return { ok: false, error: `AI 优化失败：${err}` };
        }
        // fallback：继续走原文路径
      }
    } catch (e: any) {
      const msg = describeError(e);
      console.warn("[nowen-clipper] AI 优化异常:", msg);
      aiInfo = { ok: false, error: msg };
      if (cfg.aiFailureStrategy === "fail") {
        notify("AI 优化失败", msg);
        return { ok: false, error: `AI 优化失败：${msg}` };
      }
      // fallback：继续走原文路径
    }
  }
  // ========== /AI 优化 ==========

  const { content: baseContent, contentText: baseContentText } = buildContentBundle({
    title: pageTitle,
    html,
    sourceUrl: data.url,
    siteName: data.siteName,
    format: cfg.outputFormat,
    includeSource: cfg.includeSource,
    tags,
    comment: req.comment,
  });

  // 把 AI 块按 mode 拼回 content
  let content = baseContent;
  let contentText = baseContentText;
  if (aiBlock) {
    if (aiMode === "replace") {
      // 只保留 AI 产物（仍保留 title/来源/标签作为附录）—— 用 baseContent 的首尾框架
      // 简单实现：用 aiBlock 替换正文 html 转过来的中段不可行（没有可靠分隔符），
      // 折中：直接用 "标题 + AI 块 + 来源/标签" 重新构建
      const rebuilt = buildContentBundle({
        title: pageTitle,
        html: cfg.outputFormat === "html" ? aiBlock : `<pre data-nowen-md>${escapeHtml(aiBlock)}</pre>`,
        sourceUrl: data.url,
        siteName: data.siteName,
        format: cfg.outputFormat,
        includeSource: cfg.includeSource,
        tags,
        comment: req.comment,
      });
      // markdown 模式下，buildContentBundle 会把 <pre data-nowen-md> 转成代码块——
      // 这不是我们要的；改成直接拼字符串。
      if (cfg.outputFormat === "markdown") {
        content = `# ${pageTitle}\n\n${aiBlock}\n\n${buildFooterMd(cfg.includeSource, data.url, data.siteName, tags)}`;
        contentText = content.replace(/[#*`>\-|_\[\]()]/g, "").replace(/\s+/g, " ").trim();
      } else {
        content = rebuilt.content;
        contentText = rebuilt.contentText;
      }
    } else if (aiMode === "prepend") {
      content = injectAIBlock(baseContent, aiBlock, "prepend", cfg.outputFormat);
      contentText = aiBlock.replace(/[#*`>\-|_\[\]()]/g, " ") + " " + baseContentText;
    } else {
      // append
      content = injectAIBlock(baseContent, aiBlock, "append", cfg.outputFormat);
      contentText = baseContentText + " " + aiBlock.replace(/[#*`>\-|_\[\]()]/g, " ");
    }
  }

  // 上传
  sendProgress({ type: "CLIP_PROGRESS", phase: "upload", message: "正在上传到 Nowen Note..." });
  const notebookName = (req.overrideNotebook ?? cfg.defaultNotebook).trim() || "Web 剪藏";
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
      message: `已保存到「${notebookName}」`,
      noteId,
      images,
      aiInfo,
    });
    const aiTip = aiInfo
      ? aiInfo.ok
        ? "（已 AI 优化）"
        : `（AI 失败：${(aiInfo.error || "").slice(0, 60)}，已保存原文）`
      : "";
    notify(
      "剪藏成功",
      `已保存到「${notebookName}」${images.failed ? `（${images.failed} 张图片下载失败）` : ""}${aiTip}`,
    );
    return { ok: true, noteId, noteTitle: pageTitle, images };
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

  // Firefox 兼容：FF 没有 chrome.debugger API，CDP 路径完全不可用。
  // 这里 feature-detect 一下，不可用时降级为"滚动 + 多次 captureVisibleTab + OffscreenCanvas 拼接"。
  // 这样在 FF 上至少功能可用，只是质量比 Chrome 的 CDP 整图要差一点（无法消除 fixed 元素）。
  const hasDebugger = typeof chrome.debugger?.attach === "function";

  try {
    const fullPageDataUrl = hasDebugger
      ? await captureFullPageViaDebugger(req.tabId)
      : await captureFullPageByScrolling(req.tabId);
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

/**
 * Firefox 降级实现：滚动页面 + 多次 captureVisibleTab + OffscreenCanvas 拼接成长图。
 *
 * 为什么写这条降级路径：
 *   FF 的 MV3 没有 chrome.debugger API（也没有等价的 CDP 接入），所以无法走
 *   captureFullPageViaDebugger 那条"一次性整图"的高质量路径。
 *
 * 流程：
 *   1) 在 tab 里执行脚本，关掉 fixed/sticky、读取 scrollHeight / innerHeight / dpr，
 *      并把 scrollTop 归零；
 *   2) 在 background 里循环：滚一屏 → captureVisibleTab → 累计 dataUrl，
 *      最后一屏可能不足一屏高度，单独裁掉重叠部分；
 *   3) 用 OffscreenCanvas 拼接（FF 105+ 的扩展后台支持 OffscreenCanvas + createImageBitmap）；
 *   4) 还原页面：移除注入的样式 + 还原 scrollTop。
 *
 * 限制：
 *   - 单次 captureVisibleTab 受 MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND 限速，
 *     已通过 captureWithRetry + 帧间 sleep 缓解；
 *   - 页面有滚动联动动画 / lazy-load 时，仍可能漏内容——这是滚动拼接固有的缺陷；
 *   - 极长页面（> 16384px）会被截断，与 Chrome 路径行为一致。
 */
async function captureFullPageByScrolling(tabId: number): Promise<string> {
  // 1. 在页面里准备：禁用 fixed/sticky、归零滚动、读尺寸
  const [{ result: meta }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // 注入禁用 fixed/sticky 的样式
      const STYLE_ID = "__nowen_clipper_disable_fixed__";
      let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
          "*[data-nowen-was-fixed] { position: absolute !important; }";
        document.head.appendChild(style);
      }
      const all = document.querySelectorAll<HTMLElement>("*");
      let count = 0;
      all.forEach((el) => {
        const cs = window.getComputedStyle(el);
        if (cs.position === "fixed" || cs.position === "sticky") {
          el.setAttribute("data-nowen-was-fixed", el.style.position || "");
          count++;
        }
      });
      const prevScrollY = window.scrollY;
      window.scrollTo({ top: 0, behavior: "auto" });
      return {
        prevScrollY,
        fixedCount: count,
        scrollHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
        ),
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        dpr: window.devicePixelRatio || 1,
      };
    },
  }) as unknown as Array<{ result: {
    prevScrollY: number;
    fixedCount: number;
    scrollHeight: number;
    innerHeight: number;
    innerWidth: number;
    dpr: number;
  } }>;

  const totalHeight = Math.min(meta.scrollHeight, 16384);
  const viewportH = meta.innerHeight;
  const viewportW = meta.innerWidth;
  const dpr = meta.dpr;

  // 2. 滚动 + 截图。每帧间留 350ms 给 lazy-load + 避免 quota。
  const frames: { dataUrl: string; offsetY: number }[] = [];
  let scrolled = 0;
  while (scrolled < totalHeight) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (top: number) => window.scrollTo({ top, behavior: "auto" }),
      args: [scrolled],
    });
    await sleep(350);
    const dataUrl = await captureWithRetry();
    if (!dataUrl) {
      throw new Error("captureVisibleTab 返回空，可能受浏览器限速");
    }
    frames.push({ dataUrl, offsetY: scrolled });
    scrolled += viewportH;
  }

  // 3. 还原页面
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (prev: number) => {
      const style = document.getElementById("__nowen_clipper_disable_fixed__");
      if (style) style.remove();
      document
        .querySelectorAll<HTMLElement>("[data-nowen-was-fixed]")
        .forEach((el) => el.removeAttribute("data-nowen-was-fixed"));
      window.scrollTo({ top: prev, behavior: "auto" });
    },
    args: [meta.prevScrollY],
  });

  // 4. OffscreenCanvas 拼接。各帧像素尺寸 = viewport * dpr。
  const canvasW = Math.round(viewportW * dpr);
  const canvasH = Math.round(totalHeight * dpr);
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 OffscreenCanvas 2D 上下文");

  for (const frame of frames) {
    const blob = await (await fetch(frame.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const dy = Math.round(frame.offsetY * dpr);
    // 最后一帧可能超出 totalHeight：用 sourceRect 裁剪，避免拼出页脚后又"重复"
    const remaining = canvasH - dy;
    const drawH = Math.min(bitmap.height, remaining);
    ctx.drawImage(bitmap, 0, 0, bitmap.width, drawH, 0, dy, bitmap.width, drawH);
    bitmap.close();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  // Blob → dataURL（在 module SW 里没有 FileReader 的话用 base64 通道）
  const buf = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  return `data:image/png;base64,${base64}`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // 分块拼接，避免一次性 String.fromCharCode 触发 stack overflow
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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

// ========== AI 优化辅助 ==========

function hasAnyTask(t: AIEnhanceTasks): boolean {
  return !!(t.summary || t.outline || t.tags || t.title || t.highlight || t.translation);
}

/**
 * 把后端返回的 enhanced 字段组合成"AI 优化块"（Markdown 或 HTML 片段）。
 * 注意：title / tags 已经在调用处单独处理，不出现在这里。
 */
function composeAIBlock(
  enhanced: NonNullable<AIEnhanceResult["enhanced"]>,
  format: "markdown" | "html",
): string {
  if (format === "markdown") {
    const parts: string[] = [];
    if (enhanced.summary) {
      parts.push(`> [!summary] **AI 摘要**\n> ${enhanced.summary.replace(/\n/g, "\n> ")}`);
    }
    if (enhanced.highlights && enhanced.highlights.length) {
      parts.push(
        `**🔑 重点**\n` + enhanced.highlights.map((h) => `- ${h}`).join("\n"),
      );
    }
    if (enhanced.outline) {
      parts.push(`**📋 大纲**\n\n${enhanced.outline}`);
    }
    if (enhanced.translation) {
      parts.push(`**🌐 中文翻译**\n\n${enhanced.translation}`);
    }
    if (parts.length === 0) return "";
    return parts.join("\n\n");
  }

  // html
  const parts: string[] = [];
  if (enhanced.summary) {
    parts.push(
      `<blockquote><p><strong>AI 摘要</strong></p><p>${escapeHtml(enhanced.summary)}</p></blockquote>`,
    );
  }
  if (enhanced.highlights && enhanced.highlights.length) {
    parts.push(
      `<p><strong>🔑 重点</strong></p><ul>${enhanced.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`,
    );
  }
  if (enhanced.outline) {
    // outline 是 markdown 列表，简单转 <pre> 以保留结构（前端 Tiptap 不会渲染 MD 嵌套，但
    // /export/import 会把它当作 HTML 文档，能保留可读性。复杂情况下用户可在前端重渲染）。
    parts.push(
      `<p><strong>📋 大纲</strong></p><pre>${escapeHtml(enhanced.outline)}</pre>`,
    );
  }
  if (enhanced.translation) {
    parts.push(
      `<p><strong>🌐 中文翻译</strong></p><pre>${escapeHtml(enhanced.translation)}</pre>`,
    );
  }
  return parts.join("\n");
}

/**
 * 把 AI 块注入到 buildContentBundle 的产物里：
 *   - prepend: 紧跟在 H1 标题（# 或 <h1>）之后插入
 *   - append:  在末尾"来源/标签"之前插入；找不到则直接追加到最后
 */
function injectAIBlock(
  base: string,
  block: string,
  pos: "prepend" | "append",
  format: "markdown" | "html",
): string {
  if (pos === "prepend") {
    if (format === "markdown") {
      // 在第一个 H1 行（# Title）之后插入
      const m = base.match(/^(#\s+[^\n]+\n)/);
      if (m) {
        return base.slice(0, m[0].length) + "\n" + block + "\n\n---\n\n" + base.slice(m[0].length);
      }
      return block + "\n\n---\n\n" + base;
    } else {
      // html: 在 </h1> 之后插入
      const m = base.match(/<\/h1>/i);
      if (m && typeof m.index === "number") {
        const insertAt = m.index + m[0].length;
        return base.slice(0, insertAt) + "\n" + block + "\n<hr/>\n" + base.slice(insertAt);
      }
      return block + "\n<hr/>\n" + base;
    }
  }

  // append：尽量插在"来源"附录之前
  if (format === "markdown") {
    const m = base.match(/\n---\n[^\n]*📎\s*来源/);
    if (m && typeof m.index === "number") {
      return base.slice(0, m.index) + "\n\n---\n\n" + block + base.slice(m.index);
    }
    return base + "\n\n---\n\n" + block;
  } else {
    // 兼容两种 footer 结构：
    //   - 旧版：<hr/><p><small>📎 来源…</small></p>
    //   - 新版：<hr/><p>📎 来源…</p>
    // <small> 改成可选 (?:<small>)?，确保已有旧笔记 append 时仍能命中锚点
    const m = base.match(/<hr\s*\/?>\s*<p>(?:<small>)?\s*📎\s*来源/i);
    if (m && typeof m.index === "number") {
      return base.slice(0, m.index) + "\n<hr/>\n" + block + "\n" + base.slice(m.index);
    }
    return base + "\n<hr/>\n" + block;
  }
}

/** replace 模式重建笔记尾部（来源 + 标签）
 * 与 transform.ts 的 HTML 版保持一致：
 *   - 链接文本始终是完整 URL，方便用户看到具体页面而不是仅站点名；
 *   - siteName 作为前缀短标签放在链接前。
 */
function buildFooterMd(
  includeSource: boolean,
  url: string,
  siteName: string,
  tags: string[],
): string {
  const parts: string[] = [];
  if (includeSource) {
    const prefix = siteName ? `${siteName} · ` : "";
    parts.push(`---\n\n📎 来源：${prefix}[${url}](${url})`);
  }
  if (tags.length) {
    parts.push(tags.map((t) => `#${t}`).join(" "));
  }
  return parts.join("\n\n");
}

// ========== keepalive：避免剪藏中途 service worker 被回收 ==========
// MV3 SW 会在没有事件时 30 秒后被挂起。运行中的 runClip 因为 Promise 在等
// fetch，SW 不会立即被回收；这里不特意保活，通过消息通信持续活跃即可。

// 被当作 entry 时需要一个 export 让 TS 觉得是 module
export {};
