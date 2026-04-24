/**
 * content script ↔ background ↔ popup 之间的消息协议定义。
 * 统一走 chrome.runtime.sendMessage / onMessage，payload 都 JSON 可序列化。
 */

import type { ExtractResult } from "./extractor";

/**
 * 剪藏模式：
 *   - simplified:     简化内容（Readability 正文，移除图片等重元素）
 *   - article:        完整内容（Readability 正文，保留所有内容）
 *   - selection:      选区（用户选中的内容）
 *   - screenshot:     屏幕截图（当前可视区域）
 *   - fullScreenshot: 整个页面屏幕截图（滚动拼接）
 */
export type ClipMode = "simplified" | "article" | "fullpage" | "selection" | "screenshot" | "fullScreenshot";

/** popup → background: 执行一次剪藏 */
export interface ClipRequest {
  type: "CLIP_REQUEST";
  mode: ClipMode;
  tabId: number;
  /** 覆盖配置中的 notebook / tags（用户在 popup 里临时改） */
  overrideNotebook?: string;
  overrideTags?: string;
  /** 用户附加的评论 */
  comment?: string;
}

/** background → popup: 进度回执 */
export interface ClipProgress {
  type: "CLIP_PROGRESS";
  phase: "extract" | "screenshot" | "download-images" | "transform" | "upload" | "done" | "error";
  message: string;
  /** done 时返回后端 noteId */
  noteId?: string;
  /** 图片下载成功/失败数 */
  images?: { ok: number; failed: number; skipped: number };
}

/** background → content: 请求抽取 */
export interface ExtractRequest {
  type: "EXTRACT_REQUEST";
  mode: "article" | "selection" | "simplified" | "fullpage";
}
export interface ExtractResponse {
  type: "EXTRACT_RESPONSE";
  ok: boolean;
  data?: ExtractResult;
  error?: string;
}

/** background → content: 请求获取页面尺寸（用于全页截图） */
export interface PageDimensionsRequest {
  type: "PAGE_DIMENSIONS_REQUEST";
}
export interface PageDimensionsResponse {
  type: "PAGE_DIMENSIONS_RESPONSE";
  ok: boolean;
  data?: {
    scrollWidth: number;
    scrollHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    devicePixelRatio: number;
  };
  error?: string;
}

/** background → content: 请求滚动到指定位置（用于全页截图拼接） */
export interface ScrollToRequest {
  type: "SCROLL_TO_REQUEST";
  y: number;
}
export interface ScrollToResponse {
  type: "SCROLL_TO_RESPONSE";
  ok: boolean;
  actualY: number;
}

/** popup → background: 快速捕捉模式切换 */
export interface QuickCaptureToggle {
  type: "QUICK_CAPTURE_TOGGLE";
  enabled: boolean;
}

/** background → content: 全页截图前，临时把 fixed/sticky 元素改为 absolute（避免导航栏重复出现） */
export interface DisableFixedElementsRequest {
  type: "DISABLE_FIXED_ELEMENTS";
}
export interface DisableFixedElementsResponse {
  type: "DISABLE_FIXED_ELEMENTS_RESPONSE";
  ok: boolean;
  /** 被修改的元素数量 */
  count: number;
}

/** background → content: 全页截图后，恢复之前被改的 fixed/sticky 元素 */
export interface RestoreFixedElementsRequest {
  type: "RESTORE_FIXED_ELEMENTS";
}
export interface RestoreFixedElementsResponse {
  type: "RESTORE_FIXED_ELEMENTS_RESPONSE";
  ok: boolean;
}
