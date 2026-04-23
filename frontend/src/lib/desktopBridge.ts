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
  | "menu:zoom-reset";

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
}

export interface OpenFilePayload {
  path: string;
  name: string;
  size: number;
  content: string;
}

interface NowenDesktopAPI {
  on: (channel: string, listener: (payload: unknown) => void) => () => void;
  checkForUpdates: () => Promise<{ ok: boolean; reason?: string; version?: string }>;
  quitAndInstall: () => Promise<{ ok: boolean }>;
  getAppInfo: () => Promise<AppInfo>;
  openLogDir: () => Promise<{ ok: boolean; path: string }>;
  isDesktop: true;
  platform: string;
}

function getBridge(): NowenDesktopAPI | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { nowenDesktop?: NowenDesktopAPI }).nowenDesktop ?? null;
}

export const isDesktop = (): boolean => !!getBridge();

/** 订阅菜单事件，返回反注册函数。非 Electron 环境返回 no-op。 */
export function onMenuAction(
  channel: DesktopMenuChannel,
  handler: () => void
): () => void {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.on(channel, () => handler());
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
