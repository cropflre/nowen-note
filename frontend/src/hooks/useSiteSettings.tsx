import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface SiteConfig {
  title: string;
  favicon: string;
}

const DEFAULT_CONFIG: SiteConfig = {
  title: "nowen-note",
  favicon: "",
};

interface SiteSettingsContextValue {
  siteConfig: SiteConfig;
  updateSiteConfig: (title: string, favicon: string) => Promise<void>;
  isLoaded: boolean;
}

const SiteSettingsContext = createContext<SiteSettingsContextValue>({
  siteConfig: DEFAULT_CONFIG,
  updateSiteConfig: async () => {},
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

export function SiteSettingsProvider({ children }: { children: React.ReactNode }) {
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(DEFAULT_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    api.getSiteSettingsPublic().then((data) => {
      const config: SiteConfig = {
        title: data.site_title || "nowen-note",
        favicon: data.site_favicon || "",
      };
      setSiteConfig(config);
      applyToDOM(config.title, config.favicon);
      setIsLoaded(true);
    }).catch(() => {
      applyToDOM(DEFAULT_CONFIG.title, DEFAULT_CONFIG.favicon);
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
    };
    setSiteConfig(config);
    applyToDOM(config.title, config.favicon);
  }, []);

  return (
    <SiteSettingsContext.Provider value={{ siteConfig, updateSiteConfig, isLoaded }}>
      {children}
    </SiteSettingsContext.Provider>
  );
}

export function useSiteSettings() {
  return useContext(SiteSettingsContext);
}
