import { describe, expect, it } from "vitest";

import fixture from "../encryptedNotes/__tests__/fixtures/envelope-v1.json";
import { buildAutomaticConflictMerge } from "../syncConflictAutoMerge";

describe("Sync V2 三方智能合并", () => {
  it("加密正文即使只有一侧修改也必须明确选择版本", () => {
    const encrypted = { id: "note-1", contentFormat: "encrypted-note-v1", content: "opaque envelope", title: "旧标题" };
    const result = buildAutomaticConflictMerge({
      base: encrypted,
      local: { ...encrypted, title: "本机标题" },
      remote: { ...encrypted, content: "remote opaque envelope" },
    });
    expect(result).toEqual({ ok: false, reason: "encrypted-content", conflictFields: ["content"] });
  });
  it("未知加密类型也不能进入普通字段合并", () => {
    expect(buildAutomaticConflictMerge({
      base: null,
      local: { id: "note-1", contentFormat: "encrypted-note-v2" },
      remote: { id: "note-1", contentFormat: "markdown", content: "downgrade" },
    })).toEqual({ ok: false, reason: "encrypted-content", conflictFields: ["content"] });
  });
  it("任一版本含局部加密区域时必须明确选择完整版本", () => {
    const envelope = JSON.stringify({ ...fixture.envelope, kind: "block" });
    const contents = [
      { contentFormat: "markdown", content: `\`\`\`nowen-encrypted-v1\n${envelope}\n\`\`\`` },
      { contentFormat: "tiptap-json", content: JSON.stringify({ type: "doc", content: [{ type: "codeBlock", attrs: { language: "nowen-encrypted-v1" }, content: [{ type: "text", text: envelope }] }] }) },
      { contentFormat: "markdown", content: "```nowen-encrypted-v9\nunknown\n```" },
    ];
    for (const protectedPayload of contents) {
      for (const side of ["base", "local", "remote"] as const) {
        const versions = { base: { id: "note-1", content: "public", title: "old" }, local: { id: "note-1", content: "public", title: "local" }, remote: { id: "note-1", content: "changed", title: "old" } };
        expect(buildAutomaticConflictMerge({ ...versions, [side]: { ...versions[side], ...protectedPayload } })).toEqual({ ok: false, reason: "encrypted-content", conflictFields: ["content"] });
      }
    }
  });
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
        encryptedBlocksVersion: 1,
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
