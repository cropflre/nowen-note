import { describe, expect, it } from "vitest";
import {
  findLastIndexPolyfill,
  findLastPolyfill,
  toReversedPolyfill,
  toSortedPolyfill,
} from "@/lib/runtimePrelude";

describe("runtimePrelude polyfills", () => {
  it("implements reverse lookup semantics used by older WebKit fallbacks", () => {
    const values = [1, 2, 3, 2];
    expect(findLastPolyfill.call(values, (value) => value === 2)).toBe(2);
    expect(findLastIndexPolyfill.call(values, (value) => value === 2)).toBe(3);
    expect(findLastIndexPolyfill.call(values, (value) => value === 9)).toBe(-1);
  });

  it("returns copied arrays for change-by-copy helpers", () => {
    const source = [3, 1, 2];
    expect(toSortedPolyfill.call<number>(source, (a: number, b: number) => a - b)).toEqual([1, 2, 3]);
    expect(toReversedPolyfill.call<number>(source)).toEqual([2, 1, 3]);
    expect(source).toEqual([3, 1, 2]);
  });
});
