import { describe, expect, it } from "vitest";
import { parseAiTaskIntent } from "@/lib/aiTaskIntent";
import { enCoverageTranslations, zhCNCoverageTranslations } from "@/i18n/coverageTranslations";

describe("AI personal-task intent is input grammar, independent of UI locale", () => {
  it("keeps previously supported Chinese task creation, with 300 character limit", () => {
    expect(parseAiTaskIntent("/待办 创建  学习React ")).toEqual({
      kind: "create", title: "学习React",
    });
    expect(parseAiTaskIntent("/待办 创建 " + "a".repeat(300))).toEqual({
      kind: "create", title: "a".repeat(300),
    });
    expect(parseAiTaskIntent("/待办 创建 " + "a".repeat(301))).toBeNull();
    expect(parseAiTaskIntent("/待办 创建")).toBeNull();
  });
  it("keeps task IDs limited to the original accepted ASCII command syntax", () => {
    expect(parseAiTaskIntent("/待办 完成 6bca-09A2")).toEqual({
      kind: "complete", taskId: "6bca-09A2",
    });
    expect(parseAiTaskIntent("/待办 完成 foo bar")).toBeNull();
    expect(parseAiTaskIntent("/待办 完成")).toBeNull();
  });
  it("preserves morning/evening inference and the shorthand", () => {
    expect(parseAiTaskIntent("/待办")).toEqual({ kind: "digest", mode: "morning" });
    expect(parseAiTaskIntent("今天有哪些待办？")).toEqual({ kind: "digest", mode: "morning" });
    expect(parseAiTaskIntent("今日任务总结")).toEqual({ kind: "digest", mode: "evening" });
    expect(parseAiTaskIntent("看看待办今天完成进度")).toEqual({ kind: "digest", mode: "evening" });
    expect(parseAiTaskIntent("晚间报告")).toBeNull();
    expect(parseAiTaskIntent("帮我写一篇小说")).toBeNull();
  });
  it("defines matching translation keys and interpolation for both locales", () => {
    const zh = zhCNCoverageTranslations.aiChatTask;
    const en = enCoverageTranslations.aiChatTask;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      const variables = (value: string) =>
        [...value.matchAll(/{{\s*([\w-]+)\s*}}/g)].map(m => m[1]).sort();
      expect(variables(zh[key])).toEqual(variables(en[key]));
    }
    expect(zh.created).toContain("已创建个人待办");
    expect(en.created).toContain("Created personal task");
    expect(en.todayTasks).not.toContain("今日");
  });
});
