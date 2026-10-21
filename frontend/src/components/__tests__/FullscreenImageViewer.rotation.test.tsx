import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FullscreenImageViewer from "../FullscreenImageViewer";

vi.mock("@/hooks/useAttachmentImageRenderSource", () => ({
  useAttachmentImageRenderSource: (src: string) => ({ renderSrc: src, resolvedSrc: src, renderKey: src, onLoad() {}, onError() {} }),
}));
vi.mock("../MotionPhotoOverlay", () => ({ MotionPhotoOverlay: () => null }));

// DCC-002: editing a preview must emit a document mutation, not only a CSS transform.
describe("FullscreenImageViewer rotation", () => {
  let root: Root;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

  const click = (label: string) => act(() => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
  });
  const images = [{ src: "/same.png", rotation: 0 }, { src: "/same.png", rotation: 90 }];

  it("commits each turn for the exact gallery index, including repeated sources", () => {
    const onRotate = vi.fn();
    act(() => root.render(<FullscreenImageViewer open images={images} initialIndex={1} canEdit onRotate={onRotate} onClose={() => {}} />));
    click("顺时针旋转图片");
    click("顺时针旋转图片");
    expect(onRotate.mock.calls).toEqual([[images[1], 1, 180], [images[1], 1, 270]]);
  });

  it("keeps read-only rotation local even if an editing callback was supplied", () => {
    const onRotate = vi.fn();
    act(() => root.render(<FullscreenImageViewer open images={images} onRotate={onRotate} onClose={() => {}} />));
    click("顺时针旋转图片");
    expect(onRotate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-nowen-mobile-image-viewer] img')?.parentElement?.style.transform).toContain("rotate(90deg)");
  });

  it("retains the saved turn through preview reset and reopening", () => {
    const commit = vi.fn();
    function Harness() {
      const [gallery, setGallery] = useState(images);
      const [open, setOpen] = useState(true);
      return <>
        <button aria-label="Reopen" onClick={() => setOpen(true)} />
        <FullscreenImageViewer open={open} images={gallery} initialIndex={1} canEdit onClose={() => setOpen(false)}
          onRotate={(_, index, rotation) => {
            commit(index, rotation);
            setGallery((current) => current.map((item, i) => i === index ? { ...item, rotation } : item));
          }} />
      </>;
    }
    act(() => root.render(<Harness />));
    click("顺时针旋转图片");
    click("复原图片预览");
    click("关闭图片预览");
    click("Reopen");
    expect(commit.mock.calls).toEqual([[1, 180]]);
    expect(document.querySelector('[data-nowen-mobile-image-viewer] img')?.parentElement?.style.transform).toContain("rotate(180deg)");
  });

  it("does not show a successful turn when the document rejects a stale image target", () => {
    const onRotate = vi.fn(() => false);
    act(() => root.render(<FullscreenImageViewer open images={images} canEdit onRotate={onRotate} onClose={() => {}} />));
    click("顺时针旋转图片");
    expect(onRotate).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-nowen-mobile-image-viewer] img')?.parentElement?.style.transform).toContain("rotate(0deg)");
  });
});
