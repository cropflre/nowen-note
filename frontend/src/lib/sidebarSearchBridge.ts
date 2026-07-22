export const SIDEBAR_SEARCH_CHANGE_EVENT = "nowen:sidebar-search-change";
export const SIDEBAR_SEARCH_SYNC_EVENT = "nowen:sidebar-search-sync";
export const SIDEBAR_SEARCH_PENDING_EVENT = "nowen:sidebar-search-pending";

export interface SidebarSearchEventDetail {
  value: string;
}

export interface SidebarSearchPendingEventDetail {
  pending: boolean;
}

let currentSidebarSearchValue = "";
let currentSidebarSearchPending = false;

export const SEARCH_SPINNER_STYLE_ID = "nowen-sidebar-search-spinner-style";

/**
 * Search spinners need an explicit animation fallback. Some production CSS orders leave the
 * Tailwind animate-spin utility ineffective, and the sidebar icon additionally needs to retain
 * translateY(-50%) while rotating. Keep both variants in one small runtime style sheet.
 */
export function ensureSearchSpinnerStyle(): void {
  if (typeof document === "undefined" || document.getElementById(SEARCH_SPINNER_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = SEARCH_SPINNER_STYLE_ID;
  style.textContent = `
@keyframes nowen-sidebar-search-spin {
  from { transform: translateY(-50%) rotate(0deg); }
  to { transform: translateY(-50%) rotate(360deg); }
}

@keyframes nowen-search-center-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

[data-sidebar-search-loading] {
  animation: nowen-sidebar-search-spin 0.8s linear infinite !important;
  transform-origin: center;
  will-change: transform;
}

[data-swipe-blocker="search-center"] .animate-spin {
  animation: nowen-search-center-spin 0.8s linear infinite !important;
  transform-origin: center;
  will-change: transform;
}
`;
  document.head.appendChild(style);
}

// Install at module load so the full-text page also works when it is opened and edited directly,
// without first passing through the buffered sidebar search input.
ensureSearchSpinnerStyle();

export function getCurrentSidebarSearchValue(): string {
  return currentSidebarSearchValue;
}

export function getCurrentSidebarSearchPending(): boolean {
  return currentSidebarSearchPending;
}

export function normalizeSidebarSearchValue(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const value = (detail as Partial<SidebarSearchEventDetail>).value;
  return typeof value === "string" ? value : null;
}

export function normalizeSidebarSearchPending(detail: unknown): boolean | null {
  if (!detail || typeof detail !== "object") return null;
  const pending = (detail as Partial<SidebarSearchPendingEventDetail>).pending;
  return typeof pending === "boolean" ? pending : null;
}

export function emitSidebarSearchChange(value: string): void {
  currentSidebarSearchValue = value;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SidebarSearchEventDetail>(SIDEBAR_SEARCH_CHANGE_EVENT, {
    detail: { value },
  }));
}

export function emitSidebarSearchSync(value: string): void {
  currentSidebarSearchValue = value;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SidebarSearchEventDetail>(SIDEBAR_SEARCH_SYNC_EVENT, {
    detail: { value },
  }));
}

export function emitSidebarSearchPending(pending: boolean): void {
  currentSidebarSearchPending = pending;
  if (pending) ensureSearchSpinnerStyle();
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SidebarSearchPendingEventDetail>(SIDEBAR_SEARCH_PENDING_EVENT, {
    detail: { pending },
  }));
}
