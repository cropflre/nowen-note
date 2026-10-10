import { useCallback, useEffect, useState } from "react";
import { Boxes, FileCode, FileText, Loader2 } from "lucide-react";
import { pluginApi } from "@/lib/pluginApi";
import { listPluginNoteTemplates, replacePluginNoteTemplates, type RegisteredPluginNoteTemplate } from "@/lib/pluginTemplateRegistry";
import { prompt } from "@/components/ui/confirm";
export default function PluginNoteTemplatePickerSection({ disabled, onCreate }: { disabled?: boolean; onCreate?: (pluginId: string, templateId: string, values: Record<string, unknown>) => Promise<void> }) {
  const [templates, setTemplates] = useState<RegisteredPluginNoteTemplate[]>([]); const [creating, setCreating] = useState<string | null>(null);
  const load = useCallback(async () => { try { replacePluginNoteTemplates(await pluginApi.contributions()); setTemplates(listPluginNoteTemplates()); } catch { setTemplates([]); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!templates.length || !onCreate) return null;
  const create = async (template: RegisteredPluginNoteTemplate) => {
    const values: Record<string, unknown> = {};
    for (const field of template.variables || []) {
      const raw = await prompt({ title: field.label || field.id, description: template.name + " · " + field.type, defaultValue: field.default == null ? "" : String(field.default), confirmText: "继续" });
      if (raw == null) return;
      if (field.type === "number") { const value = Number(raw); if (!Number.isFinite(value)) return; values[field.id] = value; }
      else if (field.type === "boolean") values[field.id] = /^(1|true|yes|是)$/i.test(raw.trim()); else values[field.id] = raw;
    }
    setCreating(template.runtimeId); try { await onCreate(template.pluginId, template.id, values); } finally { setCreating(null); }
  };
  return <div className="mt-3 border-t border-app-border pt-3"><div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-semibold text-tx-tertiary"><Boxes size={13}/>来自插件</div><div className="space-y-2">{templates.map((template) => { const Icon = template.contentFormat === "markdown" ? FileCode : FileText; return <button key={template.runtimeId} type="button" disabled={disabled || Boolean(creating)} onClick={() => void create(template)} className="flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-bg/35 p-3 text-left transition-colors hover:border-accent-primary/35 hover:bg-app-hover disabled:opacity-50"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">{creating === template.runtimeId ? <Loader2 size={16} className="animate-spin"/> : <Icon size={16}/>}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-tx-primary">{template.name}</span><span className="mt-1 block truncate text-[11px] text-tx-tertiary">{template.description || template.pluginId} · {template.publisher || template.pluginId}</span></span></button>; })}</div></div>;
}
