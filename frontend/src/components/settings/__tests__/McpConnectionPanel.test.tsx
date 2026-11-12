import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn(), configure: vi.fn(), fetch: vi.fn(), copy: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { mcp: { status: mocks.status, configure: mocks.configure } }, getBaseUrl: () => "/api" }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => "server:user" }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: mocks.error } }));
vi.mock("../MigrationConnectionSetup", () => ({ default: () => null }));
import McpConnectionPanel from "../McpConnectionPanel";

let host: HTMLDivElement, root: Root;
const state = { available: true, canManage: true, enabled: false, allowWrite: false, publicUrl: "https://note.example.com/mcp" };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label)!;
const render = async () => { await act(async () => root.render(<McpConnectionPanel />)); };
const click = async (label: string) => { await act(async () => button(label).click()); };
const typeToken = async (value: string) => {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>("#mcp-test-token")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  mocks.status.mockResolvedValue(state);
  mocks.configure.mockImplementation(async input => ({ ...state, ...input }));
  mocks.copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copy } });
  vi.stubGlobal("fetch", mocks.fetch);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("embedded MCP settings", () => {
  it("enables and disables the persisted service with read-only defaults", async () => {
    await render();
    expect(host.textContent).toContain("MCP 服务已关闭");
    await click("开启 MCP 服务");
    expect(mocks.configure).toHaveBeenCalledWith({ enabled: true, allowWrite: false, publicUrl: state.publicUrl });
    expect(host.textContent).toContain("MCP 服务已开启");
    await click("关闭 MCP 服务");
    expect(mocks.configure).toHaveBeenLastCalledWith({ enabled: false, allowWrite: false, publicUrl: state.publicUrl });
  });
  it("keeps the disabled state when saving fails", async () => {
    mocks.configure.mockRejectedValue(new Error("Save failed"));
    await render(); await click("开启 MCP 服务");
    expect(host.textContent).toContain("MCP 服务已关闭");
    expect(mocks.error).toHaveBeenCalledWith("Save failed");
  });
  it("shows status without administrator controls for ordinary users", async () => {
    mocks.status.mockResolvedValue({ ...state, canManage: false });
    await render();
    expect(button("开启 MCP 服务")).toBeUndefined();
    expect(host.querySelector<HTMLInputElement>("#embedded-mcp-url")!.disabled).toBe(true);
  });
  it("keeps standalone and stdio instructions available when the image lacks MCP", async () => {
    mocks.status.mockResolvedValue({ ...state, available: false });
    await render();
    expect(host.textContent).toContain("当前安装未包含内置 MCP");
    await click("本机 stdio");
    expect(host.querySelector("pre")!.textContent).toContain("nowen-mcp.mjs");
    await click("独立 HTTP 网关");
    expect(host.querySelector("pre")!.textContent).toContain("your-separate-http-gateway-token");
  });
  it("copies a fixed URL with a placeholder rather than the entered test credential", async () => {
    await render(); await typeToken("nkn_private-test-credential"); await click("复制");
    const config = JSON.parse(mocks.copy.mock.calls[0][0]);
    expect(config.mcpServers["nowen-note"].url).toBe(state.publicUrl);
    expect(config.mcpServers["nowen-note"].headers.Authorization).toBe("Bearer <your-personal-api-token>");
    expect(mocks.copy.mock.calls[0][0]).not.toContain("private-test-credential");
  });
  it("copies the saved MCP address independently of unsaved configuration changes", async () => {
    await render(); await click("复制地址");
    expect(mocks.copy).toHaveBeenCalledWith(state.publicUrl);
  });
  it("checks MCP initialization and tools/list and clears the temporary token", async () => {
    mocks.status.mockResolvedValue({ ...state, enabled: true });
    mocks.fetch.mockResolvedValueOnce(Response.json({ result: { serverInfo: { name: "nowen-note" } } }))
      .mockResolvedValueOnce(Response.json({ result: { tools: [] } }));
    await render(); await typeToken("nkn_test"); await click("测试 MCP 连接");
    expect(mocks.fetch.mock.calls.map(call => JSON.parse(call[1].body).method)).toEqual(["initialize", "tools/list"]);
    expect(mocks.fetch.mock.calls.every(call => call[0] === state.publicUrl)).toBe(true);
    expect(host.textContent).toContain("MCP 握手与工具列表检测通过");
    expect(host.querySelector<HTMLInputElement>("#mcp-test-token")!.value).toBe("");
  });
  it("does not claim success for a healthy HTTP response containing an MCP error", async () => {
    mocks.status.mockResolvedValue({ ...state, enabled: true });
    mocks.fetch.mockResolvedValue(Response.json({ error: { code: -32603 } }));
    await render(); await typeToken("nkn_test"); await click("测试 MCP 连接");
    expect(host.textContent).toContain("MCP 检测失败");
    expect(host.querySelector<HTMLInputElement>("#mcp-test-token")!.value).toBe("");
  });
  it("aborts the old diagnostic and does not send a second request after changing connection mode", async () => {
    mocks.status.mockResolvedValue({ ...state, enabled: true });
    let finish!: (value: Response) => void;
    mocks.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    await render(); await typeToken("nkn_test"); await click("测试 MCP 连接");
    const signal = mocks.fetch.mock.calls[0][1].signal as AbortSignal;
    await click("独立 HTTP 网关");
    expect(signal.aborted).toBe(true);
    await act(async () => finish(Response.json({ result: { serverInfo: { name: "nowen-note" } } })));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("MCP 握手与工具列表检测通过");
  });
});
