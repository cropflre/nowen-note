import { describe, expect, it } from "vitest";
import { filterTagsByQuery } from "../../lib/tagSearch";

const tags = [
  { id: "1", name: "工作计划", noteCount: 5 },
  { id: "2", name: "React", noteCount: 3 },
  { id: "3", name: "react Native", noteCount: 1 },
  { id: "4", name: "生活记录", noteCount: 8 },
];

describe("sidebar tag query (#833)", () => {
  it("keeps all tags visible for an empty or whitespace-only query", () => {
    expect(filterTagsByQuery(tags, "")).toEqual(tags);
    expect(filterTagsByQuery(tags, "   ")).toEqual(tags);
  });

  it("matches Chinese names and ignores surrounding whitespace or a leading hash", () => {
    expect(filterTagsByQuery(tags, "  #工作  ")).toEqual([tags[0]]);
    expect(filterTagsByQuery(tags, "记录")).toEqual([tags[3]]);
  });

  it("matches partial English names without regard to case", () => {
    expect(filterTagsByQuery(tags, "REACT")).toEqual([tags[1], tags[2]]);
  });

  it("returns an empty list when no tags match and preserves the original data", () => {
    expect(filterTagsByQuery(tags, "not-found")).toEqual([]);
    expect(tags).toHaveLength(4);
    expect(tags[0].noteCount).toBe(5);
  });
});
