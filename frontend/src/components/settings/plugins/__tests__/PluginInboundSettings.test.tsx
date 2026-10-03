import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@/lib/pluginApi";

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { inboundWebhooks: mocks.list, createInboundWebhook: mocks.create, removeInboundWebhook: mocks.remove } }));
vi.mock("@/lib/api.impl", () => ({ getBaseUrl: () => "https://note.example.com/api" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PluginInboundSettings } from "../PluginInboundSettings";

const plugin = { id: "example.capture", status: "enabled", contributes: { inboundWebhooks: [{ id: "receiver", path: "receiver", action: "receive", methods: ["GET", "POST"], maxBodyBytes: 262144 }] } } as InstalledPlugin;

describe("inbound callback configuration", () => {
  let root: Root; let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ path: "/api/plugin-inbound/example.capture/receiver/token" });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  const render = async (value = plugin) => { await act(async () => root.render(<PluginInboundSettings plugin={value} />)); };
  const click = async (label: string) => { await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click()); };

  it("creates a URL using the configured API origin and shows it only in this view", async () => {
    await render(); mocks.list.mockResolvedValue([{ hookId: "receiver" }]);
    await click("plugins.inbound.create");
    expect(mocks.create).toHaveBeenCalledWith(plugin.id, "receiver");
    expect(host.querySelector("input")?.value).toBe("https://note.example.com/api/plugin-inbound/example.capture/receiver/token");
    await act(async () => root.unmount()); root = createRoot(host);
    await render(); expect(host.querySelector("input")).toBeNull();
  });

  it("requires confirmation for rotation/revocation and clears revoked URLs", async () => {
    mocks.list.mockResolvedValue([{ hookId: "receiver" }]); await render();
    vi.mocked(window.confirm).mockReturnValue(false); await click("plugins.inbound.rotate");
    expect(mocks.create).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true); await click("plugins.inbound.rotate");
    mocks.list.mockResolvedValue([]); await click("plugins.inbound.revoke");
    expect(mocks.remove).toHaveBeenCalledWith(plugin.id, "receiver"); expect(host.querySelector("input")).toBeNull();
  });

  it("disables callback creation for disabled plugins", async () => {
    await render({ ...plugin, status: "disabled" });
    expect(host.querySelector("button")?.disabled).toBe(true);
  });
});
