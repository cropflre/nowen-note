import React, { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MobileImageViewer from "@/components/MobileImageViewer";
import { useBackButton } from "@/hooks/useCapacitor";
import { consumeMobileBack, registerMobileBackHandler } from "@/lib/mobileBackNavigation";

const nativeApp = vi.hoisted(() => ({
  listeners: new Set<(event: { canGoBack: boolean }) => void>(),
  addListener: vi.fn(),
  exitApp: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    isNativePlatform: () => true,
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: nativeApp.addListener,
    exitApp: nativeApp.exitApp,
  },
}));

vi.mock("@capacitor/splash-screen", () => ({ SplashScreen: { hide: vi.fn() } }));
vi.mock("@capacitor/status-bar", () => ({
  StatusBar: { setOverlaysWebView: vi.fn(), setStyle: vi.fn(), setBackgroundColor: vi.fn() },
  Style: { Dark: "DARK", Light: "LIGHT" },
}));
vi.mock("@capacitor/keyboard", () => ({ Keyboard: { addListener: vi.fn() } }));
vi.mock("@capacitor/haptics", () => ({
  Haptics: {},
  ImpactStyle: { Light: "LIGHT", Medium: "MEDIUM", Heavy: "HEAVY" },
  NotificationType: { Success: "SUCCESS", Warning: "WARNING", Error: "ERROR" },
}));

function BackButtonHarness({
  onCloseViewer,
  onBackToList,
}: {
  onCloseViewer: () => void;
  onBackToList: () => void;
}) {
  const [viewerOpen, setViewerOpen] = useState(true);
  const closeViewer = useCallback(() => {
    setViewerOpen(false);
    onCloseViewer();
  }, [onCloseViewer]);

  useBackButton({
    mobileView: "editor",
    mobileSidebarOpen: false,
    onBackToList,
    onCloseSidebar: vi.fn(),
  });

  return (
    <MobileImageViewer
      open={viewerOpen}
      src="https://example.com/image.png"
      onClose={closeViewer}
    />
  );
}

describe("Android 移动端返回层级", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    nativeApp.listeners.clear();
    nativeApp.addListener.mockReset();
    nativeApp.exitApp.mockReset();
    nativeApp.addListener.mockImplementation(async (
      eventName: string,
      listener: (event: { canGoBack: boolean }) => void,
    ) => {
      if (eventName === "backButton") nativeApp.listeners.add(listener);
      return {
        remove: async () => {
          nativeApp.listeners.delete(listener);
        },
      };
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("Viewer 打开时只关闭 Viewer，不执行全局 onBackToList", async () => {
    const onCloseViewer = vi.fn();
    const onBackToList = vi.fn();

    await act(async () => {
      root.render(
        <BackButtonHarness
          onCloseViewer={onCloseViewer}
          onBackToList={onBackToList}
        />,
      );
      await Promise.resolve();
    });

    expect(nativeApp.addListener).toHaveBeenCalledTimes(1);
    expect(nativeApp.listeners.size).toBe(1);
    act(() => nativeApp.listeners.forEach((listener) => listener({ canGoBack: false })));
    expect(onCloseViewer).toHaveBeenCalledTimes(1);
    expect(onBackToList).not.toHaveBeenCalled();

    act(() => nativeApp.listeners.forEach((listener) => listener({ canGoBack: false })));
    expect(onBackToList).toHaveBeenCalledTimes(1);
    expect(nativeApp.addListener).toHaveBeenCalledTimes(1);
  });

  it("每次只消费最高优先级的一个浮层", () => {
    const calls: string[] = [];
    const unregisterSheet = registerMobileBackHandler("sheet", () => {
      calls.push("sheet");
    });
    const unregisterModal = registerMobileBackHandler("modal", () => {
      calls.push("modal");
    });
    const unregisterViewer = registerMobileBackHandler("image-viewer", () => {
      calls.push("viewer");
    });

    expect(consumeMobileBack()).toBe(true);
    expect(calls).toEqual(["viewer"]);

    unregisterViewer();
    expect(consumeMobileBack()).toBe(true);
    expect(calls).toEqual(["viewer", "modal"]);

    unregisterModal();
    unregisterSheet();
  });
});
