import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMe: vi.fn(), confirm: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn(), push: vi.fn(),
  api: {
    features: vi.fn(), list: vi.fn(), registrySources: vi.fn(), registryIndex: vi.fn(), getRuntimePolicy: vi.fn(),
    grant: vi.fn(), enable: vi.fn(), disable: vi.fn(), uninstall: vi.fn(), settings: vi.fn(), executions: vi.fn(), install: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({ api: { getMe: mocks.getMe } }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: mocks.api, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "nowen:plugin-contributions-changed" }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError, info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/appPathNavigation", () => ({ pushAppPathState: mocks.push }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({ setViewMode: vi.fn(), setMobileView: vi.fn() }) }));
vi.mock("@/lib/pluginUiRegistry", () => ({ currentUiPlatform: () => "web" }));
vi.mock("../../PluginManagementPanel", () => ({ default: () => <div data-legacy-manager /> }));
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
  mocks.api.getRuntimePolicy.mockResolvedValue({ allowNodeRuntime: false });
  mocks.api.grant.mockResolvedValue({ success: true });
  mocks.api.enable.mockResolvedValue({ success: true });
  mocks.confirm.mockResolvedValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async () => { await act(async () => root.render(<MyPlugins dashboardAvailable appPagesAvailable />)); await flush(); };

describe("My plugins", () => {
  it("grants exactly the declared permissions after confirmation, then enables", async () => {
    await render();
    expect(host.querySelector('[data-extension-card="plugin:nowenlab.hello-app"]')?.textContent).toContain("pluginApps.executionLabel");
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

  it("keeps package upload and advanced tools away from members", async () => {
    mocks.getMe.mockResolvedValue({ role: "user" });
    mocks.api.list.mockResolvedValue([]);
    await render();
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(button("extensionCenter.myPlugins.advanced")).toBeUndefined();
    expect(host.textContent).toContain("extensionCenter.myPlugins.memberHint");
    expect(mocks.api.getRuntimePolicy).not.toHaveBeenCalled();
  });

  it("offers the legacy manager under Advanced for administrators", async () => {
    await render();
    expect(host.querySelector('input[type="file"][accept=".nowen-plugin"]')).not.toBeNull();
    await act(async () => button("extensionCenter.myPlugins.advanced")!.click());
    await flush();
    expect(host.querySelector("[data-legacy-manager]")).not.toBeNull();
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });
});
