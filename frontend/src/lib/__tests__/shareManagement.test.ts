import { describe, expect, it } from "vitest";
import {
  compactShareToken,
  formatShareDate,
  normalizeShareManagementResponse,
  sharePermissionLabel,
  shareStatusMeta,
} from "@/lib/shareManagement";
import {
  buildTextCommentAnchor,
  resolveTextCommentAnchor,
} from "@/lib/inlineCommentAnchor";

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

  it("recovers an inline comment anchor after text is inserted before it", () => {
    const original = "前文。需要批注。后文。";
    const start = original.indexOf("需要批注");
    const anchor = buildTextCommentAnchor({
      editor: "tiptap",
      documentText: original,
      start,
      end: start + "需要批注".length,
    });
    expect(anchor).not.toBeNull();

    const updated = `新增内容。${original}`;
    expect(resolveTextCommentAnchor(updated, anchor!)).toMatchObject({
      start: updated.indexOf("需要批注"),
      end: updated.indexOf("需要批注") + "需要批注".length,
      exact: false,
    });
  });
});
