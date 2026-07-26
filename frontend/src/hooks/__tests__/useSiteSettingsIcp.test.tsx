import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteSettingsProvider, useSiteSettings } from "../useSiteSettings";
import { setServerUrl } from "@/lib/api";

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
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("服务器地址确认后重新加载远端备案号并写入 siteConfig", async () => {
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
