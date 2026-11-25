import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import McpConnectionPanel from "../McpConnectionPanel";

const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), copy: vi.fn(), scope: "server:user-1", apiUrl: "https://nowen.test/prefix/api" }));
vi.mock("@/lib/api", () => ({ getBaseUrl: () => mocks.apiUrl }));
vi.mock("@/lib/migrations", () => ({ migrationApi: { capabilities: mocks.capabilities } }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => { const t = (key: string) => key; return { useTranslation: () => ({ t }) }; });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const caps = { schemaVersion: 1, formats: ["nmf-v1"], humanApprovalRequired: true, adapters: [{ id: "generic-files", version: 1, platforms: ["files"], formats: ["markdown"], extensions: [".md"], autoDetect: false, unsupported: ["remote-fetch"] }] };
let root: Root, host: HTMLDivElement;
const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === `migration.setup.${key}`)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const render = async (client: "codex" | "claude-code" | "doubao-work" = "codex") => { await act(async () => root.render(<McpConnectionPanel purpose="migration" client={client} notebooks={[{ id: "authorized-book", name: "Authorized" }]}/>)); };
const change = async (element: HTMLInputElement | HTMLSelectElement, value: string) => { await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype, "value")!.set!;
  setter.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLInputElement ? "input" : "change", { bubbles: true }));
}); };

beforeEach(() => {
  vi.clearAllMocks(); mocks.scope = "server:user-1"; mocks.apiUrl = "https://nowen.test/prefix/api";
  mocks.capabilities.mockResolvedValue(caps); mocks.copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copy } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("migration connection setup", () => {
  it("generates client-specific configuration only after selecting a target and launcher", async () => {
    await render(); expect(button("copy").disabled).toBe(true); expect(mocks.capabilities).not.toHaveBeenCalled();
    await change(host.querySelector("input")!, "/Users/example/nowen-mcp/bin/nowen-mcp.mjs");
    await change(host.querySelectorAll("select")[1], "authorized-book");
    expect(button("copy").disabled).toBe(false); await click(button("copy"));
    expect(mocks.copy.mock.calls[0][0]).toContain("[mcp_servers.nowen-note]");
    expect(mocks.copy.mock.calls[0][0]).toContain("https://nowen.test/prefix");
    expect(mocks.copy.mock.calls[0][0]).toContain('MCP_INCLUDE_DESCENDANTS = "true"');
    await render("claude-code");
    expect(JSON.parse(host.querySelector("pre")!.textContent!).mcpServers["nowen-note"].env.ALLOWED_NOTEBOOK_IDS).toBe("authorized-book");
  });

  it("checks only the current Nowen service and never probes the entered gateway", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request"));
    try {
      await render("doubao-work"); await change(host.querySelector("select")!, "http");
      await change(host.querySelector("input")!, "https://remote.example/mcp");
      expect(host.textContent).toContain("migration.setup.issues.client-template");
      await click(button("diagnose"));
      expect(mocks.capabilities).toHaveBeenCalledTimes(1); expect(mocks.capabilities.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
      expect(host.textContent).toContain("migration.setup.status.ready"); expect(fetchSpy).not.toHaveBeenCalled();
      expect(host.textContent).toContain("migration.setup.diagnosticBoundary"); expect(host.textContent).toContain("remote-fetch");
    } finally { fetchSpy.mockRestore(); }
  });

  it.each([401, 403])("shows authorization failures without success or sensitive error text (%s)", async (status) => {
    mocks.capabilities.mockRejectedValue(Object.assign(new Error("credential-must-not-be-rendered"), { status }));
    await render(); await click(button("diagnose"));
    expect(host.textContent).toContain(status === 401 ? "migration.setup.status.unauthorized" : "migration.setup.status.forbidden");
    expect(host.textContent).not.toContain("credential-must-not-be-rendered"); expect(host.textContent).not.toContain("migration.setup.status.ready");
  });

  it("aborts an eight-second diagnostic without claiming a successful connection", async () => {
    mocks.capabilities.mockImplementation((signal: AbortSignal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))); }));
    await render(); vi.useFakeTimers(); await click(button("diagnose"));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(host.textContent).toContain("migration.setup.status.timeout"); expect(button("diagnose").disabled).toBe(false);
  });

  it("ignores a previous account's capability response and aborts on unmount (DCC-006)", async () => {
    let resolve!: (value: typeof caps) => void;
    mocks.capabilities.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render(); await click(button("diagnose")); mocks.scope = "server:user-2";
    await act(async () => resolve(caps)); expect(host.textContent).not.toContain("migration.setup.status.ready");
    await act(async () => root.render(<span/>));
    mocks.scope = "server:user-1"; await render(); await click(button("diagnose"));
    const signal = mocks.capabilities.mock.calls.at(-1)![0] as AbortSignal;
    await act(async () => root.render(<span/>)); expect(signal.aborted).toBe(true);
  });

  it("resolves a same-origin API base for copied stdio configuration", async () => {
    mocks.apiUrl = "/api"; await render();
    await change(host.querySelector("input")!, "/absolute/launcher.mjs");
    await change(host.querySelectorAll("select")[1], "authorized-book");
    expect(button("copy").disabled).toBe(false);
    expect(host.querySelector("pre")!.textContent).toContain(window.location.origin);
  });
});
