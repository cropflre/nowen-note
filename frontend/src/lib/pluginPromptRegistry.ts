import type { PluginContributionRecord, PluginPromptPackContribution } from "@/lib/pluginApi";

const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const LOCAL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
export interface RegisteredPluginPrompt extends PluginPromptPackContribution { runtimeId: string; pluginId: string; publisher?: string }
let prompts: RegisteredPluginPrompt[] = [];
export function replacePluginPrompts(records: PluginContributionRecord[]): number {
  const next: RegisteredPluginPrompt[] = [];
  for (const record of records) {
    const pluginId = String(record.pluginId || "").toLowerCase();
    if (!PLUGIN_ID_RE.test(pluginId) || !Array.isArray(record.promptPacks)) continue;
    for (const item of record.promptPacks) {
      if (!item || !LOCAL_ID_RE.test(item.id) || typeof item.name !== "string" || typeof item.prompt !== "string") continue;
      next.push({ ...item, runtimeId: `${pluginId}/${item.id}`, pluginId, publisher: record.publisher });
    }
  }
  prompts = next;
  return next.length;
}
export function listPluginPrompts(platform?: "web" | "desktop" | "android" | "ios"): RegisteredPluginPrompt[] {
  return prompts.filter((item) => !platform || !item.uiPlatform?.length || item.uiPlatform.includes(platform));
}
export function renderPluginPrompt(item: RegisteredPluginPrompt, values: Record<string, unknown>): string {
  for (const field of item.inputs || []) {
    const value = values[field.id] ?? field.default;
    if (field.required && (value === undefined || value === null || value === "")) throw new Error(`缺少 Prompt 输入: ${field.id}`);
    if (value !== undefined && value !== null && typeof value !== field.type) throw new Error(`Prompt 输入类型错误: ${field.id}`);
  }
  return item.prompt.replace(/\{\{\s*([a-z][a-z0-9_-]{0,63})\s*\}\}/gi, (_all, key: string) => {
    const field = item.inputs?.find((entry) => entry.id === key);
    const value = values[key] ?? field?.default;
    return value === undefined || value === null ? `{{${key}}}` : String(value);
  });
}
