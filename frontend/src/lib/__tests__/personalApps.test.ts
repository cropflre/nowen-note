import { describe, expect, it } from "vitest";
import { enExtensionCenterTranslations, zhCNExtensionCenterTranslations } from "@/i18n/extensionCenterTranslations";
import { matchStudioTemplates, newStudioSpec, STUDIO_TEMPLATES, addStudioItem, addStudioField, removeStudioField, updateStudioItem } from "../personalApps";

// Resolves "a.b.c" in a translation tree; a missing key fails instead of leaking the key into an app.
const translator = (tree: Record<string, unknown>) => (key: string) => {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
  if (typeof value !== "string") throw new Error(`missing translation ${key}`);
  return value;
};
const zh = translator(zhCNExtensionCenterTranslations), en = translator(enExtensionCenterTranslations);

describe("No-code Studio models", () => {
  it("offers the six official templates first, then the general records template", () => {
    expect(STUDIO_TEMPLATES.map((template) => template.id)).toEqual(["tracker", "reading", "habits", "meeting", "travel", "checklist", "records"]);
    expect(STUDIO_TEMPLATES.slice(0, 6).map((template) => zh(`extensionCenter.create.templates.${template.id}.title`)))
      .toEqual(["项目进度", "阅读记录", "习惯追踪", "会议纪要", "旅行清单", "日常待办"]);
  });

  it("builds every template as an editable AppSpec v1 in both languages, without code, records or permissions", () => {
    for (const t of [zh, en]) for (const { id } of STUDIO_TEMPLATES) {
      const spec = newStudioSpec(id, t);
      expect(spec.schemaVersion).toBe(1);
      expect(spec.items).toEqual([]);
      expect(spec.name.trim()).not.toBe("");
      expect(spec.name.length).toBeLessThanOrEqual(64);
      expect(spec.description.length).toBeLessThanOrEqual(200);
      expect(spec.fields.length).toBeGreaterThan(0);
      expect(spec.fields.length).toBeLessThanOrEqual(8);
      expect(new Set(spec.fields.map((field) => field.id)).size).toBe(spec.fields.length);
      for (const field of spec.fields) {
        expect(field.id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
        expect(["text", "checkbox"]).toContain(field.type);
        expect(field.label.trim()).not.toBe("");
        expect(field.label.length).toBeLessThanOrEqual(40);
      }
      expect(JSON.stringify(spec)).not.toMatch(/<script|apiToken|permissions|extensionCenter\./i);
    }
  });

  it("keeps the Chinese content of the three original templates unchanged", () => {
    expect(newStudioSpec("checklist", zh)).toEqual({ schemaVersion: 1, name: "我的待办清单", description: "把日常事项整理到一张清单", layout: "list",
      fields: [{ id: "title", label: "事项", type: "text" }, { id: "done", label: "完成", type: "checkbox" }], items: [] });
    expect(newStudioSpec("records", zh)).toEqual({ schemaVersion: 1, name: "个人资料库", description: "记录、整理、快速查看自己的信息", layout: "board",
      fields: [{ id: "title", label: "名称", type: "text" }, { id: "detail", label: "备注", type: "text" }], items: [] });
    expect(newStudioSpec("tracker", zh)).toEqual({ schemaVersion: 1, name: "项目进度板", description: "按项目跟踪事项和完成状态", layout: "board",
      fields: [{ id: "title", label: "项目事项", type: "text" }, { id: "group", label: "项目", type: "text" }, { id: "done", label: "完成", type: "checkbox" }], items: [] });
  });

  it("suggests the templates a request already describes, best match first", () => {
    expect(matchStudioTemplates("做一个项目进度看板，有负责人、事项和完成状态")).toEqual(["tracker"]);
    expect(matchStudioTemplates("A reading log for the books I finish")).toEqual(["reading"]);
    // Latin keywords only match at a word start.
    expect(matchStudioTemplates("Organize my notebook")).toEqual([]);
    expect(matchStudioTemplates("旅行打卡清单")).toHaveLength(2);
    expect(matchStudioTemplates("   ")).toEqual([]);
  });

  it("updates typed item values and cleans orphan fields", () => {
    let spec = newStudioSpec("tracker", en);
    spec = addStudioField(spec, "Extra", "text", "extra");
    spec = addStudioItem(spec, { title: "Phase A", done: false, extra: "foo" }, "item1");
    spec = updateStudioItem(spec, "item1", "done", true);
    expect(spec.items[0].values.done).toBe(true);
    spec = removeStudioField(spec, "extra");
    expect(spec.fields.some(f => f.id === "extra")).toBe(false);
    expect(spec.items[0].values).not.toHaveProperty("extra");
  });
});
