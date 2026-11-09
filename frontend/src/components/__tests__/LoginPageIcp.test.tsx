import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../LoginPage";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockIcpBeian = "";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({
    siteConfig: {
      title: "nowen-note",
      favicon: "",
      icpBeian: mockIcpBeian,
      editorFontFamily: "",
    },
  }),
}));

vi.mock("@/hooks/useCapacitor", () => ({
  useKeyboardLayout: () => {},
}));

vi.mock("@/hooks/useKeyboardVisible", () => ({
  useKeyboardVisible: () => ({ height: 0 }),
}));

vi.mock("@/lib/api", () => ({
  clearServerUrl: vi.fn(),
  fetchRegisterConfig: vi.fn(async () => ({ allowRegistration: true, hasUsers: true })),
  getServerUrl: vi.fn(() => ""),
  registerAccount: vi.fn(),
  setServerUrl: vi.fn(),
  testServerConnection: vi.fn(async () => ({ ok: true })),
}));

async function renderLoginPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<LoginPage onLogin={vi.fn()} />);
    await Promise.resolve();
  });
  return { host, root };
}

describe("LoginPage ICP 备案号", () => {
  let root: Root | null = null;

  beforeEach(() => {
    mockIcpBeian = "";
    delete (window as any).nowenDesktop;
    delete (window as any).Capacitor;
    localStorage.clear();
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("Web 登录页在数据库备案号非空时展示备案链接", async () => {
    mockIcpBeian = "粤ICP备12345678号-1";

    const rendered = await renderLoginPage();
    root = rendered.root;

    const link = rendered.host.querySelector<HTMLAnchorElement>("a[href='https://beian.miit.gov.cn/']");
    expect(link?.textContent).toBe("粤ICP备12345678号-1");
    expect(link?.target).toBe("_blank");
  });

  it("备案号为空时不展示备案链接", async () => {
    mockIcpBeian = "   ";

    const rendered = await renderLoginPage();
    root = rendered.root;

    expect(rendered.host.textContent).not.toContain("ICP备");
  });

  it("移动端原生客户端运行时不展示备案号", async () => {
    mockIcpBeian = "粤ICP备12345678号-1";
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      platform: "android",
    };

    const rendered = await renderLoginPage();
    root = rendered.root;

    expect(rendered.host.textContent).not.toContain("粤ICP备12345678号-1");
  });

  it("Electron 桌面端登录页仍展示备案号", async () => {
    mockIcpBeian = "粤ICP备12345678号-1";
    (window as any).nowenDesktop = { isDesktop: true };

    const rendered = await renderLoginPage();
    root = rendered.root;

    expect(rendered.host.textContent).toContain("粤ICP备12345678号-1");
  });
});
