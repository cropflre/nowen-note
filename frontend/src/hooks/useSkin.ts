import { useCallback, useEffect, useState } from "react";
import "@/app-appearance.css";
import {
  APP_APPEARANCE_CHANGED_EVENT,
  APP_APPEARANCE_IDS,
  APP_APPEARANCE_STORAGE_KEY,
  applyAppAppearance,
  bootstrapAppAppearanceRuntime,
  readStoredAppAppearance,
  type AppAppearanceId,
} from "@/lib/appAppearance";
import { installLegacyNoteAppearanceNeutralizer } from "@/lib/legacyNoteAppearanceNeutralizer";

/**
 * App 外观风格与 Light / Dark / System 是正交维度。
 *
 * 外观风格负责整个 Nowen Note 的视觉语言；主题模式只决定当前风格使用 light 还是 dark
 * token。所有风格都由 `appAppearance.ts` 的唯一 Registry 提供，组件不再维护第二份名单。
 */
export type Skin = AppAppearanceId;
export const SKIN_STORAGE_KEY = APP_APPEARANCE_STORAGE_KEY;

// SkinSwitcher 随主应用模块一同加载；在 React 首次绘制前先恢复持久化风格，并安装
// Light/Dark、多标签页同步，以及旧笔记主题投影的兼容隔离。
bootstrapAppAppearanceRuntime();
installLegacyNoteAppearanceNeutralizer();

export function useSkin(): {
  skin: Skin;
  setSkin: (next: Skin) => void;
  skins: readonly Skin[];
} {
  const [skin, setSkinState] = useState<Skin>(() => readStoredAppAppearance());

  useEffect(() => {
    applyAppAppearance(skin);
  }, [skin]);

  useEffect(() => {
    const sync = () => setSkinState(readStoredAppAppearance());
    const onStorage = (event: StorageEvent) => {
      if (event.key === APP_APPEARANCE_STORAGE_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(APP_APPEARANCE_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(APP_APPEARANCE_CHANGED_EVENT, sync);
    };
  }, []);

  const setSkin = useCallback((next: Skin) => {
    try {
      localStorage.setItem(APP_APPEARANCE_STORAGE_KEY, next);
    } catch {
      // localStorage 不可用时仍更新当前窗口内存态。
    }
    applyAppAppearance(next);
    setSkinState(next);
    window.dispatchEvent(new CustomEvent(APP_APPEARANCE_CHANGED_EVENT, { detail: next }));
  }, []);

  return { skin, setSkin, skins: APP_APPEARANCE_IDS };
}
