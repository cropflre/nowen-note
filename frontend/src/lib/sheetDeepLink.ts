import {
  APP_PATH_CHANGED_EVENT,
  pushAppPathState,
  replaceAppPathState,
  resolveCurrentAppPathname,
} from "@/lib/appPathNavigation";

const SHEET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SheetAppRoute { matched: boolean; sheetId: string | null }

export function parseSheetAppPath(pathname: string): SheetAppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const match = normalized.match(/^\/sheets\/([^/]+)$/i);
  if (!match) return { matched: false, sheetId: null };
  let candidate = match[1];
  try { candidate = decodeURIComponent(candidate); } catch { return { matched: false, sheetId: null }; }
  return SHEET_ID_RE.test(candidate) ? { matched: true, sheetId: candidate } : { matched: false, sheetId: null };
}

export function getCurrentSheetAppRoute(): SheetAppRoute {
  return parseSheetAppPath(resolveCurrentAppPathname());
}

export function subscribeSheetAppPath(listener: () => void): () => void {
  window.addEventListener(APP_PATH_CHANGED_EVENT, listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener(APP_PATH_CHANGED_EVENT, listener);
    window.removeEventListener("popstate", listener);
  };
}

export function pushSheetAppPath(sheetId: string): void {
  pushAppPathState(`/sheets/${encodeURIComponent(sheetId)}`);
}

export function replaceSheetAppPath(sheetId: string): void {
  replaceAppPathState(`/sheets/${encodeURIComponent(sheetId)}`);
}
