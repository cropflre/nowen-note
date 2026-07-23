import type { ExtractResult } from "./extractor";

export const CONTENT_SCRIPT_PROTOCOL_VERSION = "1";

export type ClipperConnectionErrorCode =
  | "PAGE_NOT_INJECTABLE"
  | "FILE_ACCESS_REQUIRED"
  | "TAB_UNAVAILABLE"
  | "CONTENT_SCRIPT_UNAVAILABLE"
  | "CONTENT_SCRIPT_RESPONSE_INVALID"
  | "BACKGROUND_UNAVAILABLE";

export type ClipMode =
  | "quickNote"
  | "simplified"
  | "article"
  | "fullpage"
  | "selection"
  | "screenshot"
  | "fullScreenshot";

export interface AIEnhanceTasks {
  summary?: boolean;
  outline?: boolean;
  tags?: boolean;
  title?: boolean;
  highlight?: boolean;
  translation?: boolean;
}

export type AIEnhanceMode = "append" | "prepend" | "replace";

export interface ImageFailure {
  url: string;
  error: string;
}

export interface ImageProgressStats {
  ok: number;
  failed: number;
  skipped: number;
  bytes?: number;
  failures?: ImageFailure[];
}

/** 旧版 popup / 右键菜单协议，继续保留兼容。 */
export interface ClipRequest {
  type: "CLIP_REQUEST";
  mode: ClipMode;
  tabId: number;
  overrideNotebook?: string;
  overrideTags?: string;
  comment?: string;
  aiEnhance?: boolean;
  aiTasks?: AIEnhanceTasks;
  aiMode?: AIEnhanceMode;
}

/** Issue #217：统一的速记 / 网页剪藏请求。 */
export interface EnhancedClipRequest {
  type: "ENHANCED_CLIP_REQUEST";
  mode: ClipMode;
  tabId?: number;
  targetWorkspaceId: string | null;
  targetNotebookId?: string;
  targetNotebookName?: string;
  tags?: string[];
  comment?: string;
  isPinned?: boolean;
  imageMode: "skip" | "link" | "inline";
  outputFormat: "markdown" | "html";
  quickNote?: {
    title?: string;
    content: string;
  };
  aiEnhance?: boolean;
  aiTasks?: AIEnhanceTasks;
  aiMode?: AIEnhanceMode;
}

export interface EnhancedClipResponse {
  ok: boolean;
  error?: string;
  errorCode?: ClipperConnectionErrorCode;
  noteId?: string;
  noteTitle?: string;
  noteUrl?: string;
  images?: ImageProgressStats;
  warnings?: string[];
}

export interface ClipProgress {
  type: "CLIP_PROGRESS";
  phase:
    | "prepare-lazy"
    | "extract"
    | "screenshot"
    | "download-images"
    | "transform"
    | "ai-enhance"
    | "upload"
    | "done"
    | "error";
  message: string;
  noteId?: string;
  images?: ImageProgressStats;
  aiInfo?: { ok: boolean; error?: string };
}

export interface ContentScriptPingRequest {
  type: "CONTENT_SCRIPT_PING";
  protocolVersion: string;
}

export interface ContentScriptPingResponse {
  type: "CONTENT_SCRIPT_PONG";
  protocolVersion: string;
  contentVersion: string;
}

export interface ExtractRequest {
  type: "EXTRACT_REQUEST";
  mode: "article" | "selection" | "simplified" | "fullpage";
}
export interface ExtractResponse {
  type: "EXTRACT_RESPONSE";
  ok: boolean;
  data?: ExtractResult;
  error?: string;
  errorCode?: ClipperConnectionErrorCode;
}

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

export interface ScrollToRequest {
  type: "SCROLL_TO_REQUEST";
  y: number;
}
export interface ScrollToResponse {
  type: "SCROLL_TO_RESPONSE";
  ok: boolean;
  actualY: number;
}

export interface QuickCaptureToggle {
  type: "QUICK_CAPTURE_TOGGLE";
  enabled: boolean;
}

export interface DisableFixedElementsRequest {
  type: "DISABLE_FIXED_ELEMENTS";
}
export interface DisableFixedElementsResponse {
  type: "DISABLE_FIXED_ELEMENTS_RESPONSE";
  ok: boolean;
  count: number;
}

export interface RestoreFixedElementsRequest {
  type: "RESTORE_FIXED_ELEMENTS";
}
export interface RestoreFixedElementsResponse {
  type: "RESTORE_FIXED_ELEMENTS_RESPONSE";
  ok: boolean;
}
