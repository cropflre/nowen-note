export const MOBILE_SYNC_STATUS_CHANGED_EVENT = "nowen:mobile-sync-status-changed";
export const MOBILE_SYNC_SETTINGS_CHANGED_EVENT = "nowen:mobile-sync-settings-changed";
let syncEnabled = false;

export function isMobileSyncEnabled(): boolean { return syncEnabled; }

export function setMobileSyncEnabled(enabled: boolean): void {
  if (syncEnabled === enabled) return;
  syncEnabled = enabled;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MOBILE_SYNC_SETTINGS_CHANGED_EVENT));
  notifyMobileSyncStatusChanged();
}

export function notifyMobileSyncStatusChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MOBILE_SYNC_STATUS_CHANGED_EVENT));
}
