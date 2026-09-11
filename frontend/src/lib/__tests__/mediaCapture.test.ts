import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeCameraError,
  openCameraStream,
  shouldUseManagedPhotoCapture,
  stopCameraStream,
} from "@/lib/mediaCapture";

function captureInput(accept = "image/*"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.setAttribute("capture", "environment");
  return input;
}

afterEach(() => {
  delete (window as any).nowenDesktop;
  delete (window as any).Capacitor;
  vi.restoreAllMocks();
});

describe("managed photo capture capability", () => {
  it("takes over image capture in Electron desktop", () => {
    (window as any).nowenDesktop = { isDesktop: true, platform: "win32" };
    expect(shouldUseManagedPhotoCapture(captureInput("image/*"))).toBe(true);
  });

  it("does not take over video capture", () => {
    (window as any).nowenDesktop = { isDesktop: true, platform: "win32" };
    expect(shouldUseManagedPhotoCapture(captureInput("video/*"))).toBe(false);
  });

  it("preserves native Capacitor capture behavior", () => {
    (window as any).nowenDesktop = { isDesktop: true, platform: "win32" };
    (window as any).Capacitor = { isNativePlatform: () => true };
    expect(shouldUseManagedPhotoCapture(captureInput("image/*"))).toBe(false);
  });

  it("requests video only and never requests microphone audio", async () => {
    const stream = { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
    });

    await expect(openCameraStream()).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: expect.objectContaining({ facingMode: { ideal: "environment" } }),
      audio: false,
    });
  });

  it("stops every track during cleanup", () => {
    const first = { stop: vi.fn() };
    const second = { stop: vi.fn() };
    const stream = { getTracks: () => [first, second] } as unknown as MediaStream;

    stopCameraStream(stream);

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it("maps common camera failures to actionable product messages", () => {
    expect(describeCameraError({ name: "NotAllowedError" }).code).toBe("permission-denied");
    expect(describeCameraError({ name: "NotFoundError" }).code).toBe("not-found");
    expect(describeCameraError({ name: "NotReadableError" }).code).toBe("not-readable");
    expect(describeCameraError({ name: "OverconstrainedError" }).code).toBe("overconstrained");
    expect(describeCameraError({ name: "NotSupportedError" }).code).toBe("unsupported");
  });
});
