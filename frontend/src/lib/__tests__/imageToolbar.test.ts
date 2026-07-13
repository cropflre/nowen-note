import { describe, expect, it, vi } from "vitest";
import {
  buildReplacedImageAttrs,
  getImageCopySource,
  getImageDownloadFilename,
  getImageToolbarPosition,
  isImageReplaceTargetNode,
  shouldKeepImageActionsOpenOnBlur,
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

  it("keeps rotation and horizontal flip when replacing a transformed image", () => {
    expect(
      buildReplacedImageAttrs(
        {
          src: "/api/attachments/old",
          alt: null,
          title: null,
          width: 320,
          height: null,
          rotation: 270,
          flipX: true,
        },
        "/api/attachments/new",
      ),
    ).toMatchObject({
      src: "/api/attachments/new",
      width: 320,
      rotation: 270,
      flipX: true,
    });
  });

  it("copies image src with the current origin for relative attachment paths", () => {
    expect(getImageCopySource({ src: "/api/attachments/image-id" }, "https://note.example.com")).toBe(
      "https://note.example.com/api/attachments/image-id",
    );
    expect(getImageCopySource({ src: "api/attachments/image-id" }, "https://note.example.com/")).toBe(
      "https://note.example.com/api/attachments/image-id",
    );
  });

  it("keeps already absolute image src unchanged when copying", () => {
    expect(getImageCopySource({ src: "https://cdn.example.com/a.png" }, "https://note.example.com")).toBe(
      "https://cdn.example.com/a.png",
    );
    expect(getImageCopySource({ src: "data:image/png;base64,abc" }, "https://note.example.com")).toBe(
      "data:image/png;base64,abc",
    );
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

  it("places the image toolbar above the image when there is enough room", () => {
    expect(
      getImageToolbarPosition(
        { top: 240, bottom: 640, left: 100, right: 900, width: 800 },
        { width: 1200, height: 800 },
      ),
    ).toEqual({ top: 192, left: 360 });
  });

  it("places the image toolbar below the image when the image is near the top", () => {
    expect(
      getImageToolbarPosition(
        { top: 24, bottom: 424, left: 100, right: 900, width: 800 },
        { width: 1200, height: 800 },
      ),
    ).toEqual({ top: 432, left: 360 });
  });

  it("keeps mobile image actions open when blur only dismisses the keyboard", () => {
    expect(shouldKeepImageActionsOpenOnBlur({ node: { type: { name: "image" } } })).toBe(true);
    expect(shouldKeepImageActionsOpenOnBlur({ node: { type: { name: "paragraph" } } })).toBe(false);
    expect(shouldKeepImageActionsOpenOnBlur(null)).toBe(false);
  });
});
