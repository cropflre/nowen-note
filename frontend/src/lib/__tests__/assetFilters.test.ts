import { expect, it } from "vitest";
import {
  assetDateBoundary,
  assetLocalDate,
  explorerAssetFilters,
} from "../assetFilters";
it("saves relative recent windows and retains all tag and attribute conditions", () => {
  expect(
    explorerAssetFilters("recent", null, "spec", {
      tagIds: ["one", "two"],
      minSize: 0,
    }),
  ).toEqual({ q: "spec", tagIds: ["one", "two"], minSize: 0, recentDays: 7 });
  expect(
    explorerAssetFilters("image", "folder", "", { duplicateOnly: true }),
  ).toEqual({
    duplicateOnly: true,
    q: undefined,
    category: "image",
    folderId: "folder",
  });
});
it("uses local calendar days for both date boundaries", () => {
  for (const end of [false, true]) {
    const value = assetDateBoundary("2026-10-15", end)!;
    const date = new Date(value);
    expect(assetLocalDate(value)).toBe("2026-10-15");
    expect(date.getHours()).toBe(end ? 23 : 0);
    expect(date.getMilliseconds()).toBe(end ? 999 : 0);
  }
  expect(assetDateBoundary("", false)).toBeUndefined();
});
