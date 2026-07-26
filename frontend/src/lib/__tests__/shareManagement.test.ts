import { describe, expect, it } from "vitest";
import {
  compactShareToken,
  formatShareDate,
  normalizeShareManagementResponse,
  sharePermissionLabel,
  shareStatusMeta,
} from "@/lib/shareManagement";

describe("share management presentation", () => {
  it("maps permissions and lifecycle states to explicit labels", () => {
    expect(sharePermissionLabel("view")).toBe("仅查看");
    expect(sharePermissionLabel("edit_auth")).toBe("登录后可编辑");
    expect(shareStatusMeta("disabled").label).toBe("已停用");
    expect(shareStatusMeta("exhausted").label).toBe("次数耗尽");
  });

  it("formats optional dates and compact tokens", () => {
    expect(formatShareDate(null)).toBe("无限制");
    expect(compactShareToken("abcdefghijklmnopqr")).toBe("abcdefg…nopqr");
  });

  it("normalizes legacy array and missing-items responses", () => {
    const legacyItem = {
      id: "share-1",
      isActive: 1,
      effectiveStatus: "active",
    };
    expect(normalizeShareManagementResponse([legacyItem])).toMatchObject({
      items: [legacyItem],
      total: 1,
      stats: { total: 1, active: 1 },
    });
    expect(normalizeShareManagementResponse({ total: 0, page: 1, pageSize: 20 })).toMatchObject({
      items: [],
      total: 0,
    });
  });
});
