import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShareManagementPage from "@/components/ShareManagementPage";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getShareManagement: vi.fn(),
  getMe: vi.fn(),
  updateShare: vi.fn(),
  deleteShare: vi.fn(),
  confirm: vi.fn(),
  updatePublicWebOrigin: vi.fn(),
  siteConfig: {
    publicWebOrigin: "https://note.example.com",
    publicWebOriginSource: "settings",
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    getShareManagement: mocks.getShareManagement,
    getMe: mocks.getMe,
    updateShare: mocks.updateShare,
    deleteShare: mocks.deleteShare,
    getNote: vi.fn(),
  },
}));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({ setActiveNote: vi.fn(), setViewMode: vi.fn(), setMobileView: vi.fn() }) }));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({
    siteConfig: mocks.siteConfig,
    updatePublicWebOrigin: mocks.updatePublicWebOrigin,
  }),
}));
vi.mock("@/components/ShareModal", () => ({ default: () => null }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const response = {
  items: [{
    id: "share-1", noteId: "note-1", ownerId: "me", shareToken: "abcdefghijklmnopqr",
    shareType: "link", permission: "view", hasPassword: true, expiresAt: null, maxViews: 10,
    viewCount: 2, isActive: 1, createdAt: "2026-07-20T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z",
    noteTitle: "我的公开笔记", notebookId: "nb-1", notebookName: "工作", workspaceId: null,
    workspaceName: null, noteIsTrashed: false, noteMissing: false, effectiveStatus: "active",
  }],
  total: 1, page: 1, pageSize: 20,
  stats: { total: 1, active: 1, disabled: 0, expired: 0, exhausted: 0 },
};

async function flushEffects(rounds = 4) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

describe("ShareManagementPage", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.updateShare.mockReset().mockResolvedValue({});
    mocks.deleteShare.mockReset().mockResolvedValue({});
    mocks.confirm.mockReset().mockResolvedValue(true);
    mocks.getShareManagement.mockReset();
    mocks.getShareManagement.mockResolvedValue(response);
    mocks.getMe.mockReset();
    mocks.getMe.mockResolvedValue({ role: "admin" });
    mocks.updatePublicWebOrigin.mockReset();
    mocks.updatePublicWebOrigin.mockResolvedValue(undefined);
    mocks.siteConfig.publicWebOrigin = "https://note.example.com";
    mocks.siteConfig.publicWebOriginSource = "settings";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  it("renders management details and uses server-side status filtering", async () => {
    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    expect(host.textContent).toContain("我的公开笔记");
    expect(host.textContent).toContain("正常");
    expect(host.textContent).toContain("已设密码");

    const disabledButton = host.querySelector<HTMLButtonElement>('button[aria-label="已停用"]');
    expect(disabledButton).not.toBeNull();
    await act(async () => disabledButton!.click());
    await flushEffects();

    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ status: "disabled" }));
  });

  it("reveals secondary filters and removes applied conditions without losing server filtering", async () => {
    await act(async () => root.render(<ShareManagementPage />));
    await flushEffects();
    expect(host.querySelector('select[aria-label="按权限筛选"]')).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="筛选分享"]')!;
    await act(async () => trigger.click());
    const permission = host.querySelector<HTMLSelectElement>('select[aria-label="按权限筛选"]')!;
    await act(async () => { permission.value = "edit_auth"; permission.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushEffects();
    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ permission: "edit_auth", page: 1 }));
    expect(host.querySelector('[aria-label="移除权限筛选"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除权限筛选"]')!.click());
    await flushEffects();
    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ permission: undefined }));
  });

  it("combines sorting direction and field in one control", async () => {
    await act(async () => root.render(<ShareManagementPage />));
    await flushEffects();
    const sort = host.querySelector<HTMLSelectElement>('select[aria-label="分享排序"]')!;
    expect(sort).not.toBeNull();
    await act(async () => { sort.value = "expiresAt:asc"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushEffects();
    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "expiresAt", order: "asc" }));
  });

  it("opens secondary actions by keyboard and restores focus on Escape", async () => {
    await act(async () => root.render(<ShareManagementPage />));
    await flushEffects();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="更多分享操作"]')!;
    expect(trigger).not.toBeNull();
    await act(async () => trigger.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    const first = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(first);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).not.toBe(first);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mocks.updateShare).not.toHaveBeenCalled();
    expect(mocks.deleteShare).not.toHaveBeenCalled();
  });

  it("preserves confirmation and the selected share ID for destructive menu actions", async () => {
    await act(async () => root.render(<ShareManagementPage />));
    await flushEffects();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="更多分享操作"]')!;
    expect(trigger).not.toBeNull();
    await act(async () => trigger.click());
    const menuButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes(text))!;
    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => menuButton("删除分享").click());
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(mocks.deleteShare).not.toHaveBeenCalled();
    await act(async () => trigger.click());
    await act(async () => menuButton("停用分享").click());
    await flushEffects();
    expect(mocks.updateShare).toHaveBeenCalledWith("share-1", { isActive: 0 });
    expect(mocks.getShareManagement).toHaveBeenCalledTimes(2);
  });

  it("keeps password filtering and clearing explicit after collapsing the panel", async () => {
    await act(async () => root.render(<ShareManagementPage />));
    await flushEffects();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="筛选分享"]')!;
    await act(async () => trigger.click());
    const password = host.querySelector<HTMLSelectElement>('[aria-label="按密码筛选"]')!;
    await act(async () => { password.value = "yes"; password.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushEffects();
    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ hasPassword: true }));
    await act(async () => password.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(host.querySelector('[aria-label="移除密码筛选"]')).not.toBeNull();
    const clear = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "清空筛选")!;
    await act(async () => clear.click());
    await flushEffects();
    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ hasPassword: undefined, status: undefined, page: 1 }));
  });

  it("keeps server pagination and resets to page one when changing status", async () => {
    mocks.getShareManagement.mockResolvedValue({ ...response, total: 21 });
    await act(async () => root.render(<ShareManagementPage />));
    await flushEffects();
    const next = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "下一页")!;
    await act(async () => next.click());
    await flushEffects();
    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="已过期"]')!.click());
    await flushEffects();
    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, status: "expired" }));
  });

  it("renders the empty state when the response omits items", async () => {
    mocks.getShareManagement.mockResolvedValue({
      total: 0,
      page: 1,
      pageSize: 20,
      stats: { total: 0, active: 0, disabled: 0, expired: 0, exhausted: 0 },
    });

    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    expect(host.textContent).toContain("还没有符合条件的分享链接");
  });

  it("uses a compact localhost banner and reveals details on demand", async () => {
    mocks.siteConfig.publicWebOrigin = "http://localhost:5173";

    await act(async () => { root.render(<ShareManagementPage />); });
    await flushEffects();

    expect(host.textContent).toContain("当前分享地址为 localhost，仅本机可访问。");
    expect(host.textContent).toContain("配置公开地址");
    expect(host.textContent).not.toContain("地址来源");

    const configureButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("配置公开地址"));
    expect(configureButton).toBeTruthy();
    await act(async () => {
      configureButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flushEffects();

    expect(host.textContent).toContain("地址来源");
    expect(host.textContent).toContain("管理员设置");
    expect(host.textContent).toContain("独立公开地址");
  });
});
