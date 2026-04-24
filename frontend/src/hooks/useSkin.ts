import { useCallback, useEffect, useState } from "react";

/**
 * "外观风格"（Skin）与 next-themes 的"明暗模式"（Theme）是**正交**的两个维度：
 *
 *   Skin  ∈  { "default", "macos" }        → 写到 <html data-skin="...">
 *   Theme ∈  { "light", "dark", "system" } → 写到 <html class="dark" | "">
 *
 * 这样组合出 default-light / default-dark / macos-light / macos-dark 四种视觉，
 * 增加新皮肤（nord / solarized …）时只需要多一组 CSS 变量，不动 next-themes。
 *
 * 存储在 localStorage("nowen-note-skin")；FOUC 防护由 index.html 里的同步内联脚本完成。
 */

export type Skin = "default" | "macos";

export const SKIN_STORAGE_KEY = "nowen-note-skin";
const ALL_SKINS: readonly Skin[] = ["default", "macos"] as const;

function readSkin(): Skin {
  try {
    const raw = localStorage.getItem(SKIN_STORAGE_KEY);
    if (raw && (ALL_SKINS as readonly string[]).includes(raw)) {
      return raw as Skin;
    }
  } catch {
    /* localStorage 被禁：走默认 */
  }
  return "default";
}

function applySkin(skin: Skin) {
  const root = document.documentElement;
  if (skin === "default") {
    // 默认皮肤 = 不写 data-skin，让原有 :root / .dark 变量生效
    root.removeAttribute("data-skin");
  } else {
    root.setAttribute("data-skin", skin);
  }
}

/**
 * 订阅并修改当前皮肤。
 * - 跨标签页同步：通过 storage 事件
 * - 首次挂载时读取 localStorage 并确保 DOM 属性一致（索引脚本已经设过，但
 *   SPA 多入口下稳妥起见再兜底一次）
 */
export function useSkin(): {
  skin: Skin;
  setSkin: (next: Skin) => void;
  skins: readonly Skin[];
} {
  const [skin, setSkinState] = useState<Skin>(() => readSkin());

  useEffect(() => {
    applySkin(skin);
  }, [skin]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SKIN_STORAGE_KEY) return;
      setSkinState(readSkin());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setSkin = useCallback((next: Skin) => {
    try {
      localStorage.setItem(SKIN_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    setSkinState(next);
  }, []);

  return { skin, setSkin, skins: ALL_SKINS };
}
