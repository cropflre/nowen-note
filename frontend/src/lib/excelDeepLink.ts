import {
  APP_PATH_CHANGED_EVENT,
  pushAppPathState,
  replaceAppPathState,
  resolveCurrentAppPathname,
} from "@/lib/appPathNavigation";

const EXCEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExcelAppRoute { matched: boolean; excelId: string | null }

export function parseExcelAppPath(pathname: string): ExcelAppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const match = normalized.match(/^\/excel\/([^/]+)$/i);
  if (!match) return { matched: false, excelId: null };
  let candidate = match[1];
  try { candidate = decodeURIComponent(candidate); } catch { return { matched: false, excelId: null }; }
  return EXCEL_ID_RE.test(candidate) ? { matched: true, excelId: candidate } : { matched: false, excelId: null };
}

export function getCurrentExcelAppRoute(): ExcelAppRoute {
  return parseExcelAppPath(resolveCurrentAppPathname());
}

export function subscribeExcelAppPath(listener: () => void): () => void {
  window.addEventListener(APP_PATH_CHANGED_EVENT, listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener(APP_PATH_CHANGED_EVENT, listener);
    window.removeEventListener("popstate", listener);
  };
}

export function pushExcelAppPath(excelId: string): void {
  pushAppPathState(`/excel/${encodeURIComponent(excelId)}`);
}

export function replaceExcelAppPath(excelId: string): void {
  replaceAppPathState(`/excel/${encodeURIComponent(excelId)}`);
}
