import type { ViewMode } from "@/types";

export const MOBILE_LITE_MODE_STORAGE_KEY = "nowen.mobileLiteMode.enabled.v1";
export const MOBILE_LITE_MODE_CHANGED_EVENT = "nowen:mobile-lite-mode-changed";
export const MOBILE_LITE_MEDIA_QUERY = "(max-width: 767px)";

/** 预留未来扩展：底部栏可自定义的快捷模块槽位类型 */
export type MobileLitePinnedShortcutId = "tasks" | "diary" | "mindmaps" | "files" | "ai-chat" | "favorites" | null;
export const MOBILE_LITE_PINNED_SHORTCUT_STORAGE_KEY = "nowen.mobileLiteMode.pinnedShortcut.v1";

/** 精简模式壳层与 NoteList 之间的轻量事件通道，避免污染全局 AppContext */
export const MOBILE_LITE_OPEN_DIRECTORY_EVENT = "nowen:mobile-lite-open-directory";
export const MOBILE_LITE_OPEN_SEARCH_EVENT = "nowen:mobile-lite-open-search";
export const MOBILE_LITE_CLOSE_SEARCH_EVENT = "nowen:mobile-lite-close-search";
export const MOBILE_LITE_SEARCH_FOCUS_CHANGED_EVENT = "nowen:mobile-lite-search-focus-changed";
export const MOBILE_LITE_SCROLL_LIST_TOP_EVENT = "nowen:mobile-lite-scroll-list-top";

const NOTE_WORKSPACE_VIEW_MODES = new Set<ViewMode>([
  "all",
  "notebook",
  "favorites",
  "tag",
  "search",
]);

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadMobileLiteMode(): boolean {
  try {
    return storage()?.getItem(MOBILE_LITE_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveMobileLiteMode(enabled: boolean): void {
  try {
    storage()?.setItem(MOBILE_LITE_MODE_STORAGE_KEY, String(enabled));
  } catch {
    // 存储不可用时，当前会话内 React 状态仍可立即切换。
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MOBILE_LITE_MODE_CHANGED_EVENT, { detail: { enabled } }));
  }
}

export function isMobileLiteViewport(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia(MOBILE_LITE_MEDIA_QUERY).matches;
    }
  } catch {
    // 回退至 innerWidth 判断
  }
  return Number.isFinite(window.innerWidth) && window.innerWidth < 768;
}

export function isNoteWorkspaceViewMode(mode: ViewMode): boolean {
  return NOTE_WORKSPACE_VIEW_MODES.has(mode);
}

export interface LiteQuickCreateTargetResult {
  kind: "notebook" | "create-default-local" | "locked" | "no-notebook";
  notebookId?: string;
}

/**
 * 为精简模式「+ 新建」按钮解析一键新建的目标笔记本：
 *   1. 当前选中的笔记本有效且未锁定 → 直接落入当前目录；
 *   2. 否则挑选第一个未锁定且具备创建能力的笔记本；
 *   3. 若所有笔记本均已锁定 → 返回 "locked"（不绕过密码保护）；
 *   4. 若当前空间尚无笔记本 → 本地模式自动建默认笔记本，云端模式提示先建目录。
 */
export interface LiteQuickCreateNotebookCandidate {
  id: string;
  isPasswordProtected?: number | boolean;
}

export function resolveLiteQuickCreateTarget({
  selectedNotebookId,
  notebooks,
  lockedNotebookIds,
  isLocalMode,
}: {
  selectedNotebookId: string | null;
  notebooks: LiteQuickCreateNotebookCandidate[];
  lockedNotebookIds?: Set<string>;
  isLocalMode: boolean;
}): LiteQuickCreateTargetResult {
  if (notebooks.length === 0) {
    return isLocalMode ? { kind: "create-default-local" } : { kind: "no-notebook" };
  }

  const isLocked = (nb: LiteQuickCreateNotebookCandidate) =>
    Boolean(lockedNotebookIds?.has(nb.id))
    || (Boolean(nb.isPasswordProtected) && lockedNotebookIds === undefined);

  if (selectedNotebookId) {
    const selected = notebooks.find((nb) => nb.id === selectedNotebookId);
    if (selected) {
      if (isLocked(selected)) {
        return { kind: "locked", notebookId: selected.id };
      }
      return { kind: "notebook", notebookId: selected.id };
    }
  }

  const firstUnlocked = notebooks.find((nb) => !isLocked(nb));
  if (firstUnlocked) {
    return { kind: "notebook", notebookId: firstUnlocked.id };
  }

  return { kind: "locked", notebookId: notebooks[0]?.id };
}
