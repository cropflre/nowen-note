import type { PluginContributionRecord, PluginNoteTemplateContribution } from "@/lib/pluginApi";

const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const LOCAL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const UNSAFE = /(?:<\s*(?:script|iframe|object)\b|javascript\s*:|data\s*:\s*text\/html)/i;
export interface RegisteredPluginNoteTemplate extends PluginNoteTemplateContribution { runtimeId: string; pluginId: string; publisher?: string }
let templates: RegisteredPluginNoteTemplate[] = [];
export function replacePluginNoteTemplates(records: PluginContributionRecord[]): number {
  const next: RegisteredPluginNoteTemplate[] = [];
  for (const record of records) {
    const pluginId = String(record.pluginId || "").toLowerCase();
    if (!PLUGIN_ID_RE.test(pluginId) || !Array.isArray(record.noteTemplates)) continue;
    for (const item of record.noteTemplates) {
      if (!item || !LOCAL_ID_RE.test(item.id) || typeof item.name !== "string" || typeof item.body !== "string" || UNSAFE.test(item.body)) continue;
      next.push({ ...item, runtimeId: `${pluginId}/${item.id}`, pluginId, publisher: record.publisher });
    }
  }
  templates = next;
  return next.length;
}
export function listPluginNoteTemplates(): RegisteredPluginNoteTemplate[] { return [...templates]; }
