import { describe, expect, it } from "vitest";
import { newStudioSpec, addStudioItem, addStudioField, removeStudioField, updateStudioItem } from "../personalApps";
describe("No-code Studio models", () => {
  it("builds three editable templates without JS or elevated permissions", () => {
    for (const template of ["checklist", "records", "tracker"] as const) {
      const spec = newStudioSpec(template);
      expect(spec.schemaVersion).toBe(1);
      expect(spec.items).toEqual([]);
      expect(spec.fields.length).toBeGreaterThan(0);
      expect(JSON.stringify(spec)).not.toMatch(/<script|apiToken|permissions/i);
    }
  });
  it("updates typed item values and cleans orphan fields", () => {
    let spec = newStudioSpec("tracker");
    spec = addStudioField(spec, "Extra", "text", "extra");
    spec = addStudioItem(spec, { title: "Phase A", done: false, extra: "foo" }, "item1");
    spec = updateStudioItem(spec, "item1", "done", true);
    expect(spec.items[0].values.done).toBe(true);
    spec = removeStudioField(spec, "extra");
    expect(spec.fields.some(f => f.id === "extra")).toBe(false);
    expect(spec.items[0].values).not.toHaveProperty("extra");
  });
});
