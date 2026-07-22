import { describe, expect, it } from "vitest";
import {
  calculateOutlineDesiredScrollTop,
  calculateOutlineScrollTop,
  calculateRequiredOutlineReserve,
} from "../outlineScroll";

describe("outline scroll positioning", () => {
  it("uses the same anchor whether the heading starts above, inside or below the viewport", () => {
    const states = [
      { scrollTop: 0, targetTop: 700 },
      { scrollTop: 500, targetTop: 200 },
      { scrollTop: 700, targetTop: 0 },
    ];

    const positions = states.map((state) => calculateOutlineDesiredScrollTop({
      ...state,
      containerTop: 100,
      topOffset: 0,
      gap: 24,
    }));

    expect(positions).toEqual([576, 576, 576]);
  });

  it("subtracts only the explicit top overlap and safety gap", () => {
    expect(calculateOutlineDesiredScrollTop({
      scrollTop: 320,
      containerTop: 120,
      targetTop: 460,
      topOffset: 48,
      gap: 20,
    })).toBe(592);
  });

  it("clamps the destination to the available scroll range", () => {
    expect(calculateOutlineScrollTop({
      scrollTop: 0,
      containerTop: 100,
      targetTop: 20,
      scrollHeight: 1200,
      clientHeight: 500,
      gap: 24,
    })).toBe(0);

    expect(calculateOutlineScrollTop({
      scrollTop: 0,
      containerTop: 100,
      targetTop: 1200,
      scrollHeight: 1000,
      clientHeight: 400,
      gap: 24,
    })).toBe(600);
  });

  it("adds the minimum reserve required for a final heading to reach the anchor", () => {
    const reserve = calculateRequiredOutlineReserve({
      desiredScrollTop: 900,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    expect(reserve).toBe(300);

    expect(calculateOutlineScrollTop({
      scrollTop: 0,
      containerTop: 0,
      targetTop: 924,
      scrollHeight: 1000 + reserve,
      clientHeight: 400,
      gap: 24,
    })).toBe(900);
  });

  it("keeps an existing reserve to avoid a second layout jump during rapid navigation", () => {
    expect(calculateRequiredOutlineReserve({
      desiredScrollTop: 200,
      scrollHeight: 1300,
      clientHeight: 400,
      currentReserve: 300,
    })).toBe(300);
  });
});
