import { describe, expect, it } from "vitest";

import { buildAutomaticConflictMerge } from "../syncConflictAutoMerge";

describe("Sync V2 三方智能合并", () => {
  it("合并本机与服务器修改的不同字段", () => {
    const result = buildAutomaticConflictMerge({
      base: {
        id: "note-1",
        title: "旧标题",
        content: "旧正文",
        tags: ["同步"],
        version: 2,
        updatedAt: "2026-08-23T01:00:00.000Z",
      },
      local: {
        id: "note-1",
        title: "本机标题",
        content: "旧正文",
        tags: ["同步"],
        version: 2,
        updatedAt: "2026-08-23T02:00:00.000Z",
        baseUpdatedAt: "transport-only",
      },
      remote: {
        id: "note-1",
        title: "旧标题",
        content: "服务器正文",
        tags: ["同步"],
        version: 3,
        updatedAt: "2026-08-23T03:00:00.000Z",
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        content: "服务器正文",
        id: "note-1",
        tags: ["同步"],
        title: "本机标题",
        updatedAt: "2026-08-23T02:00:00.000Z",
        version: 3,
      },
      mergedFields: ["content", "title"],
    });
  });

  it("两边把同一字段改成不同值时拒绝自动覆盖", () => {
    const result = buildAutomaticConflictMerge({
      base: { id: "note-1", content: "旧正文" },
      local: { id: "note-1", content: "本机正文" },
      remote: { id: "note-1", content: "服务器正文" },
    });

    expect(result).toEqual({
      ok: false,
      reason: "overlapping-changes",
      conflictFields: ["content"],
    });
  });

  it("双方改成相同值以及字段删除都可以安全合并", () => {
    const result = buildAutomaticConflictMerge({
      base: { id: "note-1", title: "旧标题", summary: "待删除" },
      local: { id: "note-1", title: "新标题" },
      remote: { id: "note-1", title: "新标题", summary: "待删除" },
    });

    expect(result).toEqual({
      ok: true,
      payload: { id: "note-1", title: "新标题" },
      mergedFields: ["summary", "title"],
    });
  });

  it("缺少共同基线时继续保留为手动冲突", () => {
    expect(buildAutomaticConflictMerge({
      base: null,
      local: { id: "note-1", title: "本机" },
      remote: { id: "note-1", title: "服务器" },
    })).toEqual({
      ok: false,
      reason: "missing-base",
      conflictFields: [],
    });
  });
});
