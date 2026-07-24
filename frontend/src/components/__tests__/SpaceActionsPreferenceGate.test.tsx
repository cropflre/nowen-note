import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SpaceActionsPreferenceGate from "@/components/SpaceActionsPreferenceGate";

const preferenceState = vi.hoisted(() => ({ showSpaceActions: true }));
vi.mock("@/hooks/useUserPreferences", () => ({
  useUserPreferences: () => ({ prefs: preferenceState, setPref: vi.fn() }),
}));
vi.mock("@/components/PublicSpaceLauncher", () => ({
  default: ({ visible }: { visible?: boolean }) => (
    <div data-space-actions-launcher="true" data-visible={String(visible)} />
  ),
}));

describe("SpaceActionsPreferenceGate", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    preferenceState.showSpaceActions = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  it("passes visibility without unmounting the legacy-trigger guard", () => {
    act(() => root.render(<SpaceActionsPreferenceGate />));
    expect(host.querySelector('[data-visible="true"]')).not.toBeNull();
    preferenceState.showSpaceActions = false;
    act(() => root.render(<SpaceActionsPreferenceGate />));
    expect(host.querySelector('[data-visible="false"]')).not.toBeNull();
  });
});
