import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
const state = vi.hoisted(() => ({ exportData: vi.fn(), importData: vi.fn(), workspace: vi.fn(() => "personal") }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { exportData: state.exportData, importData: state.importData } }));
vi.mock("@/lib/api", () => ({ getCurrentWorkspace: state.workspace }));
import PluginDataActions from "../../components/PluginDataActions";
const snapshot = { format: 1, pluginId: "nowenlab.demo", digest: "saved", entries: [{ key: "message", value: "retained" }] };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  state.exportData.mockReset().mockResolvedValue({ ...snapshot, digest: "current" }); state.importData.mockReset().mockResolvedValue({ success: true });
  state.workspace.mockReturnValue("personal"); localStorage.setItem("nowen-token", "original-account");
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
async function restore() {
  await act(async () => root.render(<PluginDataActions pluginId="nowenlab.demo" />));
  const input = container.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [{ size: 100, text: async () => JSON.stringify(snapshot) }] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
describe("app data restore scope", () => {
  it("rejects an account change while the confirmation dialog is open", async () => {
    vi.spyOn(window, "confirm").mockImplementation(() => { localStorage.setItem("nowen-token", "other-account"); return true; });
    await restore(); expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(state.exportData).not.toHaveBeenCalled(); expect(state.importData).not.toHaveBeenCalled();
  });
  it("rejects a workspace change while loading the current digest", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    state.exportData.mockImplementation(async () => { state.workspace.mockReturnValue("other-space"); return { ...snapshot, digest: "current" }; });
    await restore(); expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(state.importData).not.toHaveBeenCalled();
  });
  it("binds a confirmed restore to the original account, workspace and current digest", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true); await restore();
    expect(state.importData).toHaveBeenCalledWith("nowenlab.demo", "personal", snapshot, "current");
  });
});
