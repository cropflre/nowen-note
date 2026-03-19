import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import i18n from "i18next";
import { api } from "@/lib/api";

export interface SiteConfig {
  title: string;
  favicon: string;
  editorFontFamily: string; // 空串=默认(Inter), 自定义字体 id, 或内置字体名
}

const DEFAULT_CONFIG: SiteConfig = {
  title: "nowen-note",
  favicon: "",
  editorFontFamily: "",
};

// 内置字体选项（不需要上传）
export const BUILTIN_FONTS = [
  { id: "", nameKey: "fonts.interDefault", family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { id: "__system", nameKey: "fonts.systemDefault", family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { id: "__serif", nameKey: "fonts.serif", family: "Georgia, 'Noto Serif SC', 'Source Han Serif SC', serif" },
  { id: "__mono", nameKey: "fonts.monospace", family: "'Cascadia Code', 'Fira Code', 'Source Code Pro', 'Menlo', 'Consolas', monospace" },
];

// Helper to get translated font name
export function getBuiltinFontName(font: typeof BUILTIN_FONTS[number]): string {
  return i18n.t(font.nameKey);
}

interface SiteSettingsContextValue {
  siteConfig: SiteConfig;
  updateSiteConfig: (title: string, favicon: string) => Promise<void>;
  updateEditorFont: (fontId: string) => Promise<void>;
  isLoaded: boolean;
}

const SiteSettingsContext = createContext<SiteSettingsContextValue>({
  siteConfig: DEFAULT_CONFIG,
  updateSiteConfig: async () => {},
  updateEditorFont: async () => {},
  isLoaded: false,
});

function applyToDOM(title: string, faviconUrl: string) {
  document.title = title || "nowen-note";

  let link: HTMLLinkElement | null = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }

  if (faviconUrl) {
    link.href = faviconUrl;
    link.type = faviconUrl.startsWith("data:image/svg") ? "image/svg+xml"
      : faviconUrl.startsWith("data:image/png") ? "image/png"
      : faviconUrl.startsWith("data:image/x-icon") ? "image/x-icon"
      : "image/png";
  } else {
    link.href = "/vite.svg";
    link.type = "image/svg+xml";
  }
}

function applyEditorFont(fontId: string, customFontName?: string) {
  const builtin = BUILTIN_FONTS.find(f => f.id === fontId);
  if (builtin) {
    document.documentElement.style.setProperty("--editor-font-family", builtin.family);
    return;
  }

  // 自定义字体：注入 @font-face 并设置 CSS 变量
  if (fontId && customFontName) {
    const fontFaceName = `CustomFont-${fontId.slice(0, 8)}`;
    const styleId = `font-face-${fontId}`;

    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `@font-face { font-family: '${fontFaceName}'; src: url('${api.getFontFileUrl(fontId)}'); font-display: swap; }`;
      document.head.appendChild(style);
    }

    document.documentElement.style.setProperty(
      "--editor-font-family",
      `'${fontFaceName}', system-ui, sans-serif`
    );
    return;
  }

  // 回退默认
  document.documentElement.style.setProperty(
    "--editor-font-family",
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
  );
}

export function SiteSettingsProvider({ children }: { children: React.ReactNode }) {
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(DEFAULT_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    api.getSiteSettingsPublic().then(async (data) => {
      const config: SiteConfig = {
        title: data.site_title || "nowen-note",
        favicon: data.site_favicon || "",
        editorFontFamily: data.editor_font_family || "",
      };
      setSiteConfig(config);
      applyToDOM(config.title, config.favicon);

      // 加载自定义字体名
      if (config.editorFontFamily && !BUILTIN_FONTS.find(f => f.id === config.editorFontFamily)) {
        try {
          const fonts = await api.getFontsPublic();
          const font = fonts.find(f => f.id === config.editorFontFamily);
          applyEditorFont(config.editorFontFamily, font?.name);
        } catch {
          applyEditorFont(config.editorFontFamily);
        }
      } else {
        applyEditorFont(config.editorFontFamily);
      }

      setIsLoaded(true);
    }).catch(() => {
      applyToDOM(DEFAULT_CONFIG.title, DEFAULT_CONFIG.favicon);
      applyEditorFont("");
      setIsLoaded(true);
    });
  }, []);

  const updateSiteConfig = useCallback(async (title: string, favicon: string) => {
    const data = await api.updateSiteSettings({
      site_title: title,
      site_favicon: favicon,
    });
    const config: SiteConfig = {
      title: data.site_title || "nowen-note",
      favicon: data.site_favicon || "",
      editorFontFamily: data.editor_font_family || siteConfig.editorFontFamily,
    };
    setSiteConfig(config);
    applyToDOM(config.title, config.favicon);
  }, [siteConfig.editorFontFamily]);

  const updateEditorFont = useCallback(async (fontId: string) => {
    const data = await api.updateSiteSettings({ editor_font_family: fontId });
    const config: SiteConfig = {
      ...siteConfig,
      editorFontFamily: data.editor_font_family || "",
    };
    setSiteConfig(config);

    // 获取自定义字体名用于 @font-face
    if (fontId && !BUILTIN_FONTS.find(f => f.id === fontId)) {
      try {
        const fonts = await api.getFonts();
        const font = fonts.find(f => f.id === fontId);
        applyEditorFont(fontId, font?.name);
      } catch {
        applyEditorFont(fontId);
      }
    } else {
      applyEditorFont(fontId);
    }
  }, [siteConfig]);

  return (
    <SiteSettingsContext.Provider value={{ siteConfig, updateSiteConfig, updateEditorFont, isLoaded }}>
      {children}
    </SiteSettingsContext.Provider>
  );
}

export function useSiteSettings() {
  return useContext(SiteSettingsContext);
}
