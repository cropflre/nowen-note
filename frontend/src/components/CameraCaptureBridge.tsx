import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Camera,
  Check,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  capturePhotoToFile,
  describeCameraError,
  listVideoInputs,
  openCameraStream,
  shouldUseManagedPhotoCapture,
  stopCameraStream,
  type CameraCaptureErrorInfo,
} from "@/lib/mediaCapture";

type CaptureState = "idle" | "starting" | "preview" | "captured" | "error";

function replaceInputFiles(input: HTMLInputElement, file: File): boolean {
  try {
    if (typeof DataTransfer === "undefined") return false;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

export default function CameraCaptureBridge() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CaptureState>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string>("");
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const [capturedUrl, setCapturedUrl] = useState("");
  const [error, setError] = useState<CameraCaptureErrorInfo | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedUrlRef = useRef("");
  const cameraRequestSequenceRef = useRef(0);

  const releaseStream = useCallback(() => {
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
  }, []);

  const revokeCapturedUrl = useCallback(() => {
    const current = capturedUrlRef.current;
    capturedUrlRef.current = "";
    if (current) URL.revokeObjectURL(current);
    setCapturedUrl("");
  }, []);

  const resetCapture = useCallback((removePendingInput: boolean) => {
    cameraRequestSequenceRef.current += 1;
    releaseStream();
    revokeCapturedUrl();
    setCapturedFile(null);
    setDevices([]);
    setActiveDeviceId("");
    setError(null);
    setState("idle");
    setOpen(false);
    if (removePendingInput) pendingInputRef.current?.remove();
    pendingInputRef.current = null;
  }, [releaseStream, revokeCapturedUrl]);

  const startCamera = useCallback(async (deviceId?: string) => {
    const requestSequence = ++cameraRequestSequenceRef.current;
    releaseStream();
    revokeCapturedUrl();
    setCapturedFile(null);
    setError(null);
    setState("starting");
    try {
      const nextStream = await openCameraStream({
        deviceId: deviceId || undefined,
        facingMode: "environment",
      });
      if (
        requestSequence !== cameraRequestSequenceRef.current
        || !pendingInputRef.current
      ) {
        stopCameraStream(nextStream);
        return;
      }

      streamRef.current = nextStream;
      setStream(nextStream);
      const track = nextStream.getVideoTracks()[0];
      const settings = track?.getSettings?.();
      const resolvedDeviceId = settings?.deviceId || deviceId || "";
      setActiveDeviceId(resolvedDeviceId);
      const nextDevices = await listVideoInputs().catch(() => []);
      if (requestSequence !== cameraRequestSequenceRef.current) {
        stopCameraStream(nextStream);
        if (streamRef.current === nextStream) {
          streamRef.current = null;
          setStream(null);
        }
        return;
      }
      setDevices(nextDevices);
      setState("preview");
    } catch (cameraError) {
      if (requestSequence !== cameraRequestSequenceRef.current) return;
      releaseStream();
      setError(describeCameraError(cameraError));
      setState("error");
    }
  }, [releaseStream, revokeCapturedUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream, open, state]);

  useEffect(() => {
    const interceptCaptureInput = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!shouldUseManagedPhotoCapture(target)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pendingInputRef.current = target;
      setOpen(true);
      void startCamera();
    };

    document.addEventListener("click", interceptCaptureInput, true);
    return () => document.removeEventListener("click", interceptCaptureInput, true);
  }, [startCamera]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      resetCapture(true);
    };
    const onPageHide = () => resetCapture(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [open, resetCapture]);

  useEffect(() => () => {
    cameraRequestSequenceRef.current += 1;
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    const previewUrl = capturedUrlRef.current;
    capturedUrlRef.current = "";
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, []);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || state !== "preview") return;
    try {
      const file = await capturePhotoToFile(video);
      releaseStream();
      revokeCapturedUrl();
      const previewUrl = URL.createObjectURL(file);
      capturedUrlRef.current = previewUrl;
      setCapturedFile(file);
      setCapturedUrl(previewUrl);
      setState("captured");
    } catch (captureError) {
      releaseStream();
      setError({
        code: "capture-failed",
        title: "拍照失败",
        message: captureError instanceof Error ? captureError.message : "无法读取当前摄像头画面，请重试。",
      });
      setState("error");
    }
  }, [releaseStream, revokeCapturedUrl, state]);

  const confirm = useCallback(() => {
    const input = pendingInputRef.current;
    if (!input || !capturedFile) return;
    const delivered = replaceInputFiles(input, capturedFile);
    if (!delivered) {
      setError({
        code: "capture-failed",
        title: "无法提交照片",
        message: "当前浏览器无法把拍摄结果交给编辑器，请改用“选择图片文件”。",
      });
      setState("error");
      return;
    }
    // input.onchange in MediaExperienceBridge owns the existing prepare/upload pipeline
    // and removes the temporary input node after receiving the generated File.
    resetCapture(false);
  }, [capturedFile, resetCapture]);

  const chooseFileFallback = useCallback(() => {
    const input = pendingInputRef.current;
    if (!input) {
      resetCapture(true);
      return;
    }
    cameraRequestSequenceRef.current += 1;
    releaseStream();
    revokeCapturedUrl();
    setOpen(false);
    setCapturedFile(null);
    setState("idle");
    setError(null);
    input.dataset.nowenCameraFallback = "1";
    input.removeAttribute("capture");
    pendingInputRef.current = null;
    try {
      // Keep this synchronous with the user's fallback button click so browser user-activation
      // is still valid and the native file chooser is not blocked.
      input.click();
    } finally {
      delete input.dataset.nowenCameraFallback;
    }
  }, [releaseStream, resetCapture, revokeCapturedUrl]);

  const switchCamera = useCallback(() => {
    if (devices.length < 2) return;
    const currentIndex = Math.max(0, devices.findIndex((device) => device.deviceId === activeDeviceId));
    const next = devices[(currentIndex + 1) % devices.length];
    if (next?.deviceId) void startCamera(next.deviceId);
  }, [activeDeviceId, devices, startCamera]);

  const deviceLabel = useMemo(() => {
    if (!activeDeviceId) return "摄像头";
    return devices.find((device) => device.deviceId === activeDeviceId)?.label || "摄像头";
  }, [activeDeviceId, devices]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="拍照"
    >
      <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">拍照</div>
            <div className="truncate text-xs text-white/55">{deviceLabel}</div>
          </div>
          <button
            type="button"
            aria-label="关闭摄像头"
            onClick={() => resetCapture(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div className="relative flex min-h-[280px] flex-1 items-center justify-center bg-black sm:min-h-[420px]">
          {(state === "starting" || state === "idle") && (
            <div className="flex flex-col items-center gap-3 text-white/70">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-sm">正在打开摄像头…</span>
            </div>
          )}

          {(state === "preview" || state === "starting") && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`h-full max-h-[68vh] w-full object-contain ${state === "preview" ? "block" : "hidden"}`}
            />
          )}

          {state === "captured" && capturedUrl && (
            <img src={capturedUrl} alt="拍照预览" className="h-full max-h-[68vh] w-full object-contain" />
          )}

          {state === "error" && error && (
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
                <Camera size={22} />
              </div>
              <div className="text-base font-semibold">{error.title}</div>
              <div className="text-sm leading-6 text-white/60">{error.message}</div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 border-t border-white/10 px-4 py-4">
          {state === "preview" && (
            <>
              <button
                type="button"
                onClick={switchCamera}
                disabled={devices.length < 2}
                className="flex h-10 items-center gap-2 rounded-xl bg-white/10 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-35 hover:bg-white/15"
              >
                <RefreshCw size={16} /> 切换摄像头
              </button>
              <button
                type="button"
                onClick={() => void capture()}
                className="flex h-12 items-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-black active:scale-95"
              >
                <Camera size={18} /> 拍照
              </button>
              <button
                type="button"
                onClick={chooseFileFallback}
                className="flex h-10 items-center gap-2 rounded-xl bg-white/10 px-4 text-sm hover:bg-white/15"
              >
                <FolderOpen size={16} /> 选择图片文件
              </button>
            </>
          )}

          {state === "captured" && (
            <>
              <button
                type="button"
                onClick={() => void startCamera(activeDeviceId || undefined)}
                className="flex h-10 items-center gap-2 rounded-xl bg-white/10 px-4 text-sm hover:bg-white/15"
              >
                <RotateCcw size={16} /> 重拍
              </button>
              <button
                type="button"
                onClick={confirm}
                className="flex h-11 items-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-black active:scale-[0.98]"
              >
                <Check size={17} /> 使用照片
              </button>
            </>
          )}

          {state === "error" && (
            <>
              <button
                type="button"
                onClick={() => void startCamera(activeDeviceId || undefined)}
                className="flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-black"
              >
                <RotateCcw size={16} /> 重试
              </button>
              <button
                type="button"
                onClick={chooseFileFallback}
                className="flex h-10 items-center gap-2 rounded-xl bg-white/10 px-4 text-sm hover:bg-white/15"
              >
                <FolderOpen size={16} /> 选择图片文件
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
