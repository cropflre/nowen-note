import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import i18n from "i18next";
import { api, SERVER_URL_CHANGED_EVENT } from "@/lib/api";
import { setRuntimePublicWebOrigin } from "@/lib/publicWebOrigin";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";

export interface SiteConfig {
  title: string;
  favicon: string;
  /** 分享页底部标识文字；空串表示使用默认标识。 */
  shareFooterText: string;
  /** ICP 备案号；由 Docker/运行时环境变量 NOWEN_ICP_BEIAN 提供。 */
  icpBeian: string;
  /** 公开分享最终使用的 Web 根地址；空串表示继续走构建变量/当前 origin 兜底。 */
  publicWebOrigin: string;
  /** settings / environment / current，用于分享弹窗解释地址来源。 */
  publicWebOriginSource: string;
  /** 文件/图床复制直链专用地址；空串表示继承 publicWebOrigin。 */
  filePublicOrigin: string;
  /** settings / environment / inherit。 */
  filePublicOriginSource: string;
  editorFontFamily: string;
}

const DEFAULT_CONFIG: SiteConfig = {
  title: "nowen-note",
  favicon: "",
  shareFooterText: "",
  icpBeian: "",
  publicWebOrigin: "",
  publicWebOriginSource: "current",
  filePublicOrigin: "",
  filePublicOriginSource: "inherit",
  editorFontFamily: "",
};

const MOBILE_LOCAL_SITE_CONFIG_KEY = "nowen-mobile-local-site-config";

// 内置字体选项（不需要上传）
export const BUILTIN_FONTS = [
  { id: "", nameKey: "fonts.interDefault", family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { id: "__system", nameKey: "fonts.systemDefault", family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { id: "__serif", nameKey: "fonts.serif", family: "Georgia, 'Noto Serif SC', 'Source Han Serif SC', serif" },
  { id: "__mono", nameKey: "fonts.monospace", family: "'Cascadia Code', 'Fira Code', 'Source Code Pro', 'Menlo', 'Consolas', monospace" },
];

export function getBuiltinFontName(font: typeof BUILTIN_FONTS[number]): string {
  return i18n.t(font.nameKey);
}

interface SiteSettingsContextValue {
  siteConfig: SiteConfig;
  updateSiteConfig: (title: string, favicon: string, shareFooterText?: string) => Promise<void>;
  updatePublicWebOrigin: (origin: string) => Promise<void>;
  updateFilePublicOrigin: (origin: string) => Promise<void>;
  updateEditorFont: (fontId: string) => Promise<void>;
  isLoaded: boolean;
}

const SiteSettingsContext = createContext<SiteSettingsContextValue>({
  siteConfig: DEFAULT_CONFIG,
  updateSiteConfig: async () => {},
  updatePublicWebOrigin: async () => {},
  updateFilePublicOrigin: async () => {},
  updateEditorFont: async () => {},
  isLoaded: false,
});

function parseDataUrlMime(url: string): string {
  const m = /^data:([^;,]+)[;,]/i.exec(url);
  return m ? m[1].toLowerCase() : "image/png";
}

function applyToDOM(title: string, faviconUrl: string) {
  document.title = title || "nowen-note";

  const oldLinks = document.head.querySelectorAll<HTMLLinkElement>(
    'link[rel="icon"], link[rel="shortcut icon"], link[rel="alternate icon"], link[rel="apple-touch-icon"]',
  );
  oldLinks.forEach((n) => n.parentNode?.removeChild(n));

  const link = document.createElement("link");
  link.rel = "icon";
  if (faviconUrl) {
    link.type = parseDataUrlMime(faviconUrl) || "image/png";
    link.href = faviconUrl;
  } else {
    link.type = "image/svg+xml";
    link.href = "/favicon.svg";
  }
  document.head.appendChild(link);

  const apple = document.createElement("link");
  apple.rel = "apple-touch-icon";
  apple.href = faviconUrl || "/apple-touch-icon.svg";
  document.head.appendChild(apple);
}

function applyEditorFont(fontId: string, customFontName?: string) {
  const builtin = BUILTIN_FONTS.find((font) => font.id === fontId);
  if (builtin) {
    document.documentElement.style.setProperty("--editor-font-family", builtin.family);
    return;
  }

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
      `'${fontFaceName}', system-ui, sans-serif`,
    );
    return;
  }

  document.documentElement.style.setProperty(
    "--editor-font-family",
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  );
}

function toSiteConfig(data: any, previous: SiteConfig = DEFAULT_CONFIG): SiteConfig {
  return {
    title: data?.site_title || "nowen-note",
    favicon: data?.site_favicon || "",
    shareFooterText: data?.site_share_footer_text || "",
    icpBeian: data?.site_icp_beian || previous.icpBeian || "",
    publicWebOrigin: data?.site_public_web_origin || "",
    publicWebOriginSource: data?.site_public_web_origin_source || "current",
    filePublicOrigin: data?.site_file_public_origin || "",
    filePublicOriginSource: data?.site_file_public_origin_source || "inherit",
    editorFontFamily: data?.editor_font_family || previous.editorFontFamily || "",
  };
}

function applyRuntimePublicOrigin(config: SiteConfig): void {
  setRuntimePublicWebOrigin(config.publicWebOrigin, config.publicWebOriginSource);
}

function readMobileLocalConfig(): SiteConfig {
  try {
    const value = localStorage.getItem(MOBILE_LOCAL_SITE_CONFIG_KEY);
    if (!value) return DEFAULT_CONFIG;
    const parsed = JSON.parse(value) as Partial<SiteConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      publicWebOrigin: "",
      publicWebOriginSource: "current",
      filePublicOrigin: "",
      filePublicOriginSource: "inherit",
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeMobileLocalConfig(config: SiteConfig): void {
  try {
    localStorage.setItem(MOBILE_LOCAL_SITE_CONFIG_KEY, JSON.stringify({
      title: config.title,
      favicon: config.favicon,
      shareFooterText: config.shareFooterText,
      editorFontFamily: config.editorFontFamily,
    }));
  } catch {
    // WebView storage failure: keep the in-memory settings for this session.
  }
}

export function SiteSettingsProvider({ children }: { children: React.ReactNode }) {
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(DEFAULT_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);

  const loadSiteSettings = useCallback(() => {
    if (isMobileLocalMode()) {
      const config = readMobileLocalConfig();
      applyRuntimePublicOrigin(config);
      setSiteConfig(config);
      applyToDOM(config.title, config.favicon);
      // 设备本地模式只加载内置字体；自定义字体文件属于服务端资源。
      applyEditorFont(BUILTIN_FONTS.some((font) => font.id === config.editorFontFamily) ? config.editorFontFamily : "");
      setIsLoaded(true);
      return;
    }

    api.getSiteSettingsPublic().then(async (data) => {
      const config = toSiteConfig(data);
      applyRuntimePublicOrigin(config);
      setSiteConfig(config);
      applyToDOM(config.title, config.favicon);

      if (config.editorFontFamily && !BUILTIN_FONTS.find((font) => font.id === config.editorFontFamily)) {
        try {
          const fonts = await api.getFontsPublic();
          const font = fonts.find((item) => item.id === config.editorFontFamily);
          applyEditorFont(config.editorFontFamily, font?.name);
        } catch {
          applyEditorFont(config.editorFontFamily);
        }
      } else {
        applyEditorFont(config.editorFontFamily);
      }

      setIsLoaded(true);
    }).catch(() => {
      applyRuntimePublicOrigin(DEFAULT_CONFIG);
      applyToDOM(DEFAULT_CONFIG.title, DEFAULT_CONFIG.favicon);
      applyEditorFont("");
      setIsLoaded(true);
    });
  }, []);

  useEffect(() => {
    loadSiteSettings();

    const handleServerUrlChanged = () => {
      loadSiteSettings();
    };
    window.addEventListener(SERVER_URL_CHANGED_EVENT, handleServerUrlChanged);
    return () => window.removeEventListener(SERVER_URL_CHANGED_EVENT, handleServerUrlChanged);
  }, [loadSiteSettings]);

  const updateSiteConfig = useCallback(async (title: string, favicon: string, shareFooterText?: string) => {
    if (isMobileLocalMode()) {
      const config = { ...siteConfig, title: title || "nowen-note", favicon, shareFooterText: shareFooterText?.trim() ?? siteConfig.shareFooterText };
      setSiteConfig(config);
      writeMobileLocalConfig(config);
      applyToDOM(config.title, config.favicon);
      return;
    }
    const data = await api.updateSiteSettings({ site_title: title, site_favicon: favicon, site_share_footer_text: shareFooterText });
    const config = toSiteConfig(data, siteConfig);
    applyRuntimePublicOrigin(config);
    setSiteConfig(config);
    applyToDOM(config.title, config.favicon);
  }, [siteConfig]);

  const updatePublicWebOrigin = useCallback(async (origin: string) => {
    if (isMobileLocalMode()) {
      setSiteConfig((previous) => ({ ...previous, publicWebOrigin: "", publicWebOriginSource: "current" }));
      return;
    }
    const data = await api.updateSiteSettings({ site_public_web_origin: origin } as any);
    setSiteConfig((previous) => {
      const config = toSiteConfig(data, previous);
      applyRuntimePublicOrigin(config);
      return config;
    });
  }, []);

  const updateFilePublicOrigin = useCallback(async (origin: string) => {
    if (isMobileLocalMode()) {
      setSiteConfig((previous) => ({
        ...previous,
        filePublicOrigin: "",
        filePublicOriginSource: "inherit",
      }));
      return;
    }
    const data = await api.updateSiteSettings({ site_file_public_origin: origin });
    setSiteConfig((previous) => {
      const config = toSiteConfig(data, previous);
      applyRuntimePublicOrigin(config);
      return config;
    });
  }, []);

  const updateEditorFont = useCallback(async (fontId: string) => {
    if (isMobileLocalMode()) {
      const localFontId = BUILTIN_FONTS.some((font) => font.id === fontId) ? fontId : "";
      const config = { ...siteConfig, editorFontFamily: localFontId };
      setSiteConfig(config);
      writeMobileLocalConfig(config);
      applyEditorFont(localFontId);
      return;
    }

    const data = await api.updateSiteSettings({ editor_font_family: fontId });
    const config: SiteConfig = {
      ...siteConfig,
      editorFontFamily: data.editor_font_family || "",
    };
    applyRuntimePublicOrigin(config);
    setSiteConfig(config);

    if (fontId && !BUILTIN_FONTS.find((font) => font.id === fontId)) {
      try {
        const fonts = await api.getFonts();
        const font = fonts.find((item) => item.id === fontId);
        applyEditorFont(fontId, font?.name);
      } catch {
        applyEditorFont(fontId);
      }
    } else {
      applyEditorFont(fontId);
    }
  }, [siteConfig]);

  return (
    <SiteSettingsContext.Provider value={{ siteConfig, updateSiteConfig, updatePublicWebOrigin, updateFilePublicOrigin, updateEditorFont, isLoaded }}>
      {children}
    </SiteSettingsContext.Provider>
  );
}

export function useSiteSettings() {
  return useContext(SiteSettingsContext);
}
