import { isVideoFile } from "@/lib/mediaUploadService";

export type MediaKind = "image" | "video";
export type MediaItemStatus = "ready" | "uploading" | "success" | "error";

export interface PreparedMediaFile {
  id: string;
  file: File;
  kind: MediaKind | null;
  status: MediaItemStatus;
  error?: string;
  warning?: string;
}

export const MAX_MOBILE_MEDIA_ITEMS = 30;
export const LARGE_MEDIA_WARNING_BYTES = 100 * 1024 * 1024;
export const MAX_MOBILE_MEDIA_FILE_BYTES = 1024 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "svg",
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function classifyMediaFile(file: Pick<File, "name" | "type">): MediaKind | null {
  const mime = String(file.type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (isVideoFile(file)) return "video";
  return IMAGE_EXTENSIONS.has(extensionOf(file.name || "")) ? "image" : null;
}

export function prepareMediaFiles(files: Iterable<File>): PreparedMediaFile[] {
  return Array.from(files).slice(0, MAX_MOBILE_MEDIA_ITEMS).map((file, index) => {
    const kind = classifyMediaFile(file);
    let error: string | undefined;
    let warning: string | undefined;

    if (!kind) error = "仅支持图片或视频";
    else if (file.size <= 0) error = "文件为空或来源应用未授予读取权限";
    else if (file.size > MAX_MOBILE_MEDIA_FILE_BYTES) error = "单个媒体文件不能超过 1GB";
    else if (file.size > LARGE_MEDIA_WARNING_BYTES) warning = "大文件上传可能需要较长时间";

    return {
      id: `${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      kind,
      status: error ? "error" : "ready",
      error,
      warning,
    };
  });
}

export function formatMediaBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatMediaDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function findActiveEditorDropTarget(root: ParentNode = document): HTMLElement | null {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active instanceof HTMLElement) {
    const activeEditor = active.closest<HTMLElement>(
      '.ProseMirror[contenteditable="true"], .cm-content[contenteditable="true"]',
    );
    if (activeEditor) return activeEditor;
  }
  return root.querySelector<HTMLElement>(
    '.ProseMirror[contenteditable="true"], .cm-content[contenteditable="true"]',
  );
}

export function getEditorDropCoordinates(
  target: HTMLElement,
  fallbackElement?: HTMLElement | null,
): { clientX: number; clientY: number } {
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    if (target.contains(range.commonAncestorContainer)) {
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height) {
        return { clientX: rect.left + Math.max(1, rect.width / 2), clientY: rect.bottom || rect.top };
      }
    }
  }

  const rect = (fallbackElement || target).getBoundingClientRect();
  return {
    clientX: Math.max(rect.left + 8, Math.min(rect.right - 8, rect.left + rect.width / 2)),
    clientY: Math.max(rect.top + 8, Math.min(rect.bottom - 2, rect.top + rect.height / 2)),
  };
}

function makeDataTransfer(files: File[]): DataTransfer | null {
  try {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    return transfer;
  } catch {
    return null;
  }
}

/** Dispatch files through the editors' existing, battle-tested multi-file drop pipelines. */
export function dispatchMediaFilesToEditor(
  files: File[],
  options?: { target?: HTMLElement | null; near?: HTMLElement | null },
): boolean {
  if (!files.length || typeof document === "undefined") return false;
  const target = options?.target || findActiveEditorDropTarget(document);
  if (!target) return false;
  const coords = getEditorDropCoordinates(target, options?.near || null);
  const transfer = makeDataTransfer(files);

  let event: Event;
  try {
    event = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: coords.clientX,
      clientY: coords.clientY,
      dataTransfer: transfer || undefined,
    });
  } catch {
    event = new Event("drop", { bubbles: true, cancelable: true });
  }

  if (!transfer) {
    const fallback = {
      files,
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      types: ["Files"],
    };
    Object.defineProperty(event, "dataTransfer", { configurable: true, value: fallback });
  } else if (!(event as DragEvent).dataTransfer) {
    Object.defineProperty(event, "dataTransfer", { configurable: true, value: transfer });
  }

  Object.defineProperty(event, "clientX", { configurable: true, value: coords.clientX });
  Object.defineProperty(event, "clientY", { configurable: true, value: coords.clientY });
  return target.dispatchEvent(event);
}

export function appendDownloadFlag(url: string): string {
  if (!url) return "";
  try {
    const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
    const parsed = new URL(url, base);
    parsed.searchParams.delete("inline");
    parsed.searchParams.set("download", "1");
    return parsed.toString();
  } catch {
    const clean = url.replace(/([?&])inline=1(?:&|$)/, "$1").replace(/[?&]$/, "");
    return `${clean}${clean.includes("?") ? "&" : "?"}download=1`;
  }
}
