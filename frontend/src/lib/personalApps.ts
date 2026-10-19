export type StudioField = { id: string; label: string; type: "text" | "checkbox" };
export type StudioItem = { id: string; values: Record<string, string | boolean> };
export type StudioSpec = {
  schemaVersion: 1; name: string; description: string; layout: "list" | "board"; fields: StudioField[]; items: StudioItem[];
};
export type StudioApp = { id: string; spec: StudioSpec; revision: number; createdAt: string; updatedAt: string };
export type StudioTemplate = "checklist" | "records" | "tracker";

// getRandomValues also works on private LAN HTTP (randomUUID requires secure context).
export function newStudioId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}


export function newStudioSpec(template: StudioTemplate): StudioSpec {
  switch (template) {
    case "checklist": return { schemaVersion: 1, name: "我的待办清单", description: "把日常事项整理到一张清单", layout: "list",
      fields: [{ id: "title", label: "事项", type: "text" }, { id: "done", label: "完成", type: "checkbox" }], items: [] };
    case "records": return { schemaVersion: 1, name: "个人资料库", description: "记录、整理、快速查看自己的信息", layout: "board",
      fields: [{ id: "title", label: "名称", type: "text" }, { id: "detail", label: "备注", type: "text" }], items: [] };
    case "tracker": return { schemaVersion: 1, name: "项目进度板", description: "按项目跟踪事项和完成状态", layout: "board",
      fields: [{ id: "title", label: "项目事项", type: "text" }, { id: "group", label: "项目", type: "text" }, { id: "done", label: "完成", type: "checkbox" }], items: [] };
  }
}
export function addStudioField(spec: StudioSpec, label: string, type: StudioField["type"], id: string): StudioSpec {
  if (!label.trim() || label.trim().length > 40 || spec.fields.length >= 8 || !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || spec.fields.some(f => f.id === id)) return spec;
  return { ...spec, fields: [...spec.fields, { id, label: label.trim(), type }] };
}
export function removeStudioField(spec: StudioSpec, fieldId: string): StudioSpec {
  if (spec.fields.length <= 1) return spec;
  return { ...spec, fields: spec.fields.filter(f => f.id !== fieldId), items: spec.items.map(item => {
    const values = { ...item.values }; delete values[fieldId]; return { ...item, values };
  }) };
}
export function addStudioItem(spec: StudioSpec, values: StudioItem["values"], id: string): StudioSpec {
  if (spec.items.length >= 100) return spec;
  const safe = Object.fromEntries(spec.fields.map(f => [f.id, f.type === "checkbox" ? values[f.id] === true : String(values[f.id] || "").slice(0, 240)]));
  return { ...spec, items: [...spec.items, { id, values: safe }] };
}
export function updateStudioItem(spec: StudioSpec, itemId: string, fieldId: string, value: string | boolean): StudioSpec {
  const field = spec.fields.find(f => f.id === fieldId);
  if (!field) return spec;
  const safe = field.type === "checkbox" ? value === true : String(value).slice(0, 240);
  return { ...spec, items: spec.items.map(item => item.id === itemId ? { ...item, values: { ...item.values, [fieldId]: safe } } : item) };
}
