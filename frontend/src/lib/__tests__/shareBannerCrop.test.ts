import { describe, expect, it } from "vitest";
import { shareBannerCrop } from "../shareBanner";

describe("横幅裁切位置", () => {
  it("竖图居中裁切为横幅，顶部和底部位置可选", () => {
    expect(shareBannerCrop(400, 800, 50, 50)).toEqual({ x: 0, y: 350, width: 400, height: 100 });
    expect(shareBannerCrop(400, 800, 50, 0).y).toBe(0);
    expect(shareBannerCrop(400, 800, 50, 100).y).toBe(700);
  });
  it("全景图可横向取景，不引入留白", () => {
    expect(shareBannerCrop(2000, 200, 50, 50)).toEqual({ x: 600, y: 0, width: 800, height: 200 });
    expect(shareBannerCrop(2000, 200, 0, 50).x).toBe(0);
    expect(shareBannerCrop(2000, 200, 100, 50).x).toBe(1200);
  });
  it("已是横幅比例的图片不被二次裁切", () => {
    expect(shareBannerCrop(1600, 400, 0, 100)).toEqual({ x: 0, y: 0, width: 1600, height: 400 });
  });
});
