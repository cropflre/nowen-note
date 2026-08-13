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

const pendingOriginalFiles = new Map<string, File[]>();

function mediaFileIdentity(file: File | Blob): string {
  const candidate = file as File;
  // DataTransfer 重新包装 File 时，部分 Android WebView 可能重写 type / lastModified。
  // name + 实际字节数在这条链路里更稳定；同名同大小重复选择由下面的数组队列区分。
  return [
    candidate.name || "",
    Number.isFinite(file.size) ? file.size : 0,
  ].join("\u0000");
}

/**
 * 移动端媒体面板会把相册返回的 File 放进 DataTransfer，再通过 drop 复用编辑器
 * 已有上传链路。部分 Android WebView 会在这个过程中生成新的 File 包装对象，
 * 导致上传生命周期事件与面板队列使用的对象引用不一致。
 *
 * 在 dispatch 前按文件元数据保存原对象；真正开始上传时消费对应原对象，保证
 * 等待 / 上传中 / 成功 / 失败状态仍能精确回写到选择面板。数组队列同时支持
 * 用户重复选择同一个文件。
 */
export function rememberMediaUploadDispatchFiles(files: readonly File[]): void {
  for (const file of files) {
    const key = mediaFileIdentity(file);
    const queue = pendingOriginalFiles.get(key) || [];
    queue.push(file);
    pendingOriginalFiles.set(key, queue);
  }

  // 这里只保存一次编辑会话里尚未被消费的对象；异常 drop 不应让 Map 无限增长。
  if (pendingOriginalFiles.size > 100) {
    const overflow = pendingOriginalFiles.size - 100;
    let removed = 0;
    for (const key of pendingOriginalFiles.keys()) {
      pendingOriginalFiles.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }
}

export function resolveMediaUploadLifecycleFile(file: File | Blob): File | Blob {
  const key = mediaFileIdentity(file);
  const queue = pendingOriginalFiles.get(key);
  if (!queue?.length) return file;

  const original = queue.shift() || file;
  if (queue.length === 0) pendingOriginalFiles.delete(key);
  return original;
}

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
