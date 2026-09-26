import { describe, expect, it } from "vitest";

import {
  findTitleDuplicateMatch,
  findTitleDuplicateRanges,
  type TitleDuplicateCandidate,
} from "../titleDuplicateAssist";

const notebookId = "nb-1";

function candidate(
  id: string,
  title: string,
  overrides: Partial<TitleDuplicateCandidate> = {},
): TitleDuplicateCandidate {
  return {
    id,
    title,
    notebookId,
    isTrashed: 0,
    ...overrides,
  };
}

describe("titleDuplicateAssist", () => {
  it("完全重复时返回整条标题长度", () => {
    const title = "我司-201A00276_YD-5039-ZN-V1.5有氛围灯";
    const match = findTitleDuplicateMatch({
      title,
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("other", title)],
    });

    expect(match).toEqual({
      candidateId: "other",
      candidateTitle: title,
      prefixLength: title.length,
      exact: true,
    });
  });

  it("多个候选时选择最长公共前缀", () => {
    const title = "我司-201A00276_YD-5039-ZN-V1.6无氛围灯不带EMC";
    const shorter = "我司-201A00276_其它";
    const longer = "我司-201A00276_YD-5039-ZN-V1.5有氛围灯";
    const match = findTitleDuplicateMatch({
      title,
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("short", shorter), candidate("long", longer)],
    });

    expect(match?.candidateId).toBe("long");
    expect(match?.prefixLength).toBe("我司-201A00276_YD-5039-ZN-V1.".length);
    expect(match?.exact).toBe(false);
  });

  it("公共前缀正好 8 个字符时返回匹配", () => {
    const match = findTitleDuplicateMatch({
      title: "ABCDEFGH当前",
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("other", "ABCDEFGH历史")],
    });

    expect(match?.prefixLength).toBe(8);
  });

  it("公共前缀不足 8 个字符时返回 null", () => {
    const match = findTitleDuplicateMatch({
      title: "ABCDEFG当前",
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("other", "ABCDEFG历史")],
    });

    expect(match).toBeNull();
  });

  it("排除当前 note 自身", () => {
    const match = findTitleDuplicateMatch({
      title: "ABCDEFGH-重复",
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("current", "ABCDEFGH-重复")],
    });

    expect(match).toBeNull();
  });

  it("排除回收站笔记", () => {
    const match = findTitleDuplicateMatch({
      title: "ABCDEFGH-重复",
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("trashed", "ABCDEFGH-重复", { isTrashed: 1 })],
    });

    expect(match).toBeNull();
  });

  it("旧前缀匹配函数仍默认排除其它 notebook 候选", () => {
    expect(findTitleDuplicateMatch({
      title: "ABCDEFGH当前",
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("child", "ABCDEFGH历史", { notebookId: "child-nb" })],
    })).toBeNull();
  });

  it("空输入不检测", () => {
    expect(findTitleDuplicateMatch({
      title: "",
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("other", "ABCDEFGH")],
    })).toBeNull();
  });

  it("没有满足阈值的候选时返回 null", () => {
    expect(findTitleDuplicateMatch({
      title: "技术资料-测试",
      currentNoteId: "current",
      currentNotebookId: notebookId,
      candidates: [candidate("other", "技术文档-测试")],
    })).toBeNull();
  });
});

describe("title duplicate ranges", () => {
  const rangesFor = (title: string, candidates: TitleDuplicateCandidate[]) => findTitleDuplicateRanges({
    title,
    currentNoteId: "current",
    currentNotebookId: notebookId,
    candidates,
  });

  it("highlights a repeated business number in the middle without coloring the prefix", () => {
    const title = "驰铭-13010181_CM-7023";
    expect(rangesFor(title, [candidate("other", "其它供应商-13010181-A版")])).toEqual([{
      from: title.indexOf("13010181"),
      to: title.indexOf("13010181") + 8,
      type: "serial",
      candidateId: "other",
    }]);
  });

  it("matches repeated numbers at the start and end, and multiple mixed codes", () => {
    expect(rangesFor("13010181-项目", [candidate("other", "旧版-13010181")])).toHaveLength(1);
    expect(rangesFor("项目-13010181", [candidate("other", "13010181-旧版")])).toHaveLength(1);
    const title = "项目 CM-7023 / ABC_123456";
    const matches = rangesFor(title, [candidate("other", "旧版 cm_7023 与 abc-123456")]);
    expect(matches.map(({ from, to }) => title.slice(from, to))).toEqual(["CM-7023", "ABC_123456"]);
    expect(rangesFor("项目 A13010181 与 201A00276", [candidate("other", "历史 a13010181 / 201a00276")])
      .map(({ from, to }) => "项目 A13010181 与 201A00276".slice(from, to)))
      .toEqual(["A13010181", "201A00276"]);
  });

  it("does not report short common tokens, self, or trashed notes", () => {
    expect(rangesFor("项目 V1 H1 2026", [candidate("other", "历史 V1 H1 2026")])).toEqual([]);
    expect(rangesFor("项目 13010181", [candidate("current", "历史 13010181"), candidate("trash", "历史 13010181", { isTrashed: 1 })])).toEqual([]);
  });

  it("retains exact and prefix priority, and accepts candidates supplied from a descendant notebook", () => {
    expect(rangesFor("ABCDEFGH当前", [candidate("other", "ABCDEFGH历史")])).toEqual([{
      from: 0, to: 8, type: "prefix", candidateId: "other",
    }]);
    expect(rangesFor("完全相同标题", [candidate("other", "完全相同标题")])).toEqual([{
      from: 0, to: "完全相同标题".length, type: "exact", candidateId: "other",
    }]);
    expect(rangesFor("项目 13010181", [candidate("child", "旧版 13010181", { notebookId: "child-nb" })])).toHaveLength(1);
    expect(rangesFor("ABCDEFGH当前", [candidate("child", "ABCDEFGH历史", { notebookId: "child-nb" })])).toEqual([{
      from: 0, to: 8, type: "prefix", candidateId: "child",
    }]);
  });
});
