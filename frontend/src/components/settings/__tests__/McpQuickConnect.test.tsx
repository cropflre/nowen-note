import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedMcpStatus } from "@/lib/api";

const mocks = vi.hoisted(() => ({ scope: "user-a", current: vi.fn(), notebooks: vi.fn(), list: vi.fn(), enable: vi.fn(), create: vi.fn(), revoke: vi.fn(), probe: vi.fn(), copy: vi.fn(), changed: vi.fn() }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/mcpConnections", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/mcpConnections")>(),
  createMcpConnectionSession: () => ({ current: mocks.current, notebooks: mocks.notebooks, list: mocks.list, enable: mocks.enable, create: mocks.create, revoke: mocks.revoke, probe: mocks.probe }),
}));
import McpQuickConnect from "../McpQuickConnect";

let host: HTMLDivElement, root: Root;
const status: EmbeddedMcpStatus = { available: true, enabled: true, canManage: true, allowWrite: true, publicUrl: "https://note.test/mcp" };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label)!;
const click = async (label: string) => { await act(async () => button(label).click()); };
const selectClient = async (name: string) => { await act(async () => {
  const element = host.querySelector<HTMLSelectElement>("select")!;
  const option = [...element.options].find(value => value.textContent === name)!;
  expect(option).toBeDefined();
  element.value = option.value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}); };
const render = async (service = status) => { await act(async () => root.render(<McpQuickConnect service={service} defaultUrl="https://note.test/mcp" onServiceChange={mocks.changed}/>)); };
const toggleBook = async (name: string) => { await act(async () => {
  const label = [...host.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent?.trim() === name)!;
  expect(label).toBeDefined();
  label.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
}); };

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); mocks.scope = "user-a";
  mocks.current.mockReturnValue(true);
  mocks.notebooks.mockResolvedValue({ notebooks: [{ id: "book-a", name: "工作笔记", parentId: null, canWrite: true }] });
  mocks.list.mockResolvedValue([]);
  mocks.enable.mockResolvedValue(status);
  mocks.create.mockImplementation(async input => ({ id: "grant-a", token: "nkn_private-a", url: input.url, client: input.client, writable: input.writable, expiresAt: "2027-02-01" }));
  mocks.probe.mockResolvedValue(undefined); mocks.revoke.mockResolvedValue({ success: true }); mocks.copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copy } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("simple AI connection flow", () => {
  it("starts with all notebooks selected and keeps the primary flow free of credential fields", async () => {
    await render();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(button("连接").disabled).toBe(false);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(boxes.every(node => node.checked)).toBe(true);
    expect(host.querySelectorAll("select")).toHaveLength(1);
    expect([...host.querySelectorAll("optgroup")].map(group => group.label)).toEqual(["国内助手", "其他助手"]);
    expect(host.textContent).not.toMatch(/高级设置|访问令牌|完整配置|MCP|JSON/);
    await toggleBook("全部笔记");
    expect(button("连接").disabled).toBe(true);
    expect(boxes.every(node => !node.checked)).toBe(true);
    await toggleBook("全部笔记");
    expect(button("连接").disabled).toBe(false);
    expect(boxes.every(node => node.checked)).toBe(true);
  });
  it("allows a subset while passing each selected notebook's actual write permission", async () => {
    mocks.notebooks.mockResolvedValue({ notebooks: [
      { id: "book-a", name: "工作笔记", parentId: null, canWrite: true },
      { id: "shared-read", name: "只读共享笔记", parentId: null, canWrite: false },
      { id: "unselected", name: "私人日记", parentId: null, canWrite: true },
    ] });
    await render();
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(node => node.checked)).toBe(true);
    await toggleBook("私人日记");
    const all = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
    await click("连接");
    expect(mocks.create).toHaveBeenCalledWith({
      client: "claude-code", url: status.publicUrl, writable: true,
      notebooks: [{ id: "book-a", canWrite: true }, { id: "shared-read", canWrite: false }],
    }, expect.any(AbortSignal));
  });
  it("excludes an unchecked child notebook even when its parent remains selected", async () => {
    mocks.notebooks.mockResolvedValue({ notebooks: [
      { id: "parent", name: "工作笔记", parentId: null, canWrite: true },
      { id: "child", name: "私人日记", parentId: "parent", canWrite: true },
    ] });
    await render();
    await toggleBook("私人日记");
    await click("连接");
    expect(mocks.create).toHaveBeenCalledWith({
      client: "claude-code", url: status.publicUrl, writable: true,
      notebooks: [{ id: "parent", canWrite: true }],
    }, expect.any(AbortSignal));
  });
  it("does not create an empty authorization when there are no notebooks", async () => {
    mocks.notebooks.mockResolvedValue({ notebooks: [] });
    await render();
    expect(button("连接").disabled).toBe(true);
    await click("连接");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("automatically creates, checks and hands a complete connection to the selected AI", async () => {
    await render(); await selectClient("Cursor"); await click("连接");
    expect(mocks.create).toHaveBeenCalledWith({ client: "cursor", notebooks: [{ id: "book-a", canWrite: true }], writable: true, url: status.publicUrl }, expect.any(AbortSignal));
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("准备好了");
    expect(host.querySelector<HTMLAnchorElement>('a[href^="cursor:"]')).not.toBeNull();
    expect(button("复制给 Cursor")).toBeUndefined();
    expect(button("复制完整配置")).toBeUndefined();
    expect(host.textContent).not.toContain("nkn_private-a");
  });
  it("explicitly enables the service with the detected address when an administrator generates the first connection", async () => {
    await render({ ...status, enabled: false, publicUrl: "" }); await click("连接");
    expect(mocks.enable).toHaveBeenCalledWith({ enabled: true, allowWrite: true, publicUrl: status.publicUrl }, expect.any(AbortSignal));
    expect(mocks.changed).toHaveBeenCalledWith(status);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("enables editing when an administrator connects to a read-only service", async () => {
    await render({ ...status, allowWrite: false }); await click("连接");
    expect(mocks.enable).toHaveBeenCalledWith({ enabled: true, allowWrite: true, publicUrl: status.publicUrl }, expect.any(AbortSignal));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ writable: true }), expect.any(AbortSignal));
  });
  it("does not issue a writable authorization if editing was not successfully enabled", async () => {
    mocks.enable.mockResolvedValue({ ...status, allowWrite: false });
    await render({ ...status, enabled: false, allowWrite: false }); await click("连接");
    expect(mocks.enable).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("does not let a regular user enable editing on a read-only service", async () => {
    await render({ ...status, allowWrite: false, canManage: false });
    expect(host.textContent).toContain("请联系管理员");
    expect(button("连接").disabled).toBe(true);
    await click("连接");
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["Claude Code", "Codex"])("provides one ready-to-paste handoff for %s", async name => {
    await render(); await selectClient(name); await click("连接");
    await click(`复制给 ${name}`);
    expect(mocks.copy.mock.calls[0][0]).toContain("nkn_private-a");
    expect(mocks.copy.mock.calls[0][0]).not.toMatch(/<your|<replace/);
    expect(host.querySelectorAll("details, pre")).toHaveLength(0);
    expect(button("复制完整配置")).toBeUndefined();
  });
  it.each([
    ["workbuddy", "WorkBuddy"],
    ["codebuddy", "CodeBuddy Code"],
    ["trae-cn", "TRAE 国内版"],
    ["qoder", "Qoder"],
    ["kimi-code", "Kimi Code"],
    ["qwen-code", "Qwen Code（千问）"],
  ] as const)("connects %s through the same simple selection and CRUD authorization flow", async (client, name) => {
    await render(); await selectClient(name); await click("连接");
    expect(mocks.create).toHaveBeenCalledWith({ client, notebooks: [{ id: "book-a", canWrite: true }], writable: true, url: status.publicUrl }, expect.any(AbortSignal));
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("准备好了");
    if (client === "trae-cn") {
      const link = host.querySelector<HTMLAnchorElement>('a[href^="trae-cn:"]')!;
      expect(link.textContent).toBe(`一键添加到 ${name}`);
      expect(button(`复制给 ${name}`)).toBeUndefined();
    } else {
      await click(`复制给 ${name}`);
      const prompt = mocks.copy.mock.calls[0][0] as string;
      expect(prompt).toContain(name);
      expect(prompt).toContain("nkn_private-a");
      expect(prompt).toContain("nowen_list_notebooks");
      expect(prompt).not.toMatch(/<replace|<your|\$\{/);
    }
    expect(host.textContent).not.toContain("nkn_private-a");
    expect(host.querySelectorAll('details, pre, input[type="password"]')).toHaveLength(0);
    expect(button("复制完整配置")).toBeUndefined();
  });
  it("shows existing assistants directly and disconnects them without an advanced management panel", async () => {
    mocks.list.mockResolvedValue([{ id: "existing", name: "MCP · Codex", expiresAt: null, revokedAt: null }]);
    await render();
    expect(host.textContent).toContain("你的助手");
    expect(host.textContent).not.toMatch(/高级|令牌管理/);
    await click("断开");
    expect(mocks.revoke).toHaveBeenCalledWith("existing", expect.any(AbortSignal));
    expect(host.textContent).not.toContain("你的助手");
  });
  it("does not offer service activation to a regular user", async () => {
    await render({ ...status, enabled: false, canManage: false });
    expect(host.textContent).toContain("请联系管理员");
    expect(button("连接").disabled).toBe(true);
    expect(mocks.enable).not.toHaveBeenCalled();
  });
  it("keeps a failed probe retryable without creating another credential or exposing copy actions", async () => {
    mocks.probe.mockRejectedValueOnce(new Error("Unable to connect"));
    await render(); await click("连接");
    expect(button("复制给 Claude Code").disabled).toBe(true);
    await click("重试");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(button("复制给 Claude Code").disabled).toBe(false);
  });
  it("retains a connection on revocation failure and removes its handoff only after revocation succeeds", async () => {
    await render(); await click("连接");
    mocks.revoke.mockRejectedValueOnce(new Error("Revoke failed"));
    await click("断开");
    expect(button("复制给 Claude Code")).toBeDefined();
    expect(host.textContent).toContain("连接失败，请重试");
    await click("断开");
    expect(button("复制给 Claude Code")).toBeUndefined();
    expect(button("连接")).toBeDefined();
  });
  it("does not continue a late setup after its account panel is unmounted", async () => {
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await click("连接");
    await act(async () => root.render(<div>Another account</div>));
    await act(async () => finish({ id: "grant-a", token: "nkn_private-a", url: status.publicUrl, client: "codex", writable: true, expiresAt: null }));
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(host.textContent).toBe("Another account");
  });
});
