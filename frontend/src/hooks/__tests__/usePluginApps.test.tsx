import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePluginApps } from "../usePluginApps";

const mocks = vi.hoisted(() => ({ features: vi.fn(), apps: vi.fn() }));
vi.mock("@/lib/pluginApi", () => ({
  PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "nowen:plugin-contributions-changed",
  pluginApi: { features: mocks.features, apps: mocks.apps },
}));
vi.mock("@/lib/pluginApps", () => ({ loadPluginAppPins: () => [] }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Capacitor = { getPlatform?: () => string; isNativePlatform?: () => boolean };

function Probe() {
  const { enabled, centerEnabled, dashboardEnabled, pages } = usePluginApps();
  return <output>{JSON.stringify({ enabled, centerEnabled, dashboardEnabled, pages: pages.length })}</output>;
}

describe("Extension Center platform range", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.features.mockResolvedValue({ applicationV3: { appPages: true } });
    mocks.apps.mockResolvedValue([{ runtimeId: "nowenlab.hello-app:home" }]);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (window as Window & { Capacitor?: Capacitor }).Capacitor;
  });

  async function render() {
    await act(async () => root.render(<Probe />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return JSON.parse(host.textContent || "{}");
  }

  it.each([
    ["android", { getPlatform: () => "android", isNativePlatform: () => true }],
    ["ios", { getPlatform: () => "ios", isNativePlatform: () => true }],
    ["another native shell", { getPlatform: () => "web", isNativePlatform: () => true }],
  ])("stays hidden on %s and never asks the server", async (_name, capacitor) => {
    (window as Window & { Capacitor?: Capacitor }).Capacitor = capacitor;
    expect(await render()).toEqual({ enabled: false, centerEnabled: false, dashboardEnabled: false, pages: 0 });
    expect(mocks.features).not.toHaveBeenCalled();
    expect(mocks.apps).not.toHaveBeenCalled();
  });

  it("opens on the web; app pages follow the server's V3 switch", async () => {
    expect(await render()).toEqual({ enabled: true, centerEnabled: true, dashboardEnabled: true, pages: 1 });
    expect(mocks.apps).toHaveBeenCalledWith("web");
    await act(async () => root.unmount());
    root = createRoot(host);
    mocks.features.mockResolvedValue({ applicationV3: { appPages: false } });
    expect(await render()).toEqual({ enabled: false, centerEnabled: true, dashboardEnabled: true, pages: 0 });
  });
});
