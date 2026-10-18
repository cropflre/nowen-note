import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ features: vi.fn(), inspectors: vi.fn(), platform: vi.fn(() => "web") }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { features: state.features, inspectors: state.inspectors }, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "plugins-changed" }));
vi.mock("@/lib/pluginUiRegistry", () => ({ currentUiPlatform: state.platform }));
vi.mock("../../components/PluginApps", () => ({ PluginAppFrame: ({ inspector }: any) => <div data-resource={JSON.stringify(inspector)} /> }));
import PluginInspector from "../../components/PluginInspector";

const inspector = { pluginId: "nowenlab.inspect", inspectorId: "summary", id: "home", title: "Summary", resourceTypes: ["note"] };
let root: Root, container: HTMLDivElement;
const dialogMethods = ["showModal", "close"] as const;
const originalDialogMethods = dialogMethods.map(name => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name));
afterAll(() => dialogMethods.forEach((name, index) => {
  const original = originalDialogMethods[index];
  if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else delete (HTMLDialogElement.prototype as any)[name];
}));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  state.features.mockReset().mockResolvedValue({ applicationV3: { inspectors: true } });
  state.inspectors.mockReset().mockResolvedValue([inspector]); state.platform.mockReturnValue("web");
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(id = "note-a") { await act(async () => root.render(<PluginInspector resource={{ type: "note", id }} workspaceId="space" />)); }
async function open() { await act(async () => container.querySelector("button")!.click()); }

it("starts a manually opened inspector with the selected resource and workspace", async () => {
  await render(); expect(document.querySelector("dialog")).toBeNull(); await open();
  expect(state.inspectors).toHaveBeenCalledWith("web", "note", "space");
  expect(JSON.parse(document.querySelector("[data-resource]")!.getAttribute("data-resource")!)).toEqual({ id: "summary", resource: { type: "note", id: "note-a" } });
});
it("unmounts the old frame immediately when the selected resource changes", async () => {
  await render(); await open(); await render("note-b");
  expect(document.querySelector("dialog")).toBeNull(); await open();
  expect(document.querySelector("[data-resource]")?.getAttribute("data-resource")).toContain("note-b");
});
it("discards an old resource's delayed registry response", async () => {
  let resolve!: (value: unknown) => void;
  state.inspectors.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await render(); state.inspectors.mockResolvedValue([]); await render("note-b");
  await act(async () => resolve([inspector])); expect(container.querySelector("button")).toBeNull();
});
it("closes the inspector on account or workspace change", async () => {
  for (const event of ["nowen:token-changed", "nowen:workspace-changed"]) {
    await render(); await open();
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(document.querySelector("dialog")).toBeNull();
  }
});
it("hides the entry when the feature is off or the native platform is unsupported", async () => {
  state.features.mockResolvedValue({ applicationV3: { inspectors: false } }); await render();
  expect(container.querySelector("button")).toBeNull(); expect(state.inspectors).not.toHaveBeenCalled();
  state.platform.mockReturnValue("android"); state.features.mockClear(); await render("note-b");
  expect(state.features).not.toHaveBeenCalled();
});
