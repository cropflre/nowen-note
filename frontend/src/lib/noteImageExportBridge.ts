import { parseServerTime } from "@/lib/dateTime";

export type NoteImageExportFormat = "png" | "jpg" | "svg";
export type NoteImageExportLayout = "auto" | "long" | "pages";
export type NoteImageExportTheme = "current" | "light" | "dark";
export type NoteImageExportDestination = "download" | "gallery" | "files" | "share";

export interface ExportableNoteImageSource {
  id: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NoteImageExportInitialOptions {
  format?: NoteImageExportFormat;
  quality?: number;
  pixelRatio?: number;
  layout?: NoteImageExportLayout;
  theme?: NoteImageExportTheme;
  destination?: NoteImageExportDestination;
}

export interface NoteImageExportRequestDetail {
  requestId: string;
  note: ExportableNoteImageSource;
  options: NoteImageExportInitialOptions;
}

export const NOTE_IMAGE_EXPORT_REQUEST_EVENT = "nowen:note-image-export-request";

const pending = new Map<string, (ok: boolean) => void>();
let sequence = 0;

function createRequestId(): string {
  sequence += 1;
  return `note-image-export-${Date.now()}-${sequence}`;
}

/**
 * Convert backend timestamps to an unambiguous ISO UTC representation before the note
 * enters any PNG/JPG/SVG rendering path.
 *
 * SQLite returns `YYYY-MM-DD HH:mm:ss` without a zone even though the value is UTC.
 * `parseServerTime()` also preserves timestamps that already carry `Z` or an explicit
 * offset, so this normalization cannot apply the user's time-zone offset twice.
 */
export function normalizeNoteImageExportTimestamp(
  value: string | null | undefined,
): string | undefined {
  return parseServerTime(value)?.toISOString();
}

/**
 * Normalize a copy only; never mutate the active note held by the editor/store.
 * Invalid or empty timestamps are omitted so the export metadata cannot render
 * `Invalid Date`.
 */
export function normalizeNoteImageExportSource(
  note: ExportableNoteImageSource,
): ExportableNoteImageSource {
  const normalized = { ...note };
  const createdAt = normalizeNoteImageExportTimestamp(note.createdAt);
  const updatedAt = normalizeNoteImageExportTimestamp(note.updatedAt);

  if (createdAt) normalized.createdAt = createdAt;
  else delete normalized.createdAt;

  if (updatedAt) normalized.updatedAt = updatedAt;
  else delete normalized.updatedAt;

  return normalized;
}

/**
 * Opens the global image-export center and resolves after the user completes or
 * cancels the flow. Existing menu entry points can await this promise without
 * knowing whether the app is running in Web, Electron or Capacitor.
 */
export function requestNoteImageExport(
  note: ExportableNoteImageSource,
  options: NoteImageExportInitialOptions = {},
): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);

  const requestId = createRequestId();
  const exportNote = normalizeNoteImageExportSource(note);
  return new Promise<boolean>((resolve) => {
    pending.set(requestId, resolve);
    window.dispatchEvent(new CustomEvent<NoteImageExportRequestDetail>(
      NOTE_IMAGE_EXPORT_REQUEST_EVENT,
      { detail: { requestId, note: exportNote, options } },
    ));
  });
}

export function settleNoteImageExportRequest(requestId: string, ok: boolean): void {
  const resolve = pending.get(requestId);
  if (!resolve) return;
  pending.delete(requestId);
  resolve(ok);
}

export function cancelAllNoteImageExportRequests(): void {
  for (const resolve of pending.values()) resolve(false);
  pending.clear();
}
