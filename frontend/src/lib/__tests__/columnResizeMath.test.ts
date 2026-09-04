/**
 * 列宽拖拽数学逻辑验证。
 * 测试核心约束：新列宽必须夹在 [MIN, MAX] 区间内，
 * 且不会让其他列被压缩到 MIN 以下。
 */
import { describe, it, expect } from "vitest";

const MIN = 60;

function clamp(w: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, w));
}

/** 模拟插件的 maxW 计算：容器宽 - 间隙 - 其他列最小占用 */
function calcMaxW(containerW: number, colCount: number, gap: number): number {
  const totalGap = (colCount - 1) * gap;
  return Math.max(MIN, containerW - totalGap - (colCount - 1) * MIN);
}

describe("column resize math", () => {
  it("等宽两栏(800px容器,12pxgap): 单列max=800-12-60=728", () => {
    expect(calcMaxW(800, 2, 12)).toBe(728);
  });

  it("拖拽右移(加宽): 新宽=start+dx, 不超过 max", () => {
    const startW = 400;
    const dx = 200;
    const maxW = 728;
    expect(clamp(startW + dx, MIN, maxW)).toBe(600);
  });

  it("拖拽左移(收窄): 新宽不低于 MIN", () => {
    const startW = 400;
    const dx = -350;
    const maxW = 728;
    expect(clamp(startW + dx, MIN, maxW)).toBe(MIN);
  });

  it("极端dx: 超过上限时夹到 max", () => {
    const startW = 400;
    const dx = 9999;
    const maxW = 728;
    expect(clamp(startW + dx, MIN, maxW)).toBe(maxW);
  });
});
