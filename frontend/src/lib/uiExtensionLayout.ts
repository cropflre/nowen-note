import type { RegisteredPluginUiAction } from "./pluginUiRegistry";

export type FloatingLayerPosition = "bottom-left" | "bottom-center" | "bottom-right" | "left-center" | "right-center";

export interface UiExtensionLayout {
  version: 1;
  position: FloatingLayerPosition;
  order: string[];
  hidden: string[];
}

export const DEFAULT_UI_EXTENSION_LAYOUT: UiExtensionLayout = {
  version: 1,
  position: "bottom-center",
  order: [],
  hidden: [],
};

const POSITIONS = new Set<FloatingLayerPosition>(["bottom-left", "bottom-center", "bottom-right", "left-center", "right-center"]);

export function sanitizeUiExtensionLayout(value: unknown): UiExtensionLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_UI_EXTENSION_LAYOUT };
  const candidate = value as Partial<UiExtensionLayout>;
  const uniqueStrings = (items: unknown) => Array.isArray(items)
    ? [...new Set(items.filter((item): item is string => typeof item === "string" && item.length <= 220))].slice(0, 200)
    : [];
  return {
    version: 1,
    position: POSITIONS.has(candidate.position as FloatingLayerPosition) ? candidate.position as FloatingLayerPosition : "bottom-center",
    order: uniqueStrings(candidate.order),
    hidden: uniqueStrings(candidate.hidden),
  };
}

export function resolveFloatingLayer(components: RegisteredPluginUiAction[], layout: UiExtensionLayout): RegisteredPluginUiAction[] {
  const hidden = new Set(layout.hidden);
  const order = new Map(layout.order.map((id, index) => [id, index]));
  return components
    .filter((component) => component.allowedSlots.includes("floating-layer")
      && (component.defaultPlacement?.slot === "floating-layer" || order.has(component.runtimeId))
      && !hidden.has(component.runtimeId))
    .sort((left, right) => {
      const leftOrder = order.get(left.runtimeId) ?? left.defaultPlacement?.order ?? 500;
      const rightOrder = order.get(right.runtimeId) ?? right.defaultPlacement?.order ?? 500;
      return leftOrder - rightOrder || left.runtimeId.localeCompare(right.runtimeId);
    });
}

function userScope(): string {
  try {
    const token = localStorage.getItem("nowen-token") || "";
    const payload = token.split(".")[1];
    if (!payload) return "local-user";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as { userId?: string; sub?: string };
    return parsed.userId || parsed.sub || "local-user";
  } catch {
    return "local-user";
  }
}

export function uiExtensionLayoutStorageKey(): string {
  return `nowen-ui-extension-layout:v1:${userScope()}`;
}

export function loadUiExtensionLayout(): UiExtensionLayout {
  try {
    return sanitizeUiExtensionLayout(JSON.parse(localStorage.getItem(uiExtensionLayoutStorageKey()) || "null"));
  } catch {
    return { ...DEFAULT_UI_EXTENSION_LAYOUT };
  }
}

export function saveUiExtensionLayout(layout: UiExtensionLayout): void {
  try {
    localStorage.setItem(uiExtensionLayoutStorageKey(), JSON.stringify(sanitizeUiExtensionLayout(layout)));
  } catch {
    // Restricted/private browser storage must not break navigation.
  }
}

export function resolveFloatingLayerPosition(x: number, y: number, width: number, height: number): FloatingLayerPosition {
  if (x < width * 0.25) return y < height * 0.72 ? "left-center" : "bottom-left";
  if (x > width * 0.75) return y < height * 0.72 ? "right-center" : "bottom-right";
  return "bottom-center";
}
