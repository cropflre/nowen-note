export const SIDEBAR_SEARCH_CHANGE_EVENT = "nowen:sidebar-search-change";
export const SIDEBAR_SEARCH_SYNC_EVENT = "nowen:sidebar-search-sync";

export interface SidebarSearchEventDetail {
  value: string;
}

let currentSidebarSearchValue = "";

export function getCurrentSidebarSearchValue(): string {
  return currentSidebarSearchValue;
}

export function normalizeSidebarSearchValue(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const value = (detail as Partial<SidebarSearchEventDetail>).value;
  return typeof value === "string" ? value : null;
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
