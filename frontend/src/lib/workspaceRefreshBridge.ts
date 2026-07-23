import { realtime } from "@/lib/realtime";
import {
  SYNC_SNAPSHOT_APPLIED_EVENT,
  syncNow,
} from "@/lib/syncEngine";

const INSTALL_KEY = "__NOWEN_WORKSPACE_REFRESH_BRIDGE__" as const;
const BUTTON_ATTRIBUTE = "data-nowen-workspace-refresh";
const AUTO_REFRESH_COOLDOWN_MS = 4_000;
const BACKGROUND_REFRESH_MIN_MS = 800;
const DESKTOP_POLL_INTERVAL_MS = 30_000;

type BridgeWindow = Window & typeof globalThis & {
  [INSTALL_KEY]?: () => void;
};

type RefreshResult = Awaited<ReturnType<typeof syncNow>>;

type RefreshReason =
  | "manual"
  | "window-focus"
  | "visibility"
  | "online"
  | "pageshow"
  | "poll"
  | "sync-snapshot";

let refreshPromise: Promise<RefreshResult> | null = null;
let lastAutomaticRefreshAt = 0;
let lastSnapshotAnnouncementAt = 0;
let backgroundedAt = 0;
let refreshTimer: number | null = null;
let pollTimer: number | null = null;
let mutationFrame = 0;

function isMainAppRoute(): boolean {
  if (typeof window === "undefined") return false;
  return !/^\/(?:share|public|notebook-share|login)(?:\/|$)/.test(window.location.pathname);
}

function isAuthenticated(): boolean {
  try {
    return !!localStorage.getItem("nowen-token");
  } catch {
    return false;
  }
}

function isDesktopClient(): boolean {
  return !!(window as unknown as { nowenDesktop?: { isDesktop?: boolean } }).nowenDesktop?.isDesktop;
}

function resolveCopy() {
  const language = document.documentElement.lang || navigator.language || "zh-CN";
  const chinese = language.toLowerCase().startsWith("zh");
  return chinese
    ? {
        title: "刷新当前空间",
        success: "已刷新当前空间",
        failed: "刷新失败，请检查网络后重试",
      }
    : {
        title: "Refresh current space",
        success: "Current space refreshed",
        failed: "Refresh failed. Check the connection and try again.",
      };
}

function emitCollectionRefresh(reason: RefreshReason): void {
  // NoteList already owns the authoritative filtered-list reload logic. Reuse its
  // existing realtime invalidation path instead of duplicating view/search/tag
  // query construction in this process-wide bridge.
  const emit = (realtime as unknown as { emit?: (type: string, payload: unknown) => void }).emit;
  if (typeof emit === "function") {
    emit.call(realtime, "notes:imported", { reason, source: "workspace-refresh-bridge" });
  }

  window.dispatchEvent(new CustomEvent("nowen:workspace-refresh-applied", {
    detail: { reason, at: Date.now() },
  }));
}

function setButtonsBusy(busy: boolean): void {
  document.querySelectorAll<HTMLButtonElement>(`button[${BUTTON_ATTRIBUTE}]`).forEach((button) => {
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
    button.classList.toggle("opacity-60", busy);
    button.classList.toggle("cursor-wait", busy);
    button.querySelector("svg")?.classList.toggle("animate-spin", busy);
  });
}

async function showToast(kind: "success" | "error", message: string): Promise<void> {
  try {
    const { toast } = await import("@/lib/toast");
    if (kind === "success") toast.success(message);
    else toast.error(message);
  } catch {
    // Toast is a progressive enhancement. Refresh must still complete if the
    // notification chunk cannot be loaded.
  }
}

export async function refreshWorkspaceCollections(
  reason: RefreshReason = "manual",
  options: { notify?: boolean; force?: boolean } = {},
): Promise<RefreshResult | null> {
  if (!isMainAppRoute() || !isAuthenticated()) return null;
  if (refreshPromise) return refreshPromise;

  const automatic = reason !== "manual";
  const now = Date.now();
  if (automatic && !options.force && now - lastAutomaticRefreshAt < AUTO_REFRESH_COOLDOWN_MS) {
    return null;
  }
  if (automatic) lastAutomaticRefreshAt = now;

  const copy = resolveCopy();
  setButtonsBusy(true);
  refreshPromise = syncNow()
    .then(async (result) => {
      // syncNow normally dispatches SYNC_SNAPSHOT_APPLIED_EVENT. Keep this direct
      // fallback for older builds and partial hot-reload sessions where the event
      // listener may not have been installed when the snapshot completed.
      if (result.ok && Date.now() - lastSnapshotAnnouncementAt > 500) {
        emitCollectionRefresh(reason);
      }
      if (options.notify) {
        await showToast(result.ok ? "success" : "error", result.ok ? copy.success : (result.error || copy.failed));
      }
      return result;
    })
    .catch(async (error) => {
      if (options.notify) {
        await showToast("error", error instanceof Error ? error.message : copy.failed);
      }
      throw error;
    })
    .finally(() => {
      refreshPromise = null;
      setButtonsBusy(false);
    });

  return refreshPromise;
}

function scheduleAutomaticRefresh(reason: Exclude<RefreshReason, "manual" | "sync-snapshot">, delay = 180): void {
  if (!isMainAppRoute() || !isAuthenticated()) return;
  if (document.visibilityState === "hidden") return;
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshWorkspaceCollections(reason).catch((error) => {
      console.warn(`[workspaceRefreshBridge] ${reason} refresh failed:`, error);
    });
  }, delay);
}

function createRefreshButton(): HTMLButtonElement {
  const button = document.createElement("button");
  const copy = resolveCopy();
  button.type = "button";
  button.setAttribute(BUTTON_ATTRIBUTE, "true");
  button.setAttribute("aria-label", copy.title);
  button.title = copy.title;
  button.className = "p-1.5 rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary transition-colors disabled:pointer-events-none";
  button.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" class="lucide lucide-refresh-cw transition-transform" aria-hidden="true">
      <path d="M21 12a9 9 0 0 1-15.17 6.36L3 21" />
      <path d="M3 21v-6h6" />
      <path d="M3 12a9 9 0 0 1 15.17-6.36L21 3" />
      <path d="M21 3v6h-6" />
    </svg>`;
  button.addEventListener("click", () => {
    void refreshWorkspaceCollections("manual", { notify: true, force: true }).catch((error) => {
      console.warn("[workspaceRefreshBridge] manual refresh failed:", error);
    });
  });
  return button;
}

function mountDesktopRefreshButton(): void {
  // Sidebar's notebook sort action is the stable desktop anchor. Keep refresh
  // with the notebook controls instead of the global panel-collapse control.
  document.querySelectorAll<HTMLButtonElement>("button[data-nowen-notebook-sort]").forEach((sortButton) => {
    const toolbar = sortButton.parentElement;
    if (!toolbar) return;
    if (toolbar.querySelector(`button[${BUTTON_ATTRIBUTE}]`)) return;
    toolbar.insertBefore(createRefreshButton(), sortButton);
  });
}

export function installWorkspaceRefreshBridge(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const bridgeWindow = window as BridgeWindow;
  if (bridgeWindow[INSTALL_KEY]) return;

  const scheduleMount = () => {
    if (mutationFrame) return;
    mutationFrame = window.requestAnimationFrame(() => {
      mutationFrame = 0;
      mountDesktopRefreshButton();
    });
  };

  const onSnapshotApplied = () => {
    lastSnapshotAnnouncementAt = Date.now();
    emitCollectionRefresh("sync-snapshot");
  };
  const onBlur = () => {
    backgroundedAt = Date.now();
  };
  const onFocus = () => {
    if (backgroundedAt && Date.now() - backgroundedAt >= BACKGROUND_REFRESH_MIN_MS) {
      scheduleAutomaticRefresh("window-focus");
    }
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      backgroundedAt = Date.now();
      return;
    }
    if (backgroundedAt && Date.now() - backgroundedAt >= BACKGROUND_REFRESH_MIN_MS) {
      scheduleAutomaticRefresh("visibility");
    }
  };
  const onOnline = () => scheduleAutomaticRefresh("online", 60);
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) scheduleAutomaticRefresh("pageshow", 60);
  };

  mountDesktopRefreshButton();
  const observer = new MutationObserver(scheduleMount);
  observer.observe(document.body, { childList: true, subtree: true });

  // Electron/desktop keeps polling only while visible. This covers MCP/CLI writes
  // from older servers that do not yet broadcast note creation events, while the
  // focus/visibility hooks provide an immediate catch-up after background use.
  if (isDesktopClient()) {
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") scheduleAutomaticRefresh("poll", 0);
    }, DESKTOP_POLL_INTERVAL_MS);
  }

  window.addEventListener(SYNC_SNAPSHOT_APPLIED_EVENT, onSnapshotApplied);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onOnline);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibilityChange);

  bridgeWindow[INSTALL_KEY] = () => {
    observer.disconnect();
    if (mutationFrame) window.cancelAnimationFrame(mutationFrame);
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    if (pollTimer !== null) window.clearInterval(pollTimer);
    window.removeEventListener(SYNC_SNAPSHOT_APPLIED_EVENT, onSnapshotApplied);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.querySelectorAll(`button[${BUTTON_ATTRIBUTE}]`).forEach((button) => button.remove());
    delete bridgeWindow[INSTALL_KEY];
  };
}

installWorkspaceRefreshBridge();
