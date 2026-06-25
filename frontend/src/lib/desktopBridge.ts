/**
 * Electron Desktop Bridge
 * -------------------------------------------------------------
 * 通过 preload 注入的 window.nowenDesktop 与主进程通信。
 * Web 端不会有 window.nowenDesktop，这里做了兜底，安全用在 SSR/浏览器环境。
 *
 * 约定的菜单事件：
 *   menu:new-note         新建笔记（等价 Alt+N）
 *   menu:search           搜索笔记（Ctrl/Cmd+F）
 *   menu:open-settings    打开设置（Ctrl/Cmd+,）
 *   menu:toggle-sidebar   切换侧边栏（Ctrl/Cmd+B）
 *   menu:focus-note-list  聚焦笔记列表（Ctrl/Cmd+L）
 *   menu:zoom-in/out/reset 视图缩放
 *
 * 自动更新事件：
 *   updater:status { status, version?, percent?, message? }
 *     status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"
 */

export type DesktopMenuChannel =
  | "menu:new-note"
  | "menu:search"
  | "menu:open-settings"
  | "menu:toggle-sidebar"
  | "menu:focus-note-list"
  | "menu:zoom-in"
  | "menu:zoom-out"
  | "menu:zoom-reset"
  | "menu:format"
  | "dock:new-note"
  | "dock:search";

/** 格式菜单事件负载（menu:format） */
export interface FormatMenuPayload {
  mark?: "bold" | "italic" | "underline" | "strike" | "code";
  node?: "heading" | "paragraph";
  level?: number;
}

/**
 * 编辑器"格式状态"快照（renderer → main，同步系统菜单栏 checked 标记）。
 * null 表示"无可用编辑器"（切到 MD 模式 / 失焦 / 销毁），主进程应清空 checked。
 */
export interface FormatStateSnapshot {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  heading1?: boolean;
  heading2?: boolean;
  heading3?: boolean;
  paragraph?: boolean;
}

export type UpdaterStatus =
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterPayload {
  status: UpdaterStatus;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message?: string;
}

export interface AppInfo {
  version: string;
  name: string;
  platform: string;
  arch: string;
  userData: string;
  logDir: string;
  backendPort: number;
  mode?: "full" | "lite";
  remoteUrl?: string;
  hideMenuBar?: boolean;
}

export interface OpenFilePayload {
  path: string;
  name: string;
  size: number;
  content: string;
}

/** 文件夹同步配置 */
export interface FolderSyncConfig {
  folderId: string;
  folderPath: string;
  targetNotebookId: string | null;
  includeSubfolders: boolean;
  fileTypes: string[];
  enabled: boolean;
  lastSyncedAt: string | null;
  lastScanAt?: string | null;
  lastScanStats?: FolderSyncScanStats | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderSyncScanStats {
  total: number;
  added: number;
  changed: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  errors: number;
  durationMs?: number;
}

export interface FolderSyncScanResult extends FolderSyncScanStats {
  ok: boolean;
  folderId: string;
  scannedAt: string;
  code?: string;
  message?: string;
}

export interface FolderSyncIndexItem {
  relativePath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  status: "new" | "unchanged" | "changed" | "deleted" | "skipped" | "error";
  lastScannedAt: string;
  lastSyncedAt: string | null;
  noteId?: string | null;
  attachmentId?: string | null;
  error?: string;
}

export interface FolderSyncLogItem {
  id: string;
  folderId: string;
  type: string;
  message: string;
  createdAt: string;
  detail?: unknown;
}

export interface FolderSyncUploadCandidate {
  relativePath: string;
  filename: string;
  sha256: string;
  sourcePathHash: string;
  size: number;
  mtimeMs: number;
  ext: string;
  contentText: string | null;
  existingNoteId: string | null;
  skipReason: string | null;
}

export interface FolderSyncPendingUploads {
  ok: boolean;
  folderId: string;
  config: { targetNotebookId: string | null };
  pending: FolderSyncUploadCandidate[];
  error?: string;
}

export interface FolderSyncAPI {
  selectFolder(): Promise<{ cancelled: boolean; path?: string }>;
  getConfigs(): Promise<FolderSyncConfig[]>;
  saveConfig(config: Partial<FolderSyncConfig>): Promise<{ ok: boolean; config: FolderSyncConfig }>;
  removeConfig(folderId: string): Promise<{ ok: boolean }>;
  getLogs(folderId: string): Promise<FolderSyncLogItem[]>;
  runNow(folderId: string): Promise<FolderSyncScanResult>;
  getIndex(folderId: string): Promise<FolderSyncIndexItem[]>;
  getPendingUploads(folderId: string): Promise<FolderSyncPendingUploads>;
  markUploadResult(folderId: string, relativePath: string, result: { success: boolean; noteId?: string; skipped?: boolean; error?: string }): Promise<{ ok: boolean }>;
}

interface NowenDesktopAPI {
  on: (channel: string, listener: (payload: unknown) => void) => () => void;
  checkForUpdates: () => Promise<{ ok: boolean; reason?: string; version?: string }>;
  quitAndInstall: () => Promise<{ ok: boolean }>;
  getAppInfo: () => Promise<AppInfo>;
  openLogDir: () => Promise<{ ok: boolean; path: string }>;
  openDataDir?: () => Promise<{ ok: boolean; path: string }>;
  setHideMenuBar?: (next: boolean) => Promise<{ ok: boolean; hideMenuBar: boolean }>;
  /** 上报格式状态（同步菜单 checked）。preload 中已白名单化，仅 send，无 ack。 */
  sendFormatState?: (state: FormatStateSnapshot | null) => void;
  /** 桌面端模式切换 IPC。旧版本 preload 可能没有，调用方需做兜底。 */
  mode?: {
    switchToLite?: () => Promise<{ ok: boolean }>;
    switchToFull?: () => Promise<{ ok: boolean }>;
    changeServer?: () => Promise<{ ok: boolean }>;
  };
  getLocalAuth?: () => Promise<{ token: string; user: unknown } | null>;
  clearLocalAuth?: () => Promise<{ ok: boolean }>;
  resetLocalAuth?: () => Promise<{ ok: boolean; token?: string; user?: unknown; error?: string }>;
  isDesktop: true;
  platform: string;
  /**
   * 发布渠道（"lite" | "latest"）。由 preload 根据启动参数判定，
   * 与 electron-builder publish.channel 对齐；旧版本 preload 不暴露此字段 → undefined。
   */
  releaseChannel?: "lite" | "latest";
  /** Lite-only 发行版标识（旧版本 preload 可能没有，按 undefined 处理）。 */
  isLiteOnly?: boolean;
  /**
   * 是否 portable / 免安装版（Windows portable target）。
   * portable 包不支持 electron-updater 自更新，UI 应隐藏"检查更新"按钮，
   * 改为引导用户去 GitHub Release 页人工下载新版。
   * 旧版本 preload 不暴露此字段 → undefined（按 false 处理）。
   */
  isPortable?: boolean;
  /** 文件夹同步（Phase B：配置 CRUD；后续扩展扫描/导入）。旧版本 preload 无此字段。 */
  folderSync?: FolderSyncAPI;
}

function getBridge(): NowenDesktopAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { nowenDesktop?: NowenDesktopAPI }).nowenDesktop ?? null;
}

export const isDesktop = (): boolean => !!getBridge();

/**
 * 获取桌面端发布渠道标识：
 *   - "lite"    lite-only 发行版（electron-updater 仅从 latest-lite*.yml 拉取）
 *   - "latest"  默认 full 版
 *   - null      非 Electron 环境 / 旧版本 preload 未暴露 releaseChannel
 *
 * 兜底：若 preload 没注入 releaseChannel，但仍暴露了 isLiteOnly（过渡版本），
 * 从 isLiteOnly 推导一下；否则返回 null。
 */
export function getReleaseChannel(): "lite" | "latest" | null {
  const bridge = getBridge();
  if (!bridge) return null;
  if (bridge.releaseChannel === "lite" || bridge.releaseChannel === "latest") {
    return bridge.releaseChannel;
  }
  if (typeof bridge.isLiteOnly === "boolean") {
    return bridge.isLiteOnly ? "lite" : "latest";
  }
  return null;
}

/**
 * 是否 portable / 免安装版桌面端（Windows portable target）。
 *
 * portable 包**不支持** electron-updater 自更新——autoUpdater.checkForUpdates()
 * 会抛 error。AboutPanel 里据此把"检查桌面端更新"按钮替换成"前往下载页"，
 * 给用户一个明确的人工升级路径，避免静默失败。
 *
 * 旧版本 preload（没注入 isPortable 字段）按 false 处理，行为不变。
 */
export function isPortableDesktop(): boolean {
  const bridge = getBridge();
  return bridge?.isPortable === true;
}

/** 订阅菜单事件，返回反注册函数。非 Electron 环境返回 no-op。 */
export function onMenuAction(
  channel: DesktopMenuChannel,
  handler: (payload?: unknown) => void
): () => void {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.on(channel, (p) => handler(p));
}

/** 订阅格式菜单事件（带 payload） */
export function onFormatMenu(
  handler: (payload: FormatMenuPayload) => void
): () => void {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.on("menu:format", (p) => handler((p as FormatMenuPayload) ?? {}));
}

/** 订阅自动更新事件 */
export function onUpdaterStatus(
  handler: (payload: UpdaterPayload) => void
): () => void {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.on("updater:status", (p) => handler(p as UpdaterPayload));
}

export async function checkForUpdates(): Promise<{ ok: boolean; reason?: string; version?: string }> {
  const bridge = getBridge();
  if (!bridge) return { ok: false, reason: "not-desktop" };
  return bridge.checkForUpdates();
}

export async function quitAndInstall(): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await bridge.quitAndInstall();
}

export async function getAppInfo(): Promise<AppInfo | null> {
  const bridge = getBridge();
  if (!bridge) return null;
  return bridge.getAppInfo();
}

export async function setDesktopHideMenuBar(next: boolean): Promise<{ ok: boolean; hideMenuBar?: boolean; reason?: string }> {
  const bridge = getBridge();
  if (!bridge?.setHideMenuBar) return { ok: false, reason: "not-supported" };
  return bridge.setHideMenuBar(next);
}

/** 切换到桌面端本地 full 模式（由主进程确认、清 storage 并重启）。 */
export async function switchDesktopToFull(): Promise<{ ok: boolean; reason?: string }> {
  const bridge = getBridge();
  if (!bridge?.mode?.switchToFull) return { ok: false, reason: "not-supported" };
  return bridge.mode.switchToFull();
}

/** 切换到桌面端远端 lite 模式（主进程弹出服务器选择窗口）。 */
export async function switchDesktopToLite(): Promise<{ ok: boolean; reason?: string }> {
  const bridge = getBridge();
  if (!bridge?.mode?.switchToLite) return { ok: false, reason: "not-supported" };
  return bridge.mode.switchToLite();
}

/** 更换桌面端 lite 模式下的远端服务器。 */
export async function changeDesktopServer(): Promise<{ ok: boolean; reason?: string }> {
  const bridge = getBridge();
  if (!bridge?.mode?.changeServer) return { ok: false, reason: "not-supported" };
  return bridge.mode.changeServer();
}

/** 订阅文件关联：双击 .md 时触发 */
export function onOpenFile(
  handler: (payload: OpenFilePayload) => void
): () => void {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.on("file:open", (p) => handler(p as OpenFilePayload));
}

/** 打开日志目录（用户反馈问题时附带日志） */
export async function openLogDir(): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await bridge.openLogDir();
}

export async function openDataDir(): Promise<{ ok: boolean; path?: string; reason?: string }> {
  const bridge = getBridge();
  if (!bridge?.openDataDir) return { ok: false, reason: "not-supported" };
  return bridge.openDataDir();
}

export async function resetDesktopLocalAuth(): Promise<{ ok: boolean; token?: string; user?: unknown; error?: string; reason?: string }> {
  const bridge = getBridge();
  if (!bridge?.resetLocalAuth) return { ok: false, reason: "not-supported" };
  return bridge.resetLocalAuth();
}

/**
 * 上报当前编辑器的格式状态，供主进程同步系统菜单栏 checked 标记。
 *
 * 使用约束（调用方职责，不在此函数内做）：
 *   - 节流（建议 100ms）；
 *   - 浅比较去重（只在状态真正变化时调用）。
 *   这两项在 TiptapEditor 的 effect 内实现，此处保持"薄封装"。
 *
 * 非 Electron 环境 / 旧版本 preload（没注入 sendFormatState）自动 no-op。
 */
export function sendFormatState(state: FormatStateSnapshot | null): void {
  const bridge = getBridge();
  bridge?.sendFormatState?.(state);
}
