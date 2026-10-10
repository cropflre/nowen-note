import {
  APP_PATH_CHANGED_EVENT,
  buildAppPathUrl,
  pushAppPathState,
  replaceAppPathState,
  resolveCurrentAppPathname,
} from "@/lib/appPathNavigation";

const MAX_NOTE_ID_LENGTH = 512;
// eslint-disable-next-line no-control-regex -- Control characters must be rejected or stripped at this data boundary.
const INVALID_NOTE_ID_CHARS_RE = /[\\/\u0000-\u001f\u007f]/;

export interface NoteAppRoute {
  matched: boolean;
  noteId: string | null;
}

export function isNoteId(value: string | null | undefined): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NOTE_ID_LENGTH) {
    return false;
  }
  // notes.id is an opaque TEXT primary key in the backend. Current data includes UUIDs,
  // deterministic onboarding ids (onboarding-v1-...), and imported/migrated identifiers.
  // Routing must therefore validate path-safety, not impose a UUID-only data model.
  if (value === "." || value === "..") return false;
  return !INVALID_NOTE_ID_CHARS_RE.test(value);
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
