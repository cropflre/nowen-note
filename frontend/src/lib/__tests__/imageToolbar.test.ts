import { describe, expect, it, vi } from "vitest";
import {
  buildReplacedImageAttrs,
  getImageCopySource,
  getImageDownloadFilename,
  isImageReplaceTargetNode,
} from "@/lib/imageToolbar";

describe("imageToolbar", () => {
  it("replaces src while preserving persisted image attributes", () => {
    expect(
      buildReplacedImageAttrs(
        {
          src: "/api/attachments/old",
          alt: "示例图",
          title: "图片标题",
          width: 420,
          height: null,
        },
        "/api/attachments/new",
      ),
    ).toEqual({
      src: "/api/attachments/new",
      alt: "示例图",
      title: "图片标题",
      width: 420,
      height: null,
    });
  });

  it("copies the persisted image src instead of a resolved absolute url", () => {
    expect(getImageCopySource({ src: "/api/attachments/image-id" })).toBe("/api/attachments/image-id");
  });

  it("guards replacement against stale non-image targets", () => {
    expect(isImageReplaceTargetNode({ type: { name: "image" } })).toBe(true);
    expect(isImageReplaceTargetNode({ type: { name: "paragraph" } })).toBe(false);
    expect(isImageReplaceTargetNode(null)).toBe(false);
  });

  it("uses title or alt as download filename before falling back to timestamp", () => {
    expect(getImageDownloadFilename({ title: "  标题.png  ", alt: "替代文本" })).toBe("标题.png");
    expect(getImageDownloadFilename({ alt: "  替代文本  " })).toBe("替代文本");

    vi.setSystemTime(new Date("2026-07-08T00:00:00Z"));
    expect(getImageDownloadFilename({})).toBe("nowen-image-1783468800000");
    vi.useRealTimers();
  });
});
