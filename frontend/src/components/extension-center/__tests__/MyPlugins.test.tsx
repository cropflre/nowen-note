import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMe: vi.fn(), confirm: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn(), push: vi.fn(),
  api: {
    features: vi.fn(), list: vi.fn(), registrySources: vi.fn(), registryIndex: vi.fn(), getRuntimePolicy: vi.fn(),
    grant: vi.fn(), enable: vi.fn(), disable: vi.fn(), uninstall: vi.fn(), settings: vi.fn(), executions: vi.fn(), install: vi.fn(), personalApps: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({ api: { getMe: mocks.getMe } }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: mocks.api, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "nowen:plugin-contributions-changed" }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError, info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/appPathNavigation", () => ({ pushAppPathState: mocks.push }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({ setViewMode: vi.fn(), setMobileView: vi.fn() }) }));
vi.mock("@/lib/pluginUiRegistry", () => ({ currentUiPlatform: () => "web" }));
vi.mock("@/lib/pluginApps", () => ({ loadPluginAppPins: () => [], savePluginAppPins: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import MyPlugins from "../MyPlugins";

const pendingApp = {
  id: "nowenlab.hello-app", name: "Hello App", description: "", version: "0.1.0", apiVersion: 3, runtime: "declarative", executionMode: "sandboxed-ui",
  source: "package", trustLevel: "community", status: "quarantined", checksum: "x", actions: [],
  permissions: [{ permission: "plugin-storage:read", configJson: "{}", granted: 0 }, { permission: "plugin-storage:write", configJson: "{}", granted: 0 }],
  contributes: { appPages: [{ id: "home", title: "Home", entry: "ui/index.html", platforms: ["web"], requiredPermissions: [] }] },
};
const pendingTheme = { ...pendingApp, id: "nowenlab.theme-pack", name: "Theme Pack", apiVersion: 2, executionMode: "declarative-zero-code", permissions: [], contributes: {} };

let root: Root, host: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const button = (label: string, card?: string) => [...host.querySelectorAll(card ? `[data-extension-card="${card}"] button` : "button")].find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.getMe.mockResolvedValue({ role: "admin" });
  mocks.api.features.mockResolvedValue({ currentNowenVersion: "1.5.3", applicationV3: { appPages: true } });
  mocks.api.list.mockResolvedValue([pendingApp, pendingTheme]);
  mocks.api.registrySources.mockResolvedValue([]);
  mocks.api.personalApps.mockResolvedValue([]);
  mocks.api.uninstall.mockResolvedValue({ success: true });
  mocks.api.getRuntimePolicy.mockResolvedValue({ allowNodeRuntime: false });
  mocks.api.grant.mockResolvedValue({ success: true });
  mocks.api.enable.mockResolvedValue({ success: true });
  mocks.confirm.mockResolvedValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async () => { await act(async () => root.render(<MyPlugins dashboardAvailable appPagesAvailable />)); await flush(); };
const drop = async (...files: File[]) => {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  await act(async () => host.querySelector("h1")!.dispatchEvent(event));
  await flush();
  return event.defaultPrevented;
};

describe("My plugins", () => {
  it("grants exactly the declared permissions after confirmation, then enables", async () => {
    await render();
    // Technical runtime labels stay out of the card; they live in the details drawer.
    expect(host.querySelector('[data-extension-card="plugin:nowenlab.hello-app"]')?.textContent).not.toContain("pluginApps.executionLabel");
    await act(async () => button("extensionCenter.action.reviewEnable", "plugin:nowenlab.hello-app")!.click());
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.api.grant).toHaveBeenCalledWith("nowenlab.hello-app", ["plugin-storage:read", "plugin-storage:write"]);
    expect(mocks.api.enable).toHaveBeenCalledWith("nowenlab.hello-app");
  });

  it("enables declarative extensions without granting data permissions", async () => {
    await render();
    await act(async () => button("extensionCenter.action.reviewEnable", "plugin:nowenlab.theme-pack")!.click());
    await flush();
    expect(mocks.api.grant).not.toHaveBeenCalled();
    expect(mocks.api.enable).toHaveBeenCalledWith("nowenlab.theme-pack");
  });

  it("does nothing when the confirmation is cancelled", async () => {
    mocks.confirm.mockResolvedValue(false);
    await render();
    await act(async () => button("extensionCenter.action.reviewEnable", "plugin:nowenlab.hello-app")!.click());
    await flush();
    expect(mocks.api.grant).not.toHaveBeenCalled();
    expect(mocks.api.enable).not.toHaveBeenCalled();
  });

  it("keeps administrator tools and destructive actions away from members", async () => {
    mocks.getMe.mockResolvedValue({ role: "user" });
    await render();
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(button("extensionCenter.upload.button")).toBeUndefined();
    expect(host.querySelector('[aria-label="extensionCenter.mine.adminMenu"]')).toBeNull();
    expect(host.textContent).toContain("extensionCenter.mine.memberHint");
    expect(mocks.api.getRuntimePolicy).not.toHaveBeenCalled();
    await act(async () => (host.querySelector('[data-extension-card="plugin:nowenlab.hello-app"] [aria-haspopup="menu"]') as HTMLButtonElement).click());
    expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["extensionCenter.mine.detailsConfig"]);
  });

  it("handles wrong extensions and multiple dropped packages without opening a confirmation", async () => {
    await render();
    expect(await drop(new File([], "notes.txt"))).toBe(true);
    expect(await drop(new File([], "one.nowen-plugin"), new File([], "two.nowen-plugin"))).toBe(true);
    expect(mocks.toastError).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).toHaveBeenLastCalledWith("extensionCenter.upload.singlePackage");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.api.install).not.toHaveBeenCalled();
  });

  it("sends administrators to Settings for advanced tools instead of nesting a second manager", async () => {
    const opened = vi.fn();
    window.addEventListener("nowen:open-settings", opened);
    await render();
    expect(host.querySelector('input[type="file"][accept=".nowen-plugin"]')).not.toBeNull();
    expect(button("extensionCenter.upload.button")).toBeDefined();
    await act(async () => (host.querySelector('[aria-label="extensionCenter.mine.adminMenu"]') as HTMLButtonElement).click());
    await act(async () => button("extensionCenter.mine.advanced")!.click());
    window.removeEventListener("nowen:open-settings", opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: "extensions" });
  });

  it("offers both uninstall choices for apps and never deletes data by default", async () => {
    await render();
    await act(async () => (host.querySelector('[data-extension-card="plugin:nowenlab.hello-app"] [aria-haspopup="menu"]') as HTMLButtonElement).click());
    const items = [...host.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
    expect(items.map((item) => item.textContent)).toEqual(["extensionCenter.mine.detailsConfig", "extensionCenter.action.uninstallRetain", "extensionCenter.action.uninstallDelete"]);
    await act(async () => items[1].click());
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.api.uninstall).toHaveBeenCalledWith("nowenlab.hello-app", false, true);
  });

  it("lists apps the user created next to installed extensions", async () => {
    mocks.api.personalApps.mockResolvedValue([{ id: "01234567-89ab-cdef-0123-456789abcdef", revision: 1, spec: { name: "Trip plan", description: "", layout: "list", fields: [], items: [] } }]);
    await render();
    const card = host.querySelector('[data-studio-app="01234567-89ab-cdef-0123-456789abcdef"]')!;
    expect(card.textContent).toContain("Trip plan");
    await act(async () => (card.querySelector("button") as HTMLButtonElement).click());
    expect(mocks.push).toHaveBeenCalledWith("/apps/personal/01234567-89ab-cdef-0123-456789abcdef");
  });

  it("filters between created apps and installed extensions", async () => {
    mocks.api.personalApps.mockResolvedValue([{ id: "01234567-89ab-cdef-0123-456789abcdef", revision: 1, spec: { name: "Trip plan", description: "", layout: "list", fields: [], items: [] } }]);
    await render();
    expect(host.querySelectorAll("[data-studio-app]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-extension-card]")).toHaveLength(2);
    await act(async () => button("extensionCenter.mine.filterApps")!.click());
    expect(host.querySelectorAll("[data-studio-app]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-extension-card]")).toHaveLength(0);
    await act(async () => button("extensionCenter.mine.filterPlugins")!.click());
    expect(host.querySelectorAll("[data-studio-app]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-extension-card]")).toHaveLength(2);
  });

  it("points an empty list at Discover", async () => {
    mocks.api.list.mockResolvedValue([]);
    await render();
    expect(host.textContent).toContain("extensionCenter.mine.empty");
    await act(async () => button("extensionCenter.mine.browse")!.click());
    expect(mocks.push).toHaveBeenCalledWith("/apps/discover");
  });
});
