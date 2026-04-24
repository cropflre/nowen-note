/**
 * 扩展存储工具：封装 chrome.storage.local / chrome.storage.sync 的类型安全读写。
 *
 * 约定：
 *   - 所有"配置"（serverUrl / 默认笔记本等）统一放 sync 存储，跨设备同步
 *   - 临时状态（最近剪藏历史）放 local，不上传到云
 */

import type { ClipMode } from "./protocol";

export interface NowenClipperConfig {
  /** 后端地址，例如 https://note.example.com 或 http://localhost:3001 */
  serverUrl: string;
  /** 登录用户名 */
  username: string;
  /** 登录后获取的 JWT（由 POST /api/auth/login 返回） */
  token: string;
  /** 登录用户的显示名 / 角色等（仅用于 UI 展示） */
  displayName: string;
  /** 默认剪藏到的笔记本名称（不存在则自动创建）；为空时进"Web 剪藏"默认 */
  defaultNotebook: string;
  /** 剪藏时默认附加的 tag，逗号分隔 */
  defaultTags: string;
  /** 图片处理模式：skip=不处理，link=保留原始 URL，inline=下载为 base64 内联 */
  imageMode: "skip" | "link" | "inline";
  /** 是否自动在正文末尾插入"来源 URL"行 */
  includeSource: boolean;
  /** 输出格式：markdown（默认，体积小）|  html（保留更多样式） */
  outputFormat: "markdown" | "html";
  /** 快速捕捉模式：点击扩展图标直接用默认设置剪藏，不弹 popup */
  quickCapture: boolean;
  /** 快速捕捉的默认模式 */
  quickCaptureMode: ClipMode;
}

const DEFAULTS: NowenClipperConfig = {
  serverUrl: "",
  username: "",
  token: "",
  displayName: "",
  defaultNotebook: "Web 剪藏",
  defaultTags: "",
  imageMode: "inline",
  includeSource: true,
  outputFormat: "markdown",
  quickCapture: false,
  quickCaptureMode: "article",
};

const CONFIG_KEY = "nowenClipperConfig";

/** 读取配置，未设置时返回默认值 */
export async function getConfig(): Promise<NowenClipperConfig> {
  const store = chrome.storage.sync || chrome.storage.local;
  const data = (await store.get(CONFIG_KEY)) as Record<string, unknown>;
  const raw = (data[CONFIG_KEY] || {}) as Partial<NowenClipperConfig>;
  return { ...DEFAULTS, ...raw };
}

/** 写入配置（浅合并，传入 null 会覆盖为默认） */
export async function setConfig(patch: Partial<NowenClipperConfig>): Promise<NowenClipperConfig> {
  const current = await getConfig();
  const merged = { ...current, ...patch } as NowenClipperConfig;
  const store = chrome.storage.sync || chrome.storage.local;
  await store.set({ [CONFIG_KEY]: merged });
  return merged;
}

/** 简单判断是否"已配置好可用"（至少有 server + token） */
export function isConfigured(cfg: NowenClipperConfig): boolean {
  return !!cfg.serverUrl && !!cfg.token;
}

/** 规范化 baseUrl：去掉末尾斜杠 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
