import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Database, Loader2, Power, RefreshCw, ShieldCheck } from "lucide-react";
import OriginalAISettingsPanel from "./AISettingsPanel";
import EmbeddingSettingsPanel from "./EmbeddingSettingsPanel";
import { getReliableAIStatus, setReliableAIEnabled, type ReliableStatus } from "@/lib/aiReliable";
import { cn } from "@/lib/utils";

export default function AISettingsReliabilityShell() {
  const [status, setStatus] = useState<ReliableStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStatus(await getReliableAIStatus());
    } catch (reason) {
      setError((reason as Error)?.message || "AI 配置状态加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handleSettingsChanged = () => void refresh();
    window.addEventListener("nowen:ai-settings-changed", handleSettingsChanged);
    window.addEventListener("nowen:ai-profiles-changed", handleSettingsChanged);
    return () => {
      window.removeEventListener("nowen:ai-settings-changed", handleSettingsChanged);
      window.removeEventListener("nowen:ai-profiles-changed", handleSettingsChanged);
    };
  }, [refresh]);

  const toggle = async () => {
    if (!status || saving) return;
    setSaving(true);
    setError("");
    try {
      const next = await setReliableAIEnabled(!status.enabled);
      setStatus(next);
      window.dispatchEvent(new CustomEvent("nowen:ai-manual-enabled-changed", {
        detail: { enabled: next.enabled },
      }));
    } catch (reason) {
      setError((reason as Error)?.message || "切换失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-start gap-3">
          <div className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            status?.enabled
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-zinc-500/10 text-zinc-500",
          )}>
            <Power size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">手动 AI 配置</h3>
              {status && (
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium",
                  status.enabled
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "bg-zinc-500/10 text-zinc-500",
                )}>
                  {status.enabled ? "已启用" : "已关闭"}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              关闭后会清空运行时 AI 地址与密钥，并阻止配置切换重新写回；已保存的配置档案仍保留，重新开启时恢复当前配置。
            </p>
          </div>
          <button
            type="button"
            disabled={loading || saving || !status}
            onClick={() => void toggle()}
            className={cn(
              "relative h-7 w-12 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50",
              status?.enabled ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700",
            )}
            aria-label={status?.enabled ? "关闭手动 AI 配置" : "开启手动 AI 配置"}
          >
            <span className={cn(
              "absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all",
              status?.enabled ? "left-6" : "left-1",
            )} />
          </button>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500"><ShieldCheck size={12} />当前对话模型</div>
            <div className="mt-1 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
              {loading ? "读取中…" : `${status?.provider || "未配置"} / ${status?.model || "未选择"}`}
            </div>
          </div>
          <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500"><Database size={12} />Embedding 模型</div>
            <div className="mt-1 truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
              {loading ? "读取中…" : status?.embeddingModel || "未配置，自动降级关键词检索"}
            </div>
          </div>
          <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500"><RefreshCw size={12} />知识库索引</div>
            <div className={cn(
              "mt-1 truncate text-xs font-medium",
              status?.index.stale ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400",
            )}>
              {loading ? "读取中…" : status?.index.stale
                ? `待处理 ${status.index.pending + status.index.processing}，失败 ${status.index.failed}`
                : `${status?.index.indexedNotes || 0}/${status?.index.totalNotes || 0} 篇已索引`}
            </div>
          </div>
        </div>

        {(saving || error) && (
          <div className={cn(
            "mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs",
            error
              ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
              : "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300",
          )}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
            {saving ? "正在安全切换配置状态…" : error}
          </div>
        )}
      </section>

      <div className={cn(!status?.enabled && "rounded-2xl ring-1 ring-zinc-200 opacity-80 dark:ring-zinc-800")}>
        <OriginalAISettingsPanel />
      </div>

      <div className={cn(!status?.enabled && "rounded-2xl ring-1 ring-zinc-200 opacity-80 dark:ring-zinc-800")}>
        <EmbeddingSettingsPanel />
      </div>
    </div>
  );
}
