import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedMcpStatus } from "@/lib/api";
import { setAppTimeZone } from "@/lib/dateTime";
import i18n from "@/i18n";

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
const setExpiry = async (value: string) => { await act(async () => {
  const input = host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}); };
const toggleBook = async (name: string) => { await act(async () => {
  const label = [...host.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent?.trim() === name)!;
  expect(label).toBeDefined();
  label.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
}); };

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); mocks.scope = "user-a";
  mocks.current.mockReturnValue(true);
  mocks.notebooks.mockResolvedValue({ notebooks: [{ id: "book-a", name: "工作笔记", parentId: null, canWrite: true }] });
  mocks.list.mockResolvedValue([]);
  mocks.enable.mockResolvedValue(status);
  mocks.create.mockImplementation(async input => ({ id: "grant-a", token: "nkn_private-a", url: input.url, client: input.client, writable: input.writable, expiresAt: input.expiresInDays ? "2030-01-31T00:00:00Z" : null }));
  mocks.probe.mockResolvedValue(undefined); mocks.revoke.mockResolvedValue({ success: true }); mocks.copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copy } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setAppTimeZone("auto"); });

describe("simple AI connection flow", () => {
  it("activates the expiry input only from its label or the input, not surrounding whitespace or help text", async () => {
    await render();
    const input = host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    const activated = vi.fn();
    input.addEventListener("click", activated);
    await act(async () => {
      input.parentElement!.click();
      host.querySelector<HTMLElement>("#mcp-expiry-help")!.click();
      host.querySelector("section")!.click();
    });
    expect(activated).not.toHaveBeenCalled();
    const label = input.labels![0];
    expect(label.textContent).toBe("有效期（天）");
    await act(async () => label.click());
    expect(activated).toHaveBeenCalledTimes(1);
    await act(async () => input.click());
    expect(activated).toHaveBeenCalledTimes(2);
  });
  it("defaults to permanent access without requiring an expiry choice", async () => {
    await render();
    expect(host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!.value).toBe("");
    expect(host.textContent).toContain("留空为永久");
    await click("连接");
    expect(mocks.create.mock.calls[0][0].expiresInDays).toBeUndefined();
    expect(host.textContent).toContain("永久有效");
  });
  it("accepts custom days and displays the expiry returned by the server", async () => {
    setAppTimeZone("Asia/Shanghai");
    await render(); await setExpiry("30"); await click("连接");
    expect(mocks.create.mock.calls[0][0].expiresInDays).toBe(30);
    expect(host.textContent).toContain("有效期至 2030/1/31");
    expect(host.textContent).not.toContain("永久有效");
  });
  it("blocks invalid days and permits clearing them back to permanent", async () => {
    await render({ ...status, enabled: false });
    for (const value of ["0", "-1", "1.5", "abc", "1e3"]) {
      await setExpiry(value);
      expect(button("连接").disabled).toBe(true);
      await click("连接");
    }
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    await setExpiry(""); await click("连接");
    expect(mocks.create.mock.calls[0][0].expiresInDays).toBeUndefined();
  });
  it("starts with all personal notebooks selected and keeps the primary flow free of credential fields", async () => {
    await render();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(button("连接").disabled).toBe(false);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(boxes.every(node => node.checked)).toBe(true);
    expect(host.querySelectorAll("select")).toHaveLength(1);
    expect([...host.querySelectorAll("optgroup")].map(group => group.label)).toEqual(["国内助手", "其他助手"]);
    expect(host.textContent).not.toMatch(/高级设置|访问令牌|完整配置|MCP|JSON/);
    await toggleBook("个人空间");
    expect(button("连接").disabled).toBe(true);
    expect(boxes.every(node => !node.checked)).toBe(true);
    await toggleBook("个人空间");
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
  it("falls back to execCommand copy on HTTP Edge/Safari when navigator.clipboard is unavailable or rejects", async () => {
    const { toast } = await import("@/lib/toast");
    const originalExecCommand = document.execCommand;
    let copiedText = "";
    document.execCommand = vi.fn((cmd: string) => {
      if (cmd !== "copy") return false;
      copiedText = (document.activeElement as HTMLTextAreaElement | null)?.value || "";
      return true;
    });
    try {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      await render(); await selectClient("Codex"); await click("连接");
      await click("复制给 Codex");
      expect(copiedText).toContain("nkn_private-a");
      expect(toast.success).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      document.execCommand = originalExecCommand;
    }
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
  describe("team spaces", () => {
    const teamBooks = [
      { id: "mine", name: "我的笔记", parentId: null, canWrite: true, workspaceId: null, workspaceName: null, shared: false },
      { id: "shared", name: "他人共享", parentId: null, canWrite: false, workspaceId: null, workspaceName: null, shared: true },
      { id: "docs", name: "项目文档", parentId: null, canWrite: true, workspaceId: "ws-prod", workspaceName: "产品研发团队" },
      { id: "spec", name: "技术方案", parentId: "docs", canWrite: true, workspaceId: "ws-prod", workspaceName: "产品研发团队" },
      { id: "ops", name: "运营资料", parentId: null, canWrite: false, workspaceId: "ws-ops", workspaceName: "运营团队" },
    ];
    const group = (name: string) => host.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`)!;
    const expand = async (name: string) => { await act(async () => {
      group(name).querySelector<HTMLButtonElement>("button[aria-expanded]")!.click();
    }); };
    const checked = () => [...host.querySelectorAll<HTMLInputElement>('label input[type="checkbox"]')]
      .filter(input => input.checked && !input.getAttribute("aria-label")).map(input => input.closest("label")!.querySelector("span")!.textContent);

    it("groups notebooks by space and only preselects the user's personal notebooks", async () => {
      mocks.notebooks.mockResolvedValue({ notebooks: teamBooks });
      await render();
      expect([...host.querySelectorAll('[role="group"]')].map(node => node.getAttribute("aria-label")))
        .toEqual(["个人空间", "与我共享", "产品研发团队", "运营团队"]);
      expect(host.textContent).toContain("团队空间");
      expect(group("产品研发团队").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
      expect(group("产品研发团队").textContent).not.toContain("项目文档");
      expect(group("运营团队").textContent).toContain("只读");
      expect(checked()).toEqual(["我的笔记"]);
      expect(host.textContent).not.toContain("AI 助手将可以访问你选中的团队笔记");
      await expand("产品研发团队");
      expect(group("产品研发团队").textContent).toContain("项目文档");
      expect(group("产品研发团队").textContent).toContain("可编辑");
      await click("连接");
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ notebooks: [{ id: "mine", canWrite: true }], writable: true }), expect.any(AbortSignal));
    });

    it("selects one team notebook, warns once and passes exactly that grant", async () => {
      mocks.notebooks.mockResolvedValue({ notebooks: teamBooks });
      await render();
      await expand("产品研发团队");
      await toggleBook("项目文档");
      expect(host.querySelector('[role="note"]')!.textContent).toBe("AI 助手将可以访问你选中的团队笔记。请确认团队内容允许接入该助手。");
      const all = group("产品研发团队").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(all.indeterminate).toBe(true);
      await click("连接");
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
        writable: true, notebooks: [{ id: "mine", canWrite: true }, { id: "docs", canWrite: true }],
      }), expect.any(AbortSignal));
    });

    it("selects or clears a whole team without touching other spaces", async () => {
      mocks.notebooks.mockResolvedValue({ notebooks: teamBooks });
      await render();
      await toggleBook("产品研发团队");
      await expand("产品研发团队");
      expect(checked()).toEqual(["我的笔记", "项目文档", "技术方案"]);
      expect(group("产品研发团队").textContent).toContain("已选 2/2");
      await toggleBook("产品研发团队");
      expect(checked()).toEqual(["我的笔记"]);
    });

    it("labels an all read-only selection as a read-only connection and does not request write access", async () => {
      mocks.notebooks.mockResolvedValue({ notebooks: teamBooks });
      await render({ ...status, allowWrite: false, canManage: false });
      expect(button("连接").disabled).toBe(true);
      await toggleBook("个人空间");
      await toggleBook("运营团队");
      expect(host.textContent).toContain("只读连接：你对所选笔记本只有查看权限");
      expect(host.textContent).not.toContain("请联系管理员");
      expect(button("连接").disabled).toBe(false);
      await click("连接");
      expect(mocks.enable).not.toHaveBeenCalled();
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ writable: false, notebooks: [{ id: "ops", canWrite: false }] }), expect.any(AbortSignal));
      expect(host.textContent).toContain("只读连接");
      expect(host.textContent).toContain("准备好了");
    });

    it("shows the server error and no success state when creating the team grant fails", async () => {
      mocks.notebooks.mockResolvedValue({ notebooks: teamBooks });
      const { McpConnectionError } = await import("@/lib/mcpConnections");
      mocks.create.mockRejectedValueOnce(new McpConnectionError("forbidden", "当前账号没有连接权限，请联系管理员"));
      await render();
      await toggleBook("产品研发团队");
      await click("连接");
      expect(host.querySelector('[role="alert"]')!.textContent).toBe("当前账号没有连接权限，请联系管理员");
      expect(mocks.probe).not.toHaveBeenCalled();
      expect(host.textContent).not.toContain("准备好了");
      expect(button("复制给 Claude Code")).toBeUndefined();
      expect(button("连接").disabled).toBe(false);
    });

    it("renders the grouped picker and warnings in English", async () => {
      await i18n.changeLanguage("en");
      mocks.notebooks.mockResolvedValue({ notebooks: teamBooks });
      await render();
      await toggleBook("产品研发团队");
      expect(host.textContent).toContain("Choose the notes the AI assistant can access");
      expect(host.textContent).toContain("Personal space");
      expect(host.textContent).toContain("Team spaces");
      expect(host.textContent).toContain("The AI assistant will be able to access the team notes you selected.");
      expect(button("Connect")).toBeDefined();
      expect(host.textContent).not.toMatch(/个人空间|团队空间|连接 AI 助手|只读/);
    });
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
