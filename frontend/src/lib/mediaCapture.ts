export type CameraCaptureErrorCode =
  | "unsupported"
  | "permission-denied"
  | "not-found"
  | "not-readable"
  | "overconstrained"
  | "capture-failed"
  | "unknown";

export interface CameraCaptureErrorInfo {
  code: CameraCaptureErrorCode;
  title: string;
  message: string;
}

export interface OpenCameraOptions {
  deviceId?: string | null;
  facingMode?: "user" | "environment";
}

function isNativeCapacitorRuntime(): boolean {
  try {
    return Boolean((window as any)?.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

function isMobileBrowserUserAgent(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

/**
 * Decide whether Nowen should replace input[capture] with its managed camera UI.
 *
 * Native Capacitor and mobile browsers keep their mature platform capture flow.
 * Desktop/Electron/Windows-tablet style environments use getUserMedia instead,
 * because Chromium on Windows is allowed to ignore input[capture] and open a file picker.
 */
export function shouldUseManagedPhotoCapture(input: HTMLInputElement): boolean {
  if (typeof window === "undefined") return false;
  if (input.type !== "file") return false;
  if (!input.hasAttribute("capture")) return false;
  const accept = (input.accept || "").toLowerCase();
  if (!accept.includes("image")) return false;
  if (accept.includes("video") && !accept.includes("image")) return false;
  if (input.dataset.nowenCameraFallback === "1") return false;
  if (isNativeCapacitorRuntime()) return false;

  const desktopRuntime = Boolean((window as any)?.nowenDesktop?.isDesktop);
  if (desktopRuntime) return true;

  // Preserve iOS/Android browser capture semantics. Desktop browsers, including
  // Windows tablets reporting a coarse pointer, use the managed camera capability.
  return !isMobileBrowserUserAgent();
}

export function canOpenManagedCamera(): boolean {
  return typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices)
    && typeof navigator.mediaDevices.getUserMedia === "function";
}

export async function openCameraStream(options: OpenCameraOptions = {}): Promise<MediaStream> {
  if (!canOpenManagedCamera()) {
    throw Object.assign(new Error("Camera API unavailable"), { name: "NotSupportedError" });
  }

  const video: MediaTrackConstraints = options.deviceId
    ? {
        deviceId: { exact: options.deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      }
    : {
        facingMode: { ideal: options.facingMode || "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      };

  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "videoinput");
}

export function stopCameraStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* best effort cleanup */ }
  }
}

function photoFilename(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    "nowen-photo-",
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    ".jpg",
  ].join("");
}

export async function capturePhotoToFile(
  video: HTMLVideoElement,
  options: { quality?: number; filename?: string } = {},
): Promise<File> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error("Camera frame is not ready");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(video, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("Failed to encode photo")),
      "image/jpeg",
      options.quality ?? 0.92,
    );
  });

  return new File([blob], options.filename || photoFilename(), {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

export function describeCameraError(error: unknown): CameraCaptureErrorInfo {
  const name = String((error as { name?: unknown })?.name || "");
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        code: "permission-denied",
        title: "无法使用摄像头",
        message: "摄像头权限被拒绝。请在系统或浏览器权限设置中允许 Nowen Note 使用摄像头，然后重试。",
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return {
        code: "not-found",
        title: "未找到摄像头",
        message: "当前设备没有可用摄像头，或摄像头未被系统识别。",
      };
    case "NotReadableError":
    case "TrackStartError":
      return {
        code: "not-readable",
        title: "摄像头暂时不可用",
        message: "摄像头可能正被其它应用占用。关闭其它相机应用后再试。",
      };
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return {
        code: "overconstrained",
        title: "摄像头不支持当前条件",
        message: "无法按当前摄像头条件启动预览，请切换摄像头或重试。",
      };
    case "NotSupportedError":
      return {
        code: "unsupported",
        title: "当前环境不支持直接拍照",
        message: "浏览器未提供摄像头 API，或当前页面不是安全上下文。你仍可以从文件中选择图片。",
      };
    default:
      return {
        code: "unknown",
        title: "无法打开摄像头",
        message: "摄像头启动失败，请重试；如果问题持续，可以改用“选择图片文件”。",
      };
  }
}
