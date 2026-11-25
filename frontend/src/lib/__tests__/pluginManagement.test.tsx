import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ getMe: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { getMe: state.getMe } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../components/settings/plugins/PluginSettingsTab", () => ({ default: ({ isAdmin }: { isAdmin: boolean }) => <div data-admin={String(isAdmin)} /> }));
import PluginManagementPanel from "../../components/PluginManagementPanel";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); state.getMe.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("preserves administrator and ordinary-user management controls", async () => {
  state.getMe.mockResolvedValue({ role: "admin" }); await act(async () => root.render(<PluginManagementPanel />));
  expect(container.querySelector("[data-admin]")?.getAttribute("data-admin")).toBe("true");
  state.getMe.mockResolvedValue({ role: "user" }); await act(async () => window.dispatchEvent(new Event("nowen:token-changed")));
  expect(container.querySelector("[data-admin]")?.getAttribute("data-admin")).toBe("false");
});
it("does not restore old administrator controls after an identity change", async () => {
  let resolve!: (value: unknown) => void;
  state.getMe.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => root.render(<PluginManagementPanel />));
  state.getMe.mockResolvedValue({ role: "user" }); await act(async () => window.dispatchEvent(new Event("nowen:token-changed")));
  await act(async () => resolve({ role: "admin" }));
  expect(container.querySelector("[data-admin]")?.getAttribute("data-admin")).toBe("false");
});
it("shows a retry when identity loading fails without opening the manager", async () => {
  state.getMe.mockRejectedValue(new Error("offline")); await act(async () => root.render(<PluginManagementPanel />));
  expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(container.querySelector("[data-admin]")).toBeNull();
  state.getMe.mockResolvedValue({ role: "admin" }); await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("[data-admin]")?.getAttribute("data-admin")).toBe("true");
});
