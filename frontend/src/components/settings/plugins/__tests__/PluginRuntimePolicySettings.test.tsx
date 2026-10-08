import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { getRuntimePolicy: mocks.get, setRuntimePolicy: mocks.set } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PluginRuntimePolicySettings } from "../PluginRuntimePolicySettings";

describe("administrator Node Runtime policy", () => {
  let root: Root; let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); mocks.get.mockResolvedValue({ allowNodeRuntime: false });
    mocks.set.mockImplementation(async (enabled) => ({ allowNodeRuntime: enabled }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  const render = async () => { await act(async () => root.render(<PluginRuntimePolicySettings />)); };
  const click = async () => { await act(async () => host.querySelector("input")!.click()); };

  it("keeps the secure default and requires confirmation to enable the policy", async () => {
    await render(); expect(host.querySelector("input")!.checked).toBe(false);
    vi.mocked(window.confirm).mockReturnValue(false); await click();
    expect(mocks.set).not.toHaveBeenCalled(); expect(host.querySelector("input")!.checked).toBe(false);
    vi.mocked(window.confirm).mockReturnValue(true); await click();
    expect(mocks.set).toHaveBeenCalledWith(true); expect(host.querySelector("input")!.checked).toBe(true);
    await click(); expect(mocks.set).toHaveBeenLastCalledWith(false);
    expect(window.confirm).toHaveBeenCalledTimes(2);
  });

  it("shows a rejected policy update without changing the checkbox", async () => {
    await render(); mocks.set.mockRejectedValue(new Error("Forbidden")); await click();
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Forbidden");
    expect(host.querySelector("input")!.checked).toBe(false);
  });

  it("blocks changes when the administrator policy cannot be loaded", async () => {
    mocks.get.mockRejectedValue(new Error("Unavailable")); await render();
    expect(host.querySelector("input")!.disabled).toBe(true);
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Unavailable");
  });

  it("reports loaded and saved policy to the marketplace, but never reports a rejected change", async () => {
    const changed = vi.fn();
    await act(async () => root.render(<PluginRuntimePolicySettings onPolicyChange={changed} />));
    expect(changed.mock.calls.map(([value]) => value)).toEqual([null, false]);
    mocks.set.mockRejectedValueOnce(new Error("Forbidden")); await click();
    expect(changed).toHaveBeenLastCalledWith(false);
    await click(); expect(changed).toHaveBeenLastCalledWith(true);
  });
});
