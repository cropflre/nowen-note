import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import i18n from "i18next";
import { api, SERVER_URL_CHANGED_EVENT } from "@/lib/api";
import { setRuntimePublicWebOrigin } from "@/lib/publicWebOrigin";

export interface SiteConfig {
  title: string;
  favicon: string;
  /** ICP 备案号；由 Docker/运行时环境变量 NOWEN_ICP_BEIAN 提供。 */
  icpBeian: string;
  /** 公开分享最终使用的 Web 根地址；空串表示继续走构建变量/当前 origin 兜底。 */
  publicWebOrigin: string;
  /** settings / environment / current，用于分享弹窗解释地址来源。 */
  publicWebOriginSource: string;
  editorFontFamily: string; // 空串=默认(Inter), 自定义字体 id, 或内置字体名
  // 注：v6 起，"个人空间导出/导入"不再是站点级全站开关；它已下沉为 users 表
  // 的 personalExportEnabled / personalImportEnabled 两列，由管理员在
  // 「用户管理 → 编辑用户」里为每个用户独立控制。消费方（Sidebar、DataManager）
  // 请读当前登录用户自己（api.getMe() 的返回）上的这两字段，不要再从这里读。
}

const DEFAULT_CONFIG: SiteConfig = {
  title: "nowen-note",
  favicon: "",
  icpBeian: "",
  publicWebOrigin: "",
  publicWebOriginSource: "current",
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
  updatePublicWebOrigin: (origin: string) => Promise<void>;
  updateEditorFont: (fontId: string) => Promise<void>;
  isLoaded: boolean;
}

const SiteSettingsContext = createContext<SiteSettingsContextValue>({
  siteConfig: DEFAULT_CONFIG,
  updateSiteConfig: async () => {},
  updatePublicWebOrigin: async () => {},
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
    'link[rel="icon"], link[rel="shortcut icon"], link[rel="alternate icon"], link[rel="apple-touch-icon"]'
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
  const builtin = BUILTIN_FONTS.find(f => f.id === fontId);
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
      `'${fontFaceName}', system-ui, sans-serif`
    );
    return;
  }

  document.documentElement.style.setProperty(
    "--editor-font-family",
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
  );
}

function toSiteConfig(data: any, previous: SiteConfig = DEFAULT_CONFIG): SiteConfig {
  return {
    title: data?.site_title || "nowen-note",
    favicon: data?.site_favicon || "",
    icpBeian: data?.site_icp_beian || previous.icpBeian || "",
    publicWebOrigin: data?.site_public_web_origin || "",
    publicWebOriginSource: data?.site_public_web_origin_source || "current",
    editorFontFamily: data?.editor_font_family || previous.editorFontFamily || "",
  };
}

function applyRuntimePublicOrigin(config: SiteConfig): void {
  setRuntimePublicWebOrigin(config.publicWebOrigin, config.publicWebOriginSource);
}

export function SiteSettingsProvider({ children }: { children: React.ReactNode }) {
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(DEFAULT_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);

  const loadSiteSettings = useCallback(() => {
    api.getSiteSettingsPublic().then(async (data) => {
      const config = toSiteConfig(data);
      applyRuntimePublicOrigin(config);
      setSiteConfig(config);
      applyToDOM(config.title, config.favicon);

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

  const updateSiteConfig = useCallback(async (title: string, favicon: string) => {
    const data = await api.updateSiteSettings({
      site_title: title,
      site_favicon: favicon,
    });
    const config = toSiteConfig(data, siteConfig);
    applyRuntimePublicOrigin(config);
    setSiteConfig(config);
    applyToDOM(config.title, config.favicon);
  }, [siteConfig]);

  const updatePublicWebOrigin = useCallback(async (origin: string) => {
    const data = await api.updateSiteSettings({
      site_public_web_origin: origin,
    } as any);
    setSiteConfig((previous) => {
      const config = toSiteConfig(data, previous);
      applyRuntimePublicOrigin(config);
      return config;
    });
  }, []);

  const updateEditorFont = useCallback(async (fontId: string) => {
    const data = await api.updateSiteSettings({ editor_font_family: fontId });
    const config: SiteConfig = {
      ...siteConfig,
      editorFontFamily: data.editor_font_family || "",
    };
    applyRuntimePublicOrigin(config);
    setSiteConfig(config);

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
    <SiteSettingsContext.Provider value={{ siteConfig, updateSiteConfig, updatePublicWebOrigin, updateEditorFont, isLoaded }}>
      {children}
    </SiteSettingsContext.Provider>
  );
}

export function useSiteSettings() {
  return useContext(SiteSettingsContext);
}
