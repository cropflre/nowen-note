import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMe: vi.fn(), confirm: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn(), push: vi.fn(),
  setViewMode: vi.fn(), setMobileView: vi.fn(),
  api: {
    features: vi.fn(), list: vi.fn(), registrySources: vi.fn(), registryIndex: vi.fn(), getRuntimePolicy: vi.fn(),
    installFromRegistry: vi.fn(), grant: vi.fn(), enable: vi.fn(), disable: vi.fn(), checkUpdates: vi.fn(), applyUpdate: vi.fn(),
    uninstall: vi.fn(), settings: vi.fn(), setSettings: vi.fn(), executions: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({ api: { getMe: mocks.getMe } }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: mocks.api, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "nowen:plugin-contributions-changed" }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo, warning: vi.fn() } }));
vi.mock("@/lib/appPathNavigation", () => ({ pushAppPathState: mocks.push }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({ setViewMode: mocks.setViewMode, setMobileView: mocks.setMobileView }) }));
vi.mock("@/lib/pluginUiRegistry", () => ({ currentUiPlatform: () => "web" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => (options && "name" in options ? `${key}|${String(options.name)}` : key) }),
}));
import ExtensionDiscover from "../ExtensionDiscover";

const official = { id: "official-v2", name: "Official", indexUrl: "https://x.invalid", official: true, enabled: true, registryKeyId: null, registryPublicKey: null };
const mirror = { id: "mirror", name: "Mirror", indexUrl: "https://m.invalid", official: false, enabled: true, registryKeyId: "k", registryPublicKey: "p" };
const writer = {
  id: "nowenlab.writer", publisher: "nowenlab", name: "Writer", description: "Writing tools", trustLevel: "official", category: "editor", keywords: ["markdown"],
  versions: [{ version: "1.0.0", runtime: "sandbox-js", nowen: ">=1.5.0 <2.0.0", permissions: ["notes:read"] }],
};

let root: Root, host: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const buttons = (label: string) => [...host.querySelectorAll("button")].filter((button) => button.textContent?.trim() === label);
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.getMe.mockResolvedValue({ role: "admin" });
  mocks.api.features.mockResolvedValue({ currentNowenVersion: "1.5.3", runtimePlatform: "server", applicationV3: { dashboardWidgets: true } });
  mocks.api.list.mockResolvedValue([]);
  mocks.api.registrySources.mockResolvedValue([official, mirror]);
  mocks.api.registryIndex.mockImplementation(async (source: string) => {
    if (source === "mirror") throw Object.assign(new Error("offline mirror"), { code: "REGISTRY_FETCH_FAILED" });
    return { extensions: [writer] };
  });
  mocks.api.getRuntimePolicy.mockResolvedValue({ allowNodeRuntime: false });
  mocks.api.installFromRegistry.mockResolvedValue({ success: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const render = async () => { await act(async () => root.render(<ExtensionDiscover dashboardAvailable appPagesAvailable />)); await flush(); };

describe("Extension Center discover", () => {
  it("shows verified catalog entries, built-in features and per-source failures", async () => {
    await render();
    expect(host.textContent).toContain("Writer");
    expect(host.textContent).toContain("extensionCenter.badge.official");
    expect(host.querySelector('[data-extension-card="builtin:dashboard"]')).not.toBeNull();
    expect(host.textContent).toContain("extensionCenter.discover.sourceFailed|Mirror");
  });

  it("installs only after the administrator confirms the real permission list", async () => {
    await render();
    mocks.confirm.mockResolvedValueOnce(false);
    await click(buttons("extensionCenter.action.install")[0]);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.api.installFromRegistry).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce(true);
    await click(buttons("extensionCenter.action.install")[0]);
    expect(mocks.api.installFromRegistry).toHaveBeenCalledWith("official-v2", "nowenlab.writer", "1.0.0");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("extensionCenter.toast.installed|Writer");
  });

  it("reports verification failures instead of a fake success", async () => {
    mocks.api.installFromRegistry.mockRejectedValueOnce(Object.assign(new Error("checksum"), { code: "REGISTRY_CHECKSUM_MISMATCH", status: 400 }));
    mocks.confirm.mockResolvedValue(true);
    await render();
    await click(buttons("extensionCenter.action.install")[0]);
    expect(mocks.toastError).toHaveBeenCalledWith("extensionCenter.error.signature");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("tells members to ask an administrator and never calls admin routes", async () => {
    mocks.getMe.mockResolvedValue({ role: "user" });
    await render();
    expect(mocks.api.getRuntimePolicy).not.toHaveBeenCalled();
    expect(buttons("extensionCenter.action.install")).toHaveLength(0);
    await click(buttons("extensionCenter.action.needsAdmin")[0]);
    // The drawer is portaled to <body> so transformed ancestors cannot trap position:fixed.
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("extensionCenter.needsAdmin");
    expect(mocks.api.installFromRegistry).not.toHaveBeenCalled();
  });

  it("opens built-in features through in-app navigation instead of installing anything", async () => {
    await render();
    const tasks = host.querySelector('[data-extension-card="builtin:tasks"]')!;
    await click([...tasks.querySelectorAll("button")].find((button) => button.textContent?.trim() === "extensionCenter.action.open")!);
    expect(mocks.push).toHaveBeenCalledWith("/");
    expect(mocks.setViewMode).toHaveBeenCalledWith("tasks");
    const studio = host.querySelector('[data-extension-card="builtin:studio"]')!;
    await click([...studio.querySelectorAll("button")].find((button) => button.textContent?.trim() === "extensionCenter.action.open")!);
    expect(mocks.push).toHaveBeenCalledWith("/apps/studio");
    expect(mocks.api.installFromRegistry).not.toHaveBeenCalled();
  });

  it("filters by search text and category and reloads after plugin changes", async () => {
    await render();
    const input = host.querySelector('input[type="search"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setValue.call(input, "markdown"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.querySelectorAll("[data-extension-card]")).toHaveLength(1);
    await act(async () => { setValue.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(buttons("extensionCenter.category.ai")[0]);
    expect([...host.querySelectorAll("[data-extension-card]")].map((card) => card.getAttribute("data-extension-card"))).toEqual(["builtin:ai-chat"]);

    const before = mocks.api.list.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event("nowen:plugin-contributions-changed")); });
    await flush();
    expect(mocks.api.list.mock.calls.length).toBe(before + 1);
  });
});
