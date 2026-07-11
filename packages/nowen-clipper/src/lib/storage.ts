import type { AIEnhanceMode, AIEnhanceTasks, ClipMode } from "./protocol";

export interface NowenClipperConfig {
  serverUrl: string;
  username: string;
  /** 登录用户稳定 id，用于跨账号隔离最近选择。老配置为空时回退 username。 */
  userId: string;
  token: string;
  displayName: string;
  defaultNotebook: string;
  defaultTags: string;
  imageMode: "skip" | "link" | "inline";
  includeSource: boolean;
  outputFormat: "markdown" | "html";
  quickCapture: boolean;
  quickCaptureMode: ClipMode;
  /** 剪藏前主动滚动页面，触发视口外懒加载资源。 */
  lazyLoadScroll: boolean;
  /** 单次远程图片抓取硬限制。 */
  maxImageCount: number;
  maxSingleImageBytes: number;
  maxTotalImageBytes: number;
  imageTimeoutMs: number;

  aiEnhanceEnabled: boolean;
  aiEnhanceTasks: AIEnhanceTasks;
  aiEnhanceMode: AIEnhanceMode;
  aiEnhanceLanguage: "zh-CN" | "en";
  aiCustomInstruction: string;
  aiMaxInputChars: number;
  aiFailureStrategy: "fallback" | "fail";
}

export interface AccountCaptureState {
  clipMode: ClipMode;
  workspaceId: string;
  notebookId: string;
  notebookLabel: string;
  imageMode: "skip" | "link" | "inline";
  outputFormat: "markdown" | "html";
  isPinned: boolean;
}

const DEFAULTS: NowenClipperConfig = {
  serverUrl: "",
  username: "",
  userId: "",
  token: "",
  displayName: "",
  defaultNotebook: "Web 剪藏",
  defaultTags: "",
  imageMode: "inline",
  includeSource: true,
  outputFormat: "markdown",
  quickCapture: false,
  quickCaptureMode: "article",
  lazyLoadScroll: true,
  maxImageCount: 120,
  maxSingleImageBytes: 8 * 1024 * 1024,
  maxTotalImageBytes: 60 * 1024 * 1024,
  imageTimeoutMs: 10_000,

  aiEnhanceEnabled: false,
  aiEnhanceTasks: {
    summary: true,
    tags: true,
    outline: false,
    title: false,
    highlight: false,
    translation: false,
  },
  aiEnhanceMode: "prepend",
  aiEnhanceLanguage: "zh-CN",
  aiCustomInstruction: "",
  aiMaxInputChars: 6000,
  aiFailureStrategy: "fallback",
};

const DEFAULT_ACCOUNT_STATE: AccountCaptureState = {
  clipMode: "article",
  workspaceId: "personal",
  notebookId: "",
  notebookLabel: "",
  imageMode: "inline",
  outputFormat: "markdown",
  isPinned: false,
};

const CONFIG_KEY = "nowenClipperConfig";
const ACCOUNT_STATE_KEY = "nowenClipperAccountStateV1";

export async function getConfig(): Promise<NowenClipperConfig> {
  const store = chrome.storage.sync || chrome.storage.local;
  const data = (await store.get(CONFIG_KEY)) as Record<string, unknown>;
  const raw = (data[CONFIG_KEY] || {}) as Partial<NowenClipperConfig>;
  const merged = { ...DEFAULTS, ...raw } as NowenClipperConfig;
  if (raw.aiEnhanceTasks) {
    merged.aiEnhanceTasks = { ...DEFAULTS.aiEnhanceTasks, ...raw.aiEnhanceTasks };
  }
  return merged;
}

export async function setConfig(patch: Partial<NowenClipperConfig>): Promise<NowenClipperConfig> {
  const current = await getConfig();
  const merged = {
    ...current,
    ...patch,
    aiEnhanceTasks: patch.aiEnhanceTasks
      ? { ...current.aiEnhanceTasks, ...patch.aiEnhanceTasks }
      : current.aiEnhanceTasks,
  } as NowenClipperConfig;
  const store = chrome.storage.sync || chrome.storage.local;
  await store.set({ [CONFIG_KEY]: merged });
  return merged;
}

export function isConfigured(cfg: NowenClipperConfig): boolean {
  return !!cfg.serverUrl && !!cfg.token;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function getAccountScope(cfg: Pick<NowenClipperConfig, "serverUrl" | "userId" | "username">): string {
  const server = normalizeBaseUrl(cfg.serverUrl).toLowerCase();
  const identity = (cfg.userId || cfg.username || "anonymous").trim().toLowerCase();
  return `${encodeURIComponent(server)}::${encodeURIComponent(identity)}`;
}

export async function getAccountState(cfg: NowenClipperConfig): Promise<AccountCaptureState> {
  const data = (await chrome.storage.local.get(ACCOUNT_STATE_KEY)) as Record<string, unknown>;
  const all = (data[ACCOUNT_STATE_KEY] || {}) as Record<string, Partial<AccountCaptureState>>;
  const raw = all[getAccountScope(cfg)] || {};
  return {
    ...DEFAULT_ACCOUNT_STATE,
    imageMode: cfg.imageMode,
    outputFormat: cfg.outputFormat,
    ...raw,
  };
}

export async function setAccountState(
  cfg: NowenClipperConfig,
  patch: Partial<AccountCaptureState>,
): Promise<AccountCaptureState> {
  const data = (await chrome.storage.local.get(ACCOUNT_STATE_KEY)) as Record<string, unknown>;
  const all = (data[ACCOUNT_STATE_KEY] || {}) as Record<string, Partial<AccountCaptureState>>;
  const scope = getAccountScope(cfg);
  const current = {
    ...DEFAULT_ACCOUNT_STATE,
    imageMode: cfg.imageMode,
    outputFormat: cfg.outputFormat,
    ...(all[scope] || {}),
  } as AccountCaptureState;
  const next = { ...current, ...patch } as AccountCaptureState;
  await chrome.storage.local.set({ [ACCOUNT_STATE_KEY]: { ...all, [scope]: next } });
  return next;
}

/** 仅恢复当前账号的捕捉偏好，不影响其它账号和登录凭据。 */
export async function resetAccountState(cfg: NowenClipperConfig): Promise<AccountCaptureState> {
  const data = (await chrome.storage.local.get(ACCOUNT_STATE_KEY)) as Record<string, unknown>;
  const all = (data[ACCOUNT_STATE_KEY] || {}) as Record<string, Partial<AccountCaptureState>>;
  delete all[getAccountScope(cfg)];
  await chrome.storage.local.set({ [ACCOUNT_STATE_KEY]: all });
  return { ...DEFAULT_ACCOUNT_STATE, imageMode: cfg.imageMode, outputFormat: cfg.outputFormat };
}
