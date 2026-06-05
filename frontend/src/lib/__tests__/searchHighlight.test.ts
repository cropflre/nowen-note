import { describe, expect, it } from "vitest";
import { highlightText, splitSearchTerms, stripSearchMarks } from "@/lib/searchHighlight";

describe("searchHighlight", () => {
  it("splits Chinese text into searchable character terms", () => {
    expect(splitSearchTerms("客户端安装")).toEqual(["客", "户", "端", "安", "装"]);
  });

  it("highlights Chinese matches in plain text", () => {
    expect(highlightText("windows客户端安装后", "客户端")).toContain('<mark class="search-result-highlight">客</mark>');
  });

  it("strips backend snippet marks before frontend highlighting", () => {
    expect(stripSearchMarks("windows<mark>客户端</mark>安装")).toBe("windows客户端安装");
  });
});
