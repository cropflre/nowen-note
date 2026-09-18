// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { clearPluginUiComponents, listPluginUiComponents, replacePluginUiComponents } from "@/lib/pluginUiRegistry";
import {
  DEFAULT_UI_EXTENSION_LAYOUT,
  loadUiExtensionLayout,
  resolveFloatingLayer,
  resolveFloatingLayerPosition,
  saveUiExtensionLayout,
  uiExtensionLayoutStorageKey,
} from "@/lib/uiExtensionLayout";

const contributions = [{
  pluginId: "nowenlab.floating-dock",
  uiComponents: [
    { id: "tasks", kind: "action" as const, label: "Tasks", icon: "tasks" as const, allowedSlots: ["floating-layer" as const], defaultPlacement: { slot: "floating-layer" as const, order: 20 }, action: { type: "navigation.open" as const, target: "tasks" as const } },
    { id: "all", kind: "action" as const, label: "All", icon: "home" as const, allowedSlots: ["floating-layer" as const], defaultPlacement: { slot: "floating-layer" as const, order: 10 }, action: { type: "navigation.open" as const, target: "all" as const } },
  ],
}];

afterEach(() => {
  clearPluginUiComponents();
  localStorage.clear();
});

describe("Plugin UI Registry and layout resolver", () => {
  it("namespaces components and resolves the manifest default order", () => {
    replacePluginUiComponents(contributions);
    const resolved = resolveFloatingLayer(listPluginUiComponents("web"), DEFAULT_UI_EXTENSION_LAYOUT);
    expect(resolved.map((item) => item.runtimeId)).toEqual([
      "nowenlab.floating-dock/all",
      "nowenlab.floating-dock/tasks",
    ]);
  });

  it("applies user ordering and visibility without changing plugin declarations", () => {
    replacePluginUiComponents(contributions);
    const resolved = resolveFloatingLayer(listPluginUiComponents("web"), {
      version: 1,
      position: "right-center",
      order: ["nowenlab.floating-dock/tasks"],
      hidden: ["nowenlab.floating-dock/all"],
    });
    expect(resolved.map((item) => item.id)).toEqual(["tasks"]);
  });

  it("persists a sanitized user-scoped device layout", () => {
    saveUiExtensionLayout({ version: 1, position: "bottom-right", order: ["dock/tasks", "dock/tasks"], hidden: [] });
    expect(uiExtensionLayoutStorageKey()).toContain("local-user");
    expect(loadUiExtensionLayout()).toEqual({ version: 1, position: "bottom-right", order: ["dock/tasks"], hidden: [] });
  });

  it("snaps pointer releases to supported floating positions", () => {
    expect(resolveFloatingLayerPosition(10, 300, 1000, 800)).toBe("left-center");
    expect(resolveFloatingLayerPosition(990, 790, 1000, 800)).toBe("bottom-right");
    expect(resolveFloatingLayerPosition(500, 790, 1000, 800)).toBe("bottom-center");
  });

  it("rejects unknown icons and navigation actions defensively", () => {
    replacePluginUiComponents([{ pluginId: "bad.plugin", uiComponents: [{ ...contributions[0].uiComponents[0], icon: "remote-svg" as never }] }]);
    expect(listPluginUiComponents("web")).toEqual([]);
    replacePluginUiComponents([{ ...contributions[0], pluginId: "INVALID" }]);
    expect(listPluginUiComponents("web")).toEqual([]);
  });
});
