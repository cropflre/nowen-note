import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberServerInstanceId, setServerTransportEndpoint } from "@/lib/serverEndpointState";
const mocks = vi.hoisted(() => ({ native: true, local: false }));
vi.mock("@/lib/api", () => ({ getServerUrl: () => "https://notes.example.com", isNativeCapacitor: () => mocks.native, SERVER_URL_CHANGED_EVENT: "nowen:server-url-changed" }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => mocks.local }));
import ServerConnectionSettings from "../ServerConnectionSettings";
let container: HTMLDivElement;
let root: Root;
const url = "https://notes.example.com";
beforeEach(() => {
  localStorage.clear(); mocks.native = true; mocks.local = false;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); setServerTransportEndpoint(url, url); });
describe("mobile server connection settings", () => {
  it("shows the verified connection and can disable automatic selection without changing the account", async () => {
    localStorage.setItem("nowen-server-url", url); localStorage.setItem("nowen-token", "same-token");
    rememberServerInstanceId(url, "instance-123");
    setServerTransportEndpoint(url, "http://192.168.1.10:3001", "NAS");
    await act(async () => root.render(<ServerConnectionSettings />));
    expect(container.textContent).toContain("NAS"); expect(container.textContent).toContain("局域网");
    expect(container.textContent).toContain("instance");
    const checkbox = container.querySelector("input")!;
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(false);
    expect(container.textContent).not.toContain("http://192.168.1.10:3001");
    expect(localStorage.getItem("nowen-server-url")).toBe(url); expect(localStorage.getItem("nowen-token")).toBe("same-token");
  });
  it.each(["web", "local"])("does not show server routing controls in %s mode", async (mode) => {
    mocks.native = mode !== "web"; mocks.local = mode === "local";
    await act(async () => root.render(<ServerConnectionSettings />));
    expect(container.textContent).toBe("");
  });
});
