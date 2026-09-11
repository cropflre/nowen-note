import { emitMediaUploadLifecycle } from "@/lib/mediaUploadLifecycle";

export interface MediaInsertionResult {
  attachmentId: string;
  url: string;
  previewUrl?: string;
  filename?: string;
}

const pendingChecks = new Map<string, number>();
const CHECK_DELAYS_MS = [0, 40, 100, 180, 320, 550, 900, 1400, 2200];

function markerValues(result: MediaInsertionResult): string[] {
  const values = [result.attachmentId, result.url, result.previewUrl || ""]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  try {
    const parsed = new URL(result.url, typeof window !== "undefined" ? window.location.href : "http://localhost/");
    if (parsed.pathname) values.push(parsed.pathname);
  } catch {
    // Relative/legacy URLs are already covered by their raw value above.
  }
  return Array.from(new Set(values));
}

function elementReferencesMarker(element: Element, markers: string[]): boolean {
  const attrs = ["src", "href", "data-original-url", "data-attachment-id"];
  for (const name of attrs) {
    const value = element.getAttribute(name) || "";
    if (value && markers.some((marker) => value.includes(marker))) return true;
  }
  return false;
}

/**
 * Verify the uploaded attachment has crossed the editor boundary.
 *
 * Tiptap file-video nodes render a <video src=".../attachments/:id?...">. Markdown inserts the
 * persistent attachment URL into the visible CodeMirror content. Checking both keeps this module
 * independent of either editor implementation while still distinguishing "uploaded" from
 * "inserted into the current document".
 */
export function hasCommittedMediaInsertion(
  result: MediaInsertionResult,
  root: ParentNode = document,
): boolean {
  const markers = markerValues(result);
  if (!markers.length) return false;

  const mediaNodes = root.querySelectorAll(
    "video[src], source[src], img[src], a[href], [data-original-url], [data-attachment-id]",
  );
  for (const element of Array.from(mediaNodes)) {
    if (elementReferencesMarker(element, markers)) return true;
  }

  const editors = root.querySelectorAll(".cm-content, .ProseMirror");
  for (const editor of Array.from(editors)) {
    const text = editor.textContent || "";
    if (markers.some((marker) => text.includes(marker))) return true;
    if (editor instanceof HTMLElement) {
      const html = editor.innerHTML || "";
      if (markers.some((marker) => html.includes(marker))) return true;
    }
  }
  return false;
}

function clearPending(key: string): void {
  const timer = pendingChecks.get(key);
  if (timer !== undefined) window.clearTimeout(timer);
  pendingChecks.delete(key);
}

/**
 * Upload completion is intentionally not the final lifecycle success anymore. The caller resumes,
 * inserts the returned result through its existing Tiptap/Markdown path, and this bounded checker
 * confirms the marker appears in the editor before announcing success to MediaExperienceBridge.
 *
 * If insertion never appears, the attachment itself is still preserved and discoverable in the
 * attachment library; the lifecycle reports an actionable error instead of a false success.
 */
export function scheduleMediaInsertionCommit(options: {
  file: File | Blob;
  filename: string;
  result: MediaInsertionResult;
  onSuccess?: () => void;
  onFailure?: () => void;
}): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const key = options.result.attachmentId || options.result.url;
  if (!key) return;
  clearPending(key);

  let index = 0;
  const check = () => {
    if (hasCommittedMediaInsertion(options.result, document)) {
      clearPending(key);
      options.onSuccess?.();
      emitMediaUploadLifecycle({
        phase: "success",
        file: options.file,
        filename: options.filename,
        mediaType: "video",
        result: options.result,
      });
      return;
    }

    index += 1;
    if (index >= CHECK_DELAYS_MS.length) {
      clearPending(key);
      options.onFailure?.();
      emitMediaUploadLifecycle({
        phase: "error",
        file: options.file,
        filename: options.filename,
        mediaType: "video",
        result: options.result,
        error: "视频已上传，但插入正文失败。点击“重试失败项”会复用已上传文件重新插入，也可从附件库手动插入。",
      });
      return;
    }

    const timer = window.setTimeout(check, CHECK_DELAYS_MS[index]);
    pendingChecks.set(key, timer);
  };

  const timer = window.setTimeout(check, CHECK_DELAYS_MS[0]);
  pendingChecks.set(key, timer);
}
