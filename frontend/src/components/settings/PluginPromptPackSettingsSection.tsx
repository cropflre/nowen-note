import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { pluginApi } from "@/lib/pluginApi";
import { listPluginPrompts, replacePluginPrompts, type RegisteredPluginPrompt } from "@/lib/pluginPromptRegistry";

export default function PluginPromptPackSettingsSection() {
  const [items, setItems] = useState<RegisteredPluginPrompt[]>([]);
  useEffect(() => {
    void pluginApi.contributions().then((records) => {
      replacePluginPrompts(records);
      setItems(listPluginPrompts());
    }).catch(() => setItems([]));
  }, []);
  if (!items.length) return null;
  return (
    <section className="rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm">
      <div className="mb-3.5 flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500/20 to-violet-500/20 text-violet-600 ring-1 ring-violet-500/20 dark:text-violet-300">
          <Sparkles size={16} />
        </span>
        <div>
          <div className="text-sm font-bold text-tx-primary">来自插件的 Prompt Pack</div>
          <div className="text-[11px] text-tx-secondary">只声明 Prompt 和最小上下文，不会获得你的 AI Key。</div>
        </div>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.runtimeId} className="rounded-xl border border-app-border/75 bg-app-surface/75 p-3.5 transition-all hover:-translate-y-0.5 hover:border-violet-400/40 hover:shadow-xs">
            <div className="text-xs font-semibold text-tx-primary">{item.name}</div>
            <div className="mt-1 text-[11px] text-tx-secondary">{item.description || item.pluginId}</div>
            <div className="mt-2 inline-flex rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
              上下文：{item.context?.join(" · ") || "无"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
