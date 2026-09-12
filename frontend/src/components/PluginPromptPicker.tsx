import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { pluginApi } from "@/lib/pluginApi";
import { listPluginPrompts, renderPluginPrompt, replacePluginPrompts, type RegisteredPluginPrompt } from "@/lib/pluginPromptRegistry";
import { useApp } from "@/store/AppContext";
function currentPlatform(): "web" | "desktop" { return typeof window !== "undefined" && "electronAPI" in window ? "desktop" : "web"; }
export default function PluginPromptPicker({ onSelect, disabled }: { onSelect: (value: string) => void; disabled?: boolean }) {
  const { state } = useApp(); const [items, setItems] = useState<RegisteredPluginPrompt[]>([]); const [open, setOpen] = useState(false);
  const load = useCallback(async () => { try { replacePluginPrompts(await pluginApi.contributions()); setItems(listPluginPrompts(currentPlatform()).filter((item) => !item.context?.includes("selection"))); } catch { setItems([]); } }, []);
  useEffect(() => { void load(); }, [load]); const note = state.activeNote as any;
  const select = async (item: RegisteredPluginPrompt) => { const values: Record<string, unknown> = {};
    for (const field of item.inputs || []) { const raw = window.prompt(field.label || field.id, field.default == null ? "" : String(field.default)); if (raw == null) return; values[field.id] = field.type === "number" ? Number(raw) : field.type === "boolean" ? /^(1|true|yes|是)$/i.test(raw.trim()) : raw; }
    let value = renderPluginPrompt(item, values); const context: string[] = [];
    if (item.context?.includes("title") && note?.title) context.push("标题：" + note.title);
    if (item.context?.includes("note") && (note?.contentText || note?.content)) context.push("笔记内容：
" + String(note.contentText || note.content).slice(0, 12000));
    if (item.context?.includes("tags") && Array.isArray(note?.tags) && note.tags.length) context.push("标签：" + note.tags.map((tag: any) => tag.name || tag).join(", "));
    if (context.length) value += "

以下是 Host 按声明提供的最小上下文：
" + context.join("

"); onSelect(value); setOpen(false);
  };
  if (!items.length) return null;
  return <div className="relative"><button type="button" disabled={disabled} onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-violet-500 hover:bg-violet-500/10 disabled:opacity-50"><Sparkles size={11}/>Prompt Pack</button>{open && <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-app-border bg-app-surface p-1.5 shadow-xl">{items.map((item) => <button key={item.runtimeId} type="button" onClick={() => void select(item)} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-app-hover"><span className="block text-xs font-medium text-tx-primary">{item.name}</span><span className="mt-0.5 block text-[10px] text-tx-tertiary">{item.description || item.pluginId}</span></button>)}</div>}</div>;
}
