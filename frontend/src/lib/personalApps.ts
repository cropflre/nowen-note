export type StudioField = { id: string; label: string; type: "text" | "checkbox" };
export type StudioItem = { id: string; values: Record<string, string | boolean> };
export type StudioSpec = {
  schemaVersion: 1; name: string; description: string; layout: "list" | "board"; fields: StudioField[]; items: StudioItem[];
};
export type StudioVersion = { revision: number; createdAt: string; name: string; layout: string; fieldCount: number; itemCount: number };
export type StudioApp = { id: string; spec: StudioSpec; revision: number; createdAt: string; updatedAt: string };
export type StudioTemplate = "tracker" | "reading" | "habits" | "meeting" | "travel" | "checklist" | "records";
type Translate = (key: string) => string;

/**
 * Template library of the create page. Templates are front-end data on the existing AppSpec v1 (text and
 * checkbox fields, no records); names and labels are translations under
 * `extensionCenter.create.templates.<id>`. Keywords let the page suggest a template before asking AI.
 */
export const STUDIO_TEMPLATES: ReadonlyArray<{
  id: StudioTemplate; layout: StudioSpec["layout"]; fields: ReadonlyArray<{ id: string; type: StudioField["type"] }>; keywords: readonly string[];
}> = [
  { id: "tracker", layout: "board", fields: [{ id: "title", type: "text" }, { id: "group", type: "text" }, { id: "done", type: "checkbox" }],
    keywords: ["项目", "进度", "看板", "里程碑", "负责人", "project", "progress", "kanban", "milestone", "owner"] },
  { id: "reading", layout: "list", fields: [{ id: "title", type: "text" }, { id: "author", type: "text" }, { id: "progress", type: "text" }, { id: "notes", type: "text" }, { id: "finished", type: "checkbox" }],
    keywords: ["阅读", "读书", "书单", "书籍", "reading", "book"] },
  { id: "habits", layout: "list", fields: [{ id: "date", type: "text" }, { id: "habit", type: "text" }, { id: "done", type: "checkbox" }, { id: "note", type: "text" }],
    keywords: ["习惯", "打卡", "坚持", "habit", "streak"] },
  { id: "meeting", layout: "list", fields: [{ id: "topic", type: "text" }, { id: "date", type: "text" }, { id: "attendees", type: "text" }, { id: "decision", type: "text" }, { id: "followup", type: "text" }, { id: "owner", type: "text" }, { id: "done", type: "checkbox" }],
    keywords: ["会议", "纪要", "议题", "例会", "meeting", "minutes", "agenda"] },
  { id: "travel", layout: "list", fields: [{ id: "item", type: "text" }, { id: "category", type: "text" }, { id: "note", type: "text" }, { id: "packed", type: "checkbox" }],
    keywords: ["旅行", "旅游", "出行", "行李", "出差", "travel", "trip", "packing", "luggage"] },
  { id: "checklist", layout: "list", fields: [{ id: "title", type: "text" }, { id: "done", type: "checkbox" }],
    keywords: ["待办", "清单", "todo", "to-do", "checklist"] },
  { id: "records", layout: "board", fields: [{ id: "title", type: "text" }, { id: "detail", type: "text" }],
    keywords: ["资料", "收藏", "备忘", "records", "collection"] },
];

// Latin keywords match at a word start so that "notebook" does not suggest the reading log.
function mentions(text: string, keyword: string): boolean {
  return /^[a-z-]+$/.test(keyword) ? new RegExp(`(^|[^a-z])${keyword}`).test(text) : text.includes(keyword);
}

/** Templates a free-text request already describes, best match first (at most two). */
export function matchStudioTemplates(request: string): StudioTemplate[] {
  const text = request.toLowerCase();
  if (!text.trim()) return [];
  return STUDIO_TEMPLATES
    .map((template) => ({ id: template.id, hits: template.keywords.filter((keyword) => mentions(text, keyword)).length }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 2)
    .map((entry) => entry.id);
}

// getRandomValues also works on private LAN HTTP (randomUUID requires secure context).
export function newStudioId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}


/** A new, unsaved app from a template, in the reader's language. Saving it is a separate, explicit step. */
export function newStudioSpec(template: StudioTemplate, t: Translate): StudioSpec {
  const entry = STUDIO_TEMPLATES.find((item) => item.id === template) ?? STUDIO_TEMPLATES[0];
  const key = `extensionCenter.create.templates.${entry.id}`;
  return {
    schemaVersion: 1, name: t(`${key}.name`), description: t(`${key}.description`), layout: entry.layout,
    fields: entry.fields.map((field) => ({ id: field.id, label: t(`${key}.fields.${field.id}`), type: field.type })), items: [],
  };
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
