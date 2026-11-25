import { useCallback, useEffect, useState } from "react";
import {
  isMobileLiteViewport,
  loadMobileLiteMode,
  MOBILE_LITE_MEDIA_QUERY,
  MOBILE_LITE_MODE_CHANGED_EVENT,
  MOBILE_LITE_MODE_STORAGE_KEY,
  saveMobileLiteMode,
} from "@/lib/mobileLiteMode";

export interface MobileLiteModeState {
  /** 用户在当前设备保存的精简模式开关值（仅本设备 localStorage）。 */
  enabled: boolean;
  /** 当前是否处于移动端视口（< 768px）。 */
  isMobileViewport: boolean;
  /** 精简模式是否实际生效：严格要求 enabled && isMobileViewport，确保桌面端永远为 false。 */
  active: boolean;
  /** 切换精简模式开关并同步到同标签页与其它标签页。 */
  setEnabled: (next: boolean) => void;
}

export function useMobileLiteMode(): MobileLiteModeState {
  const [enabled, setEnabledState] = useState<boolean>(loadMobileLiteMode);
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(isMobileLiteViewport);

  useEffect(() => {
    const syncEnabled = () => setEnabledState(loadMobileLiteMode());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === MOBILE_LITE_MODE_STORAGE_KEY || event.key === null) {
        syncEnabled();
      }
    };

    window.addEventListener(MOBILE_LITE_MODE_CHANGED_EVENT, syncEnabled);
    window.addEventListener("storage", syncStorage);

    let cleanupMedia: (() => void) | undefined;
    if (typeof window.matchMedia === "function") {
      const media = window.matchMedia(MOBILE_LITE_MEDIA_QUERY);
      const updateViewport = () => setIsMobileViewport(media.matches);
      updateViewport();
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", updateViewport);
        cleanupMedia = () => media.removeEventListener("change", updateViewport);
      } else if (typeof media.addListener === "function") {
        media.addListener(updateViewport);
        cleanupMedia = () => media.removeListener(updateViewport);
      }
    }

    return () => {
      window.removeEventListener(MOBILE_LITE_MODE_CHANGED_EVENT, syncEnabled);
      window.removeEventListener("storage", syncStorage);
      cleanupMedia?.();
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    saveMobileLiteMode(next);
  }, []);

  return {
    enabled,
    isMobileViewport,
    active: enabled && isMobileViewport,
    setEnabled,
  };
}
