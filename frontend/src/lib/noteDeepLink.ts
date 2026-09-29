import {
  APP_PATH_CHANGED_EVENT,
  buildAppPathUrl,
  pushAppPathState,
  replaceAppPathState,
  resolveCurrentAppPathname,
} from "@/lib/appPathNavigation";

const NOTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NoteAppRoute {
  matched: boolean;
  noteId: string | null;
}

export function isNoteId(value: string | null | undefined): value is string {
  return typeof value === "string" && NOTE_ID_RE.test(value);
}

export function parseNoteAppPath(pathname: string): NoteAppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const match = normalized.match(/^\/notes\/([^/]+)$/i);
  if (!match) return { matched: false, noteId: null };

  let candidate = match[1];
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return { matched: false, noteId: null };
  }

  return isNoteId(candidate)
    ? { matched: true, noteId: candidate }
    : { matched: false, noteId: null };
}

export function getCurrentNoteAppRoute(): NoteAppRoute {
  return parseNoteAppPath(resolveCurrentAppPathname());
}

export function subscribeNoteAppPath(listener: () => void): () => void {
  window.addEventListener(APP_PATH_CHANGED_EVENT, listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener(APP_PATH_CHANGED_EVENT, listener);
    window.removeEventListener("popstate", listener);
  };
}

export function buildNoteAppPath(noteId: string): string {
  return isNoteId(noteId)
    ? `/notes/${encodeURIComponent(noteId)}`
    : "/";
}

export function pushNoteAppPath(noteId: string): void {
  pushAppPathState(buildNoteAppPath(noteId));
}

export function replaceNoteAppPath(noteId: string): void {
  replaceAppPathState(buildNoteAppPath(noteId));
}

export function buildNoteDeepLinkUrl(
  noteId: string,
  currentHref: string = window.location.href,
): string {
  const routed = buildAppPathUrl(buildNoteAppPath(noteId), currentHref);
  return new URL(routed, currentHref).toString();
}
