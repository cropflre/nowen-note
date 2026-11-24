import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PluginAppNavigation } from "../PluginApps";

const pinnedPages = vi.hoisted(() => ({ current: [] as Array<{ runtimeId: string; title: string; route: string }> }));

vi.mock("@/hooks/usePluginApps", () => ({
  usePluginApps: () => ({
    enabled: pinnedPages.current.length > 0, centerEnabled: true, dashboardEnabled: true,
    pages: pinnedPages.current, pinned: () => true,
  }),
}));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({ setMobileSidebar: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("navigation rail entry for the Extension Center", () => {
  let host: HTMLDivElement;
  let root: Root;
  const labels = () => Array.from(host.querySelectorAll("button"), button => button.getAttribute("aria-label"));

  beforeEach(() => {
    pinnedPages.current = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
  });

  // The workbench is the "Dashboard" tab of the Extension Center. A second rail entry opened the same page under the
  // same title, so users could not tell it from "Apps" (the workbench is available whenever the Extension Center is).
  it.each([true, false])("has no separate workbench entry (labels shown: %s)", async (showLabel) => {
    await act(async () => root.render(<PluginAppNavigation showLabel={showLabel} />));

    expect(labels()).toEqual(["pluginApps.title"]);
  });

  it("opens the Extension Center from its entry", async () => {
    await act(async () => root.render(<PluginAppNavigation showLabel />));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="pluginApps.title"]')!.click());

    expect(window.location.pathname).toBe("/apps");
  });

  it("lists pinned plugin pages after the Extension Center entry", async () => {
    pinnedPages.current = [{ runtimeId: "acme.notes/board", title: "Board", route: "/apps/acme.notes/board" }];
    await act(async () => root.render(<PluginAppNavigation showLabel />));

    expect(labels()).toEqual(["pluginApps.title", "Board"]);
  });
});
