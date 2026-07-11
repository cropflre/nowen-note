export type MediaUploadPhase = "start" | "success" | "error";

export interface MediaUploadLifecycleDetail {
  phase: MediaUploadPhase;
  file: File | Blob;
  filename: string;
  mediaType: "image" | "video";
  result?: unknown;
  error?: string;
}

export const MEDIA_UPLOAD_LIFECYCLE_EVENT = "nowen:media-upload-lifecycle";

export function emitMediaUploadLifecycle(detail: MediaUploadLifecycleDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<MediaUploadLifecycleDetail>(
    MEDIA_UPLOAD_LIFECYCLE_EVENT,
    { detail },
  ));
}

export function listenMediaUploadLifecycle(
  listener: (detail: MediaUploadLifecycleDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<MediaUploadLifecycleDetail>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(MEDIA_UPLOAD_LIFECYCLE_EVENT, handler);
  return () => window.removeEventListener(MEDIA_UPLOAD_LIFECYCLE_EVENT, handler);
}
