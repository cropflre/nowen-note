import type { AIEnhanceMode, AIEnhanceTasks, ClipMode } from "./protocol";

export interface NowenClipperConfig {
  serverUrl: string;
  username: string;
  /** 登录用户稳定 id，用于跨账号隔离最近选择。老配置为空时回退 username。 */
  userId: string;
  token: string;
  /** 30 天会话刷新凭据；仅用于访问令牌过期后的自动续期。 */
  refreshToken: string;
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
  refreshToken: "",
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

/**
 * 0.2.0 升级窗口：旧 token 可能尚未通过 /api/me 回填 userId，最初几次选择会按 username 保存。
 * 回填稳定 userId 后，从 username scope 读取并迁移，避免用户误以为“记住上次选择”失效。
 */
function getLegacyUsernameScope(cfg: Pick<NowenClipperConfig, "serverUrl" | "username">): string | null {
  const username = cfg.username.trim().toLowerCase();
  if (!username) return null;
  const server = normalizeBaseUrl(cfg.serverUrl).toLowerCase();
  return `${encodeURIComponent(server)}::${encodeURIComponent(username)}`;
}

function readScopedState(
  all: Record<string, Partial<AccountCaptureState>>,
  cfg: NowenClipperConfig,
): Partial<AccountCaptureState> {
  const current = all[getAccountScope(cfg)];
  if (current) return current;
  if (!cfg.userId) return {};
  const legacyScope = getLegacyUsernameScope(cfg);
  return legacyScope ? all[legacyScope] || {} : {};
}

export async function getAccountState(cfg: NowenClipperConfig): Promise<AccountCaptureState> {
  const data = (await chrome.storage.local.get(ACCOUNT_STATE_KEY)) as Record<string, unknown>;
  const all = (data[ACCOUNT_STATE_KEY] || {}) as Record<string, Partial<AccountCaptureState>>;
  const raw = readScopedState(all, cfg);
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
    ...readScopedState(all, cfg),
  } as AccountCaptureState;
  const next = { ...current, ...patch } as AccountCaptureState;
  const nextAll = { ...all, [scope]: next };

  const legacyScope = cfg.userId ? getLegacyUsernameScope(cfg) : null;
  if (legacyScope && legacyScope !== scope) delete nextAll[legacyScope];

  await chrome.storage.local.set({ [ACCOUNT_STATE_KEY]: nextAll });
  return next;
}

/** 仅恢复当前账号的捕捉偏好，不影响其它账号和登录凭据。 */
export async function resetAccountState(cfg: NowenClipperConfig): Promise<AccountCaptureState> {
  const data = (await chrome.storage.local.get(ACCOUNT_STATE_KEY)) as Record<string, unknown>;
  const all = (data[ACCOUNT_STATE_KEY] || {}) as Record<string, Partial<AccountCaptureState>>;
  delete all[getAccountScope(cfg)];
  const legacyScope = getLegacyUsernameScope(cfg);
  if (legacyScope) delete all[legacyScope];
  await chrome.storage.local.set({ [ACCOUNT_STATE_KEY]: all });
  return { ...DEFAULT_ACCOUNT_STATE, imageMode: cfg.imageMode, outputFormat: cfg.outputFormat };
}
