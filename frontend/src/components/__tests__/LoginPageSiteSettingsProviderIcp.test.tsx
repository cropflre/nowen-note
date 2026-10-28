import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../LoginPage";
import { SiteSettingsProvider } from "@/hooks/useSiteSettings";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/useCapacitor", () => ({
  useKeyboardLayout: () => {},
}));

vi.mock("@/hooks/useKeyboardVisible", () => ({
  useKeyboardVisible: () => ({ height: 0 }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchRegisterConfig: vi.fn(async () => ({ allowRegistration: true, hasUsers: true })),
    getServerUrl: vi.fn(() => ""),
    registerAccount: vi.fn(),
    testServerConnection: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("@/components/LanDiscoveryPanel", () => ({
  default: () => null,
}));

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

describe("LoginPage + SiteSettingsProvider ICP 备案号", () => {
  let root: Root | null = null;

  beforeEach(() => {
    delete (window as any).Capacitor;
    localStorage.clear();
    document.body.innerHTML = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) === "/api/settings") {
        return new Response(JSON.stringify({
          site_title: "nowen-note",
          site_favicon: "",
          site_icp_beian: "粤ICP备12345678号-1",
          editor_font_family: "",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ allowRegistration: true, hasUsers: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("Web 登录页使用公开站点设置展示数据库备案号", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <SiteSettingsProvider>
          <LoginPage onLogin={vi.fn()} />
        </SiteSettingsProvider>,
      );
    });

    await waitFor(() => {
      const link = host.querySelector<HTMLAnchorElement>("a[href='https://beian.miit.gov.cn/']");
      expect(link?.textContent).toBe("粤ICP备12345678号-1");
    });
  });
});
