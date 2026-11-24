import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEditorActionsCache, useEditorActions } from "../useEditorActions";

const mocks = vi.hoisted(() => ({ features: vi.fn(), contributions: vi.fn() }));
vi.mock("@/lib/pluginApi", () => ({
  PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "nowen:plugin-contributions-changed",
  pluginApi: { features: mocks.features, contributions: mocks.contributions },
}));
// The registry is tested on its own; here each contribution stands for one registered action.
vi.mock("@/lib/editorActions/registry", () => ({ registerEditorActions: (items: Array<{ id: string }>) => items.map((item) => ({ key: item.id })) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Capacitor = { getPlatform?: () => string };

function Editor({ name }: { name: string }) {
  const actions = useEditorActions(true);
  return <output data-editor={name}>{actions.length}</output>;
}

describe("editor actions shared by every open editor", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetEditorActionsCache();
    mocks.features.mockResolvedValue({ editorActions: true });
    mocks.contributions.mockResolvedValue([{ id: "text-tools" }]);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (window as Window & { Capacitor?: Capacitor }).Capacitor;
  });

  const counts = () => Array.from(host.querySelectorAll("output")).map((node) => node.textContent);
  async function render() {
    await act(async () => root.render(<><Editor name="rich" /><Editor name="markdown" /></>));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it("loads once for all editors and drops the actions as soon as a plugin is disabled", async () => {
    await render();
    expect(counts()).toEqual(["1", "1"]);
    expect(mocks.contributions).toHaveBeenCalledTimes(1);
    mocks.contributions.mockResolvedValue([]);
    await act(async () => { window.dispatchEvent(new Event("nowen:plugin-contributions-changed")); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(counts()).toEqual(["0", "0"]);
    expect(mocks.contributions).toHaveBeenCalledTimes(2);
  });

  it("asks for nothing while the server switch is off or inside the native apps", async () => {
    mocks.features.mockResolvedValue({ editorActions: false });
    await render();
    expect(counts()).toEqual(["0", "0"]);
    expect(mocks.contributions).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(host);
    resetEditorActionsCache();
    vi.clearAllMocks();
    (window as Window & { Capacitor?: Capacitor }).Capacitor = { getPlatform: () => "android" };
    await render();
    expect(counts()).toEqual(["0", "0"]);
    expect(mocks.features).not.toHaveBeenCalled();
  });
});
