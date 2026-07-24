import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ShareManagementPage from "@/components/ShareManagementPage";

const getShareManagement = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    getShareManagement,
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

describe("ShareManagementPage", () => {
  beforeEach(() => {
    getShareManagement.mockReset();
    getShareManagement.mockResolvedValue(response);
  });

  it("renders management details and uses server-side status filtering", async () => {
    render(<ShareManagementPage />);
    expect(await screen.findAllByText("我的公开笔记")).not.toHaveLength(0);
    expect(screen.getAllByText("正常").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已设密码").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("按状态筛选"), { target: { value: "disabled" } });
    await waitFor(() => expect(getShareManagement).toHaveBeenLastCalledWith(expect.objectContaining({ status: "disabled" })));
  });
});
