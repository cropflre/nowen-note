import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShareManagementPage from "@/components/ShareManagementPage";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getShareManagement: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getShareManagement: mocks.getShareManagement,
    updateShare: vi.fn(),
    deleteShare: vi.fn(),
    getNote: vi.fn(),
  },
}));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({ setActiveNote: vi.fn(), setViewMode: vi.fn(), setMobileView: vi.fn() }) }));
vi.mock("@/hooks/useSiteSettings", () => ({ useSiteSettings: () => ({ siteConfig: { publicWebOrigin: "https://note.example.com", publicWebOriginSource: "runtime" } }) }));
vi.mock("@/components/ShareModal", () => ({ default: () => null }));
vi.mock("@/components/ui/confirm", () => ({ confirm: vi.fn().mockResolvedValue(true) }));
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
    mocks.getShareManagement.mockReset();
    mocks.getShareManagement.mockResolvedValue(response);
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

    const statusSelect = host.querySelector('select[aria-label="按状态筛选"]') as HTMLSelectElement | null;
    expect(statusSelect).not.toBeNull();
    await act(async () => {
      statusSelect!.value = "disabled";
      statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await flushEffects();

    expect(mocks.getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ status: "disabled" }));
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
});
