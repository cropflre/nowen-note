import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteSettingsProvider, useSiteSettings } from "../useSiteSettings";
import { api, setServerUrl } from "@/lib/api";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe("SiteSettingsProvider ICP 备案号", () => {
  let root: Root;
  let host: HTMLElement;
  let fetchMock: ReturnType<typeof vi.fn<any[], Promise<Response>>>;

  beforeEach(() => {
    localStorage.clear();
    Object.assign(window, { nowenDesktop: { isDesktop: true } });
    document.body.innerHTML = '<div id="root"></div>';
    host = document.getElementById("root")!;
    root = createRoot(host);
    fetchMock = vi.fn(async (url: string) => {
      const body = String(url).startsWith("https://notes.example.com/api/settings")
        ? {
            site_title: "nowen-note",
            site_favicon: "",
            site_icp_beian: "粤ICP备12345678号-1",
            editor_font_family: "",
          }
        : {
            site_title: "nowen-note",
            site_favicon: "",
            site_icp_beian: "",
            editor_font_family: "",
          };

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "nowenDesktop");
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("原生客户端服务器地址确认后重新加载远端备案号并写入 siteConfig", async () => {
    function IcpStatus() {
      const { siteConfig } = useSiteSettings();
      return <span data-testid="icp">{siteConfig.icpBeian || "empty"}</span>;
    }

    await act(async () => {
      root.render(
        <SiteSettingsProvider>
          <IcpStatus />
        </SiteSettingsProvider>,
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
        cache: "no-store",
      }));
    });
    expect(host.querySelector("[data-testid='icp']")?.textContent).toBe("empty");

    await act(async () => {
      setServerUrl("https://notes.example.com");
    });

    await waitFor(() => {
      expect(host.querySelector("[data-testid='icp']")?.textContent).toBe("粤ICP备12345678号-1");
    });
  });

  it("公开读取分享标识，保存和清空后更新上下文", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      site_title: "nowen-note", site_favicon: "", editor_font_family: "",
      site_share_footer_text: "团队知识库",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const updateMock = vi.spyOn(api, "updateSiteSettings").mockImplementation(async (data) => ({
      site_title: data.site_title!, site_favicon: data.site_favicon!, editor_font_family: "",
      site_share_footer_text: data.site_share_footer_text?.trim() || "",
    }));
    let save: (text: string) => Promise<void>;
    function FooterStatus() {
      const { siteConfig, updateSiteConfig } = useSiteSettings();
      save = (text) => updateSiteConfig(siteConfig.title, siteConfig.favicon, text);
      return <span>{siteConfig.shareFooterText}</span>;
    }
    await act(async () => root.render(<SiteSettingsProvider><FooterStatus /></SiteSettingsProvider>));
    expect(host.textContent).toBe("团队知识库");
    await act(async () => save("  新标识  "));
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ site_share_footer_text: "  新标识  " }));
    expect(host.textContent).toBe("新标识");
    await act(async () => save(""));
    expect(host.textContent).toBe("");
  });

  it("把公开站点名称和图标应用到浏览器标签页", async () => {
    const favicon = "data:image/png;base64,AA==";
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      site_title: "团队知识库",
      site_favicon: favicon,
      site_icp_beian: "",
      editor_font_family: "",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await act(async () => {
      root.render(
        <SiteSettingsProvider>
          <div />
        </SiteSettingsProvider>,
      );
    });

    await waitFor(() => {
      expect(document.title).toBe("团队知识库");
    });
    expect(document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toBe(favicon);
    expect(document.head.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href).toBe(favicon);
  });
});
