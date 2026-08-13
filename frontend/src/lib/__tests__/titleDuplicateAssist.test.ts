import { describe, expect, it } from "vitest";

import {
  findTitleDuplicateMatch,
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
