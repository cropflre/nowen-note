import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PluginAppNavigation } from "../PluginApps";

vi.mock("@/hooks/usePluginApps", () => ({
  usePluginApps: () => ({ enabled: false, centerEnabled: true, dashboardEnabled: true, pages: [], pinned: () => false }),
}));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({ setMobileSidebar: vi.fn() }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("navigation rail entries for the Extension Center", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  // With the rail collapsed there is no text under the icons, so the drawing is the only difference between entries.
  it.each([true, false])("draws the Apps and Workbench entries with different icons (labels shown: %s)", async (showLabel) => {
    await act(async () => root.render(<PluginAppNavigation showLabel={showLabel} />));
    const drawing = (label: string) => host.querySelector(`button[aria-label="${label}"] svg`)?.innerHTML;

    expect(drawing("pluginApps.title")).toBeTruthy();
    expect(drawing("pluginApps.dashboard")).toBeTruthy();
    expect(drawing("pluginApps.title")).not.toBe(drawing("pluginApps.dashboard"));
  });
});
