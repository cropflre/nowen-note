import { describe, expect, it } from "vitest";
import i18n from "../index";

describe("sidebar and settings translations", () => {
  it.each([
    ["zh-CN", "我的笔记", "同步", "拆分文档", "当前空间共 2 个笔记本"],
    ["en", "My notes", "Sync", "Split document", "2 notebooks in current workspace"],
  ])("resolves the visible labels and notebook count in %s", (language, notes, sync, split, count) => {
    const t = i18n.getFixedT(language);
    expect(t("auditI18n.myNotes")).toBe(notes);
    expect(t("auditI18n.sync")).toBe(sync);
    expect(t("auditI18n.splitDocument")).toBe(split);
    expect(t("auditI18n.notebookCount", { count: 2 })).toBe(count);
  });
});
