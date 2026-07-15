import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Sparkles,
} from "lucide-react";
import { api, getBaseUrl, getCurrentWorkspace } from "@/lib/api";
import { getReliableAIStatus, type ReliableStatus } from "@/lib/aiReliable";
import { cn } from "@/lib/utils";

interface AISettingsResponse {
  ai_provider: string;
  ai_api_url: string;
  ai_api_key: string;
  ai_api_key_set: boolean;
  ai_model: string;
  ai_embedding_url?: string;
  ai_embedding_key?: string;
  ai_embedding_key_set?: boolean;
  ai_embedding_model?: string;
}

interface EmbeddingDraft {
  provider: string;
  url: string;
  key: string;
  keySet: boolean;
  model: string;
  useChatCredentials: boolean;
}

type EmbeddingMessage = {
  type: "success" | "warning" | "error";
  text: string;
};

const EMPTY_DRAFT: EmbeddingDraft = {
  provider: "openai",
  url: "",
  key: "",
  keySet: false,
  model: "",
  useChatCredentials: true,
};

const MODEL_SUGGESTIONS = ["text-embedding-3-small", "text-embedding-v3", "bge-m3"];

function getCopy() {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  if (!language.startsWith("zh")) {
    return {
      title: "Vector search (Embedding)",
      description: "Configure a dedicated embedding model for semantic knowledge-base search. Leave it empty to keep keyword search only.",
      enabled: "Configured",
      disabled: "Keyword fallback",
      reuseTitle: "Reuse the current chat API URL and key",
      reuseDescription: "Saving in this mode clears the dedicated URL and key, then follows the active chat configuration.",
      embeddingUrl: "Embedding API URL",
      embeddingKey: "Embedding API key",
      embeddingModel: "Embedding model",
      urlPlaceholder: "Leave empty to reuse the chat API URL",
      keyPlaceholder: "Leave empty to reuse the chat API key",
      savedKey: "Dedicated key saved (leave empty to keep it)",
      modelPlaceholder: "For example: text-embedding-3-small",
      examples: "Common examples; use a model supported by your provider:",
      save: "Save embedding settings",
      rebuild: "Rebuild vector index",
      refresh: "Refresh status",
      saving: "Saving…",
      rebuilding: "Rebuilding…",
      saved: "Embedding settings saved.",
      disabledSaved: "Embedding model cleared. Knowledge-base search will use keyword fallback.",
      modelChanged: "Settings saved. Rebuild the index after changing the embedding model.",
      rebuildConfirm: "Rebuild all note and attachment vectors now? This may consume API quota.",
      rebuildQueued: "Vector rebuild queued. Indexing continues in the background.",
      loadFailed: "Failed to load embedding settings",
      saveFailed: "Failed to save embedding settings",
      rebuildFailed: "Failed to rebuild the vector index",
      notes: "Notes",
      attachments: "Attachments",
      queue: "Queue",
      vectorEngine: "Vector engine",
      ready: "Ready",
      unavailable: "Unavailable",
      pending: "pending",
      processing: "processing",
      failed: "failed",
      dimension: "dimensions",
      notConfigured: "Configure a model before rebuilding the index.",
      statusLoading: "Loading index status…",
      backgroundHint: "Indexing runs in the background. Failed jobs can be retried by rebuilding the index.",
    };
  }
  return {
    title: "向量检索（Embedding）",
    description: "配置独立的 Embedding 模型，为知识库提供语义检索；留空时继续使用关键词检索，不影响 AI 对话。",
    enabled: "已配置",
    disabled: "关键词降级",
    reuseTitle: "复用当前对话 API 地址与密钥",
    reuseDescription: "保存后会清空独立地址和密钥，Embedding 自动跟随当前对话配置。",
    embeddingUrl: "Embedding API 地址",
    embeddingKey: "Embedding API Key",
    embeddingModel: "Embedding 模型",
    urlPlaceholder: "留空则复用当前对话 API 地址",
    keyPlaceholder: "留空则复用当前对话 API Key",
    savedKey: "已保存独立密钥（留空不修改）",
    modelPlaceholder: "例如：text-embedding-3-small",
    examples: "常用示例，请以服务商实际支持的模型为准：",
    save: "保存 Embedding 配置",
    rebuild: "重建向量索引",
    refresh: "刷新状态",
    saving: "正在保存…",
    rebuilding: "正在重建…",
    saved: "Embedding 配置已保存。",
    disabledSaved: "已清空 Embedding 模型，知识库将自动降级为关键词检索。",
    modelChanged: "配置已保存。Embedding 模型发生变化，请重建向量索引。",
    rebuildConfirm: "确定重建全部笔记和附件的向量索引吗？此操作可能消耗 API 配额。",
    rebuildQueued: "已提交向量重建任务，后台将持续处理。",
    loadFailed: "Embedding 配置加载失败",
    saveFailed: "Embedding 配置保存失败",
    rebuildFailed: "向量索引重建失败",
    notes: "笔记",
    attachments: "附件",
    queue: "任务队列",
    vectorEngine: "向量引擎",
    ready: "可用",
    unavailable: "不可用",
    pending: "待处理",
    processing: "处理中",
    failed: "失败",
    dimension: "维",
    notConfigured: "请先保存 Embedding 模型，再重建索引。",
    statusLoading: "正在读取索引状态…",
    backgroundHint: "索引在后台异步执行；失败任务可通过重新构建索引再次处理。",
  };
}

async function rebuildEmbeddingIndex(): Promise<void> {
  const token = localStorage.getItem("nowen-token") || "";
  const workspace = getCurrentWorkspace();
  const query = workspace && workspace !== "personal"
    ? `?workspaceId=${encodeURIComponent(workspace)}`
    : "";
  const response = await fetch(`${getBaseUrl()}/ai/embeddings/rebuild${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ clearExisting: true }),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  throw new Error(body?.error || `Request failed: ${response.status}`);
}

export default function EmbeddingSettingsPanel() {
  const copy = useMemo(getCopy, []);
  const [draft, setDraft] = useState<EmbeddingDraft>(EMPTY_DRAFT);
  const [status, setStatus] = useState<ReliableStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState<EmbeddingMessage | null>(null);

  const refreshStatus = useCallback(async (silent = false) => {
    if (!silent) setStatusLoading(true);
    try {
      setStatus(await getReliableAIStatus());
    } catch (error) {
      if (!silent) {
        setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
      }
    } finally {
      if (!silent) setStatusLoading(false);
    }
  }, [copy.loadFailed]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const settings = await api.getAISettings() as unknown as AISettingsResponse;
      const customUrl = settings.ai_embedding_url || "";
      const customKeySet = !!settings.ai_embedding_key_set;
      setDraft({
        provider: settings.ai_provider || "openai",
        url: customUrl,
        key: "",
        keySet: customKeySet,
        model: settings.ai_embedding_model || "",
        useChatCredentials: !customUrl && !customKeySet,
      });
      await refreshStatus(true);
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed, refreshStatus]);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const queuedJobs = (status?.index.pending || 0) + (status?.index.processing || 0);
  useEffect(() => {
    if (queuedJobs <= 0) return;
    const timer = window.setInterval(() => void refreshStatus(true), 5_000);
    return () => window.clearInterval(timer);
  }, [queuedJobs, refreshStatus]);

  const saveSettings = async () => {
    setSaving(true);
    setMessage(null);
    const previousModel = status?.embeddingModel || "";
    try {
      const payload: {
        ai_embedding_url: string;
        ai_embedding_model: string;
        ai_embedding_key?: string;
      } = {
        ai_embedding_url: draft.useChatCredentials ? "" : draft.url.trim(),
        ai_embedding_model: draft.model.trim(),
      };
      if (draft.useChatCredentials) {
        payload.ai_embedding_key = "";
      } else if (draft.key.trim()) {
        payload.ai_embedding_key = draft.key.trim();
      } else if (!draft.keySet) {
        payload.ai_embedding_key = "";
      }

      const updateAISettings = api.updateAISettings as unknown as (
        data: typeof payload,
      ) => Promise<AISettingsResponse>;
      const result = await updateAISettings(payload);
      const nextModel = result.ai_embedding_model || "";
      const nextUrl = result.ai_embedding_url || "";
      const nextKeySet = !!result.ai_embedding_key_set;
      setDraft((current) => ({
        ...current,
        url: nextUrl,
        key: "",
        keySet: nextKeySet,
        model: nextModel,
        useChatCredentials: !nextUrl && !nextKeySet,
      }));
      await refreshStatus(true);
      window.dispatchEvent(new CustomEvent("nowen:ai-settings-changed"));
      setMessage({
        type: !nextModel ? "warning" : previousModel && previousModel !== nextModel ? "warning" : "success",
        text: !nextModel
          ? copy.disabledSaved
          : previousModel && previousModel !== nextModel
            ? copy.modelChanged
            : copy.saved,
      });
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  const rebuildIndex = async () => {
    if (!status?.index.configured) {
      setMessage({ type: "warning", text: copy.notConfigured });
      return;
    }
    if (!window.confirm(copy.rebuildConfirm)) return;
    setRebuilding(true);
    setMessage(null);
    try {
      await rebuildEmbeddingIndex();
      await refreshStatus(true);
      window.dispatchEvent(new CustomEvent("nowen:ai-settings-changed"));
      setMessage({ type: "success", text: copy.rebuildQueued });
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.rebuildFailed });
    } finally {
      setRebuilding(false);
    }
  };

  const index = status?.index;
  const busy = loading || saving || rebuilding;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Database size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{copy.title}</h3>
            <span className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium",
              index?.configured
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
            )}>
              {index?.configured ? copy.enabled : copy.disabled}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">{copy.description}</p>
        </div>
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={statusLoading || busy}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-xs font-medium text-zinc-600 transition hover:border-accent-primary/50 hover:text-accent-primary disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
          title={copy.refresh}
        >
          {statusLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          <span className="hidden sm:inline">{copy.refresh}</span>
        </button>
      </div>

      {loading ? (
        <div className="mt-5 flex min-h-40 items-center justify-center text-zinc-400">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : (
        <>
          <button
            type="button"
            role="switch"
            aria-checked={draft.useChatCredentials}
            onClick={() => setDraft((current) => ({ ...current, useChatCredentials: !current.useChatCredentials }))}
            className="mt-5 flex w-full items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 text-left transition hover:border-accent-primary/30 dark:border-zinc-800 dark:bg-zinc-800/40"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-zinc-500 shadow-sm dark:bg-zinc-900 dark:text-zinc-300">
              <Sparkles size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{copy.reuseTitle}</div>
              <div className="mt-0.5 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">{copy.reuseDescription}</div>
            </div>
            <span className={cn(
              "relative h-6 w-11 shrink-0 rounded-full transition",
              draft.useChatCredentials ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700",
            )}>
              <span className={cn(
                "absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-all",
                draft.useChatCredentials ? "left-6" : "left-1",
              )} />
            </span>
          </button>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <label className="space-y-1.5">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <Server size={12} />{copy.embeddingUrl}
              </span>
              <input
                value={draft.url}
                disabled={draft.useChatCredentials}
                onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                placeholder={copy.urlPlaceholder}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-zinc-400 focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:disabled:bg-zinc-800"
              />
            </label>

            <label className="space-y-1.5">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <KeyRound size={12} />{copy.embeddingKey}
              </span>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={draft.key}
                  disabled={draft.useChatCredentials}
                  onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value }))}
                  placeholder={draft.keySet ? copy.savedKey : copy.keyPlaceholder}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 pr-10 text-sm outline-none transition placeholder:text-zinc-400 focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:disabled:bg-zinc-800"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((value) => !value)}
                  disabled={draft.useChatCredentials}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 disabled:opacity-40 dark:hover:text-zinc-200"
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
          </div>

          <label className="mt-3 block space-y-1.5">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{copy.embeddingModel}</span>
            <input
              value={draft.model}
              onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
              placeholder={copy.modelPlaceholder}
              list="nowen-embedding-model-suggestions"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-zinc-400 focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <datalist id="nowen-embedding-model-suggestions">
              {MODEL_SUGGESTIONS.map((model) => <option key={model} value={model} />)}
            </datalist>
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[10px] text-zinc-400">
              <span>{copy.examples}</span>
              {MODEL_SUGGESTIONS.map((model) => (
                <button
                  key={model}
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, model }))}
                  className="rounded-full border border-zinc-200 px-2 py-1 font-mono text-zinc-500 transition hover:border-accent-primary/40 hover:text-accent-primary dark:border-zinc-700 dark:text-zinc-400"
                >
                  {model}
                </button>
              ))}
            </div>
          </label>

          <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <div className="text-[11px] text-zinc-500">{copy.notes}</div>
              <div className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {index ? `${index.indexedNotes}/${index.totalNotes}` : "—"}
              </div>
            </div>
            <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <div className="text-[11px] text-zinc-500">{copy.attachments}</div>
              <div className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {index ? `${index.indexedAttachments}/${index.totalAttachments}` : "—"}
              </div>
            </div>
            <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <div className="text-[11px] text-zinc-500">{copy.queue}</div>
              <div className="mt-1 text-xs font-medium text-zinc-900 dark:text-zinc-100">
                {index
                  ? `${copy.pending} ${index.pending} · ${copy.processing} ${index.processing} · ${copy.failed} ${index.failed}`
                  : copy.statusLoading}
              </div>
            </div>
            <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <div className="text-[11px] text-zinc-500">{copy.vectorEngine}</div>
              <div className={cn(
                "mt-1 text-xs font-semibold",
                index?.vectorAvailable ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
              )}>
                {index?.vectorAvailable ? copy.ready : copy.unavailable}
                {index?.vectorDimension ? ` · ${index.vectorDimension} ${copy.dimension}` : ""}
              </div>
            </div>
          </div>

          <p className="mt-2 text-[10px] leading-4 text-zinc-400">{copy.backgroundHint}</p>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => void saveSettings()}
              disabled={busy}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-accent-primary px-4 py-2 text-xs font-medium text-white transition hover:bg-accent-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {saving ? copy.saving : copy.save}
            </button>
            <button
              type="button"
              onClick={() => void rebuildIndex()}
              disabled={busy || !index?.configured}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-violet-500/30 px-4 py-2 text-xs font-medium text-violet-600 transition hover:bg-violet-500/5 disabled:opacity-50 dark:text-violet-400"
            >
              {rebuilding ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              {rebuilding ? copy.rebuilding : copy.rebuild}
            </button>

            {message && (
              <span className={cn(
                "inline-flex min-w-0 items-center gap-1.5 text-xs sm:ml-auto",
                message.type === "success"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : message.type === "warning"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-red-500",
              )}>
                {message.type === "success" ? <CheckCircle2 size={13} className="shrink-0" /> : <AlertCircle size={13} className="shrink-0" />}
                <span>{message.text}</span>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
