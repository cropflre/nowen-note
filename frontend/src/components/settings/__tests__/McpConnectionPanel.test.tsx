import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn(), scope: "user-a" }));
vi.mock("@/lib/api", () => ({ api: { mcp: { status: mocks.status } }, getBaseUrl: () => "/api" }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("../MigrationConnectionSetup", () => ({ default: () => null }));
vi.mock("../McpQuickConnect", () => ({ default: ({ service, loadError, onRetry }: { service: { enabled: boolean } | null; loadError: boolean; onRetry: () => void }) =>
  <div>{service ? "简易连接" : loadError ? <button onClick={onRetry}>重新检查</button> : "检查中"}</div> }));
import McpConnectionPanel from "../McpConnectionPanel";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); mocks.scope = "user-a"; mocks.status.mockResolvedValue({ enabled: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("connection panel simplicity", () => {
  it("renders only the connection flow without extra sections or configuration choices", async () => {
    await act(async () => root.render(<McpConnectionPanel />));
    expect(host.textContent).toBe("简易连接");
    expect(host.querySelectorAll("details, pre, input")).toHaveLength(0);
    expect(host.textContent).not.toMatch(/高级设置|访问令牌|stdio|HTTP|MCP/);
  });
  it("lets the user retry a failed service check in place", async () => {
    mocks.status.mockRejectedValueOnce(new Error("Network unavailable"));
    await act(async () => root.render(<McpConnectionPanel />));
    expect(host.textContent).toBe("重新检查");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.textContent).toBe("简易连接");
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });
  it("discards the previous account's late service response", async () => {
    let finish!: (value: unknown) => void;
    mocks.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<McpConnectionPanel />));
    mocks.scope = "user-b";
    await act(async () => finish({ enabled: true }));
    expect(host.textContent).toBe("检查中");
  });
});
