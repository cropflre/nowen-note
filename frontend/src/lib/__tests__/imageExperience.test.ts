// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  findMobileImageSheet,
  findSharedLightbox,
  getHorizontalSwipeDirection,
  getRotatedContainLimits,
  normalizeQuarterTurn,
  stepGalleryIndex,
} from "@/lib/imageExperience";

describe("image experience helpers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("recognizes the existing mobile image sheet by structure rather than locale", () => {
    document.body.innerHTML = `
      <div class="fixed bottom-0 left-0 right-0 z-50">
        <div><button aria-label="关闭">x</button></div>
        <div class="grid grid-cols-4">
          <button>查看</button><button>下载</button><button>替换</button>
          <button>复制</button><button>删除</button><button>编辑</button>
        </div>
        <div class="grid grid-cols-5">
          <button>25%</button><button>50%</button><button>75%</button>
          <button>100%</button><button>原始</button>
        </div>
      </div>
    `;

    const result = findMobileImageSheet(document);
    expect(result?.actionButtons).toHaveLength(6);
    expect(result?.sizeButtons).toHaveLength(5);
    expect(result?.actionButtons[2].textContent).toBe("替换");
  });

  it("does not confuse a table bottom sheet with the image sheet", () => {
    document.body.innerHTML = `
      <div class="fixed bottom-0 left-0 right-0 z-50">
        <button>行</button><button>列</button><button>更多</button>
      </div>
    `;
    expect(findMobileImageSheet(document)).toBeNull();
  });

  it("collects share images in DOM order and resolves the current lightbox index", () => {
    document.body.innerHTML = `
      <div class="shared-note-content">
        <img src="https://example.test/a.png" />
        <img src="https://example.test/b.png" />
      </div>
      <div class="fixed inset-0">
        <img src="https://example.test/b.png" draggable="false" />
      </div>
    `;

    const result = findSharedLightbox(document);
    expect(result?.sourceImages).toHaveLength(2);
    expect(result?.currentIndex).toBe(1);
  });

  it("clamps navigation at the first and last image", () => {
    expect(stepGalleryIndex(0, -1, 4)).toBe(0);
    expect(stepGalleryIndex(1, 1, 4)).toBe(2);
    expect(stepGalleryIndex(3, 1, 4)).toBe(3);
    expect(stepGalleryIndex(0, 1, 0)).toBe(-1);
  });

  it("detects only deliberate horizontal swipes", () => {
    expect(getHorizontalSwipeDirection({ x: 100, y: 20 }, { x: 20, y: 24 })).toBe(1);
    expect(getHorizontalSwipeDirection({ x: 20, y: 20 }, { x: 90, y: 24 })).toBe(-1);
    expect(getHorizontalSwipeDirection({ x: 20, y: 20 }, { x: 45, y: 100 })).toBe(0);
  });

  it("normalizes rotation and swaps contain limits for portrait turns", () => {
    expect(normalizeQuarterTurn(-90)).toBe(270);
    expect(normalizeQuarterTurn(450)).toBe(90);
    expect(getRotatedContainLimits(90)).toEqual({ maxWidth: "88vh", maxHeight: "92vw" });
    expect(getRotatedContainLimits(180)).toEqual({ maxWidth: "92vw", maxHeight: "88vh" });
  });
});
