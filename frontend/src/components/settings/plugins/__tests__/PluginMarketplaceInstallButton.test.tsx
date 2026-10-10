import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryPlugin } from "@/lib/pluginApi";

const mocks = vi.hoisted(() => ({ install: vi.fn(), getPolicy: vi.fn(), setPolicy: vi.fn() }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { installFromRegistry: mocks.install, getRuntimePolicy: mocks.getPolicy, setRuntimePolicy: mocks.setPolicy } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PluginMarketplaceInstallButton } from "../PluginMarketplaceInstallButton";
import { PluginRuntimePolicySettings } from "../PluginRuntimePolicySettings";

const plugin: RegistryPlugin = { id: "nowenlab.wechat-capture", publisher: "nowenlab", name: "WeChat", latestVersion: "1.0.0", runtime: "node-action", trustLevel: "official" };

describe("marketplace installation", () => {
  let root: Root; let host: HTMLDivElement; const installed = vi.fn();
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); mocks.install.mockResolvedValue({ success: true }); installed.mockResolvedValue(undefined);
    mocks.getPolicy.mockResolvedValue({ allowNodeRuntime: false });
    mocks.setPolicy.mockResolvedValue({ allowNodeRuntime: true });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  const render = async (allowed: boolean | null, value = plugin) => { await act(async () => root.render(<PluginMarketplaceInstallButton sourceId="official-v2" plugin={value} nodeRuntimeAllowed={allowed} onInstalled={installed} />)); };
  const click = async () => { await act(async () => host.querySelector("button")!.click()); };

  it("blocks Node installation until the policy is loaded and allowed", async () => {
    await render(null); expect(host.textContent).toContain("plugins.marketplace.policyLoading"); await click();
    await render(false); expect(host.textContent).toContain("plugins.marketplace.policyRequired"); await click();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("updates the install button immediately after the administrator saves the policy", async () => {
    function Market() {
      const [allowed, setAllowed] = useState<boolean | null>(null);
      return <><PluginRuntimePolicySettings onPolicyChange={setAllowed} /><PluginMarketplaceInstallButton sourceId="official-v2" plugin={plugin} nodeRuntimeAllowed={allowed} onInstalled={installed} /></>;
    }
    await act(async () => root.render(<Market />)); expect(host.querySelector("button")!.disabled).toBe(true);
    await act(async () => host.querySelector("input")!.click());
    expect(host.querySelector("button")!.disabled).toBe(false); await click();
    expect(mocks.install).toHaveBeenCalledWith("official-v2", plugin.id, "1.0.0"); expect(installed).toHaveBeenCalledOnce();
  });

  it("leaves sandbox installation available while Node is denied", async () => {
    await render(false, { ...plugin, runtime: "sandbox-js" }); await click();
    expect(mocks.install).toHaveBeenCalledOnce(); expect(installed).toHaveBeenCalledOnce();
  });

  it("catches a service policy rejection without navigating or leaving the button busy", async () => {
    mocks.install.mockRejectedValue(Object.assign(new Error("企业策略禁止 Official/Verified V2 Node Runtime"), { code: "PLUGIN_POLICY_DENIED", status: 400 }));
    await render(true); await click();
    expect(host.querySelector("[role=alert]")!.textContent).toContain("企业策略禁止");
    expect(installed).not.toHaveBeenCalled(); expect(host.querySelector("button")!.disabled).toBe(false);
  });

  it("shows a sign-in instruction when the API returns 401", async () => {
    mocks.install.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await render(true); await click(); expect(host.querySelector("[role=alert]")!.textContent).toBe("plugins.marketplace.loginRequired");
  });

  it("prevents duplicate requests during installation and catches refresh failures", async () => {
    let complete!: () => void;
    mocks.install.mockReturnValue(new Promise<void>((resolve) => { complete = resolve; }));
    await render(true); await click(); await click(); expect(mocks.install).toHaveBeenCalledOnce();
    expect(host.querySelector("button")!.disabled).toBe(true);
    installed.mockRejectedValue(new Error("Refresh failed")); await act(async () => complete());
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Refresh failed"); expect(host.querySelector("button")!.disabled).toBe(false);
  });
});
