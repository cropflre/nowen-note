import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Layers3,
  Loader2,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings2,
} from "lucide-react";
import { api, getBaseUrl, getCurrentWorkspace } from "@/lib/api";
import { aiProfiles, type AIProfile } from "@/lib/aiProfiles";
import { getReliableAIStatus, type ReliableStatus } from "@/lib/aiReliable";
import {
  buildEmbeddingSettingsPayload,
  inferEmbeddingCredentialSource,
  type EmbeddingCredentialSource,
} from "@/lib/embeddingProfileSelection";
import { cn } from "@/lib/utils";

interface AISettingsResponse {
  ai_provider: string;
  ai_api_url: string;
  ai_api_key: string;
  ai_api_key_set: boolean;
  ai_model: string;
  ai_embedding_profile_id?: string;
  ai_embedding_url?: string;
  ai_embedding_key?: string;
  ai_embedding_key_set?: boolean;
  ai_embedding_model?: string;
}

interface EmbeddingDraft {
  source: EmbeddingCredentialSource;
  profileId: string;
  url: string;
  key: string;
  keySet: boolean;
  model: string;
}

type EmbeddingMessage = {
  type: "success" | "warning" | "error";
  text: string;
};

const EMPTY_DRAFT: EmbeddingDraft = {
  source: "chat",
  profileId: "",
  url: "",
  key: "",
  keySet: false,
  model: "",
};

const MODEL_SUGGESTIONS = ["text-embedding-3-small", "text-embedding-v3", "bge-m3"];

function getCopy() {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  if (!language.startsWith("zh")) {
    return {
      title: "Vector search (Embedding)",
      description: "Choose where embedding credentials come from, while keeping the embedding model independent from chat models.",
      enabled: "Configured",
      disabled: "Keyword fallback",
      sourceLabel: "Embedding service",
      chatTitle: "Follow current chat",
      chatDescription: "Use the active chat profile URL and key.",
      profileTitle: "Saved AI profile",
      profileDescription: "Fix embedding to one saved profile. Chat profile switches will not affect it.",
      customTitle: "Custom credentials",
      customDescription: "Use a dedicated URL and key that are separate from saved profiles.",
      selectProfile: "Select an AI profile",
      noProfiles: "No saved AI profiles",
      missingProfile: "Deleted profile",
      profileRequired: "Select an AI profile before saving.",
      profileMissingWarning: "The saved AI profile used by Embedding no longer exists. Select another profile or credential source.",
      profileSummary: "Embedding reads this profile's provider, URL and key dynamically. Its chat model is not used.",
      embeddingUrl: "Embedding API URL",
      embeddingKey: "Embedding API key",
      embeddingModel: "Embedding model",
      urlPlaceholder: "For example: https://api.openai.com/v1",
      keyPlaceholder: "Enter a dedicated embedding API key",
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
      configurationChanged: "Settings saved. The embedding service or model changed; rebuild the vector index.",
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
      notConfigured: "Configure a valid embedding service and model before rebuilding the index.",
      statusLoading: "Loading index status…",
      backgroundHint: "Indexing runs in the background. Failed jobs can be retried by rebuilding the index.",
    };
  }
  return {
    title: "向量检索（Embedding）",
    description: "选择 Embedding 服务凭据来源，Embedding 模型继续独立配置，不会误用聊天模型。",
    enabled: "已配置",
    disabled: "关键词降级",
    sourceLabel: "Embedding 服务",
    chatTitle: "跟随当前对话配置",
    chatDescription: "使用当前激活 AI 配置的地址与密钥。",
    profileTitle: "选择已有 AI 配置",
    profileDescription: "固定引用一个已保存 Profile，切换聊天配置不会影响 Embedding。",
    customTitle: "独立自定义配置",
    customDescription: "单独填写 Embedding 地址与密钥，不引用已保存 Profile。",
    selectProfile: "请选择 AI 配置",
    noProfiles: "暂无已保存 AI 配置",
    missingProfile: "配置已删除",
    profileRequired: "请先选择一个 AI 配置再保存。",
    profileMissingWarning: "Embedding 绑定的 AI 配置已被删除，请重新选择 Profile 或切换凭据来源。",
    profileSummary: "Embedding 会动态读取该 Profile 的服务商、地址与密钥，不会使用其中的聊天模型。",
    embeddingUrl: "Embedding API 地址",
    embeddingKey: "Embedding API Key",
    embeddingModel: "Embedding 模型",
    urlPlaceholder: "例如：https://api.openai.com/v1",
    keyPlaceholder: "请输入独立 Embedding API Key",
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
    configurationChanged: "配置已保存。Embedding 服务或模型发生变化，请重建向量索引。",
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
    notConfigured: "请先保存有效的 Embedding 服务和模型，再重建索引。",
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
  const [profiles, setProfiles] = useState<AIProfile[]>([]);
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
      if (!silent) setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      if (!silent) setStatusLoading(false);
    }
  }, [copy.loadFailed]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [settings, profileState] = await Promise.all([
        api.getAISettings() as Promise<AISettingsResponse>,
        aiProfiles.list(),
      ]);
      const source = inferEmbeddingCredentialSource(settings);
      const profileId = settings.ai_embedding_profile_id || "";
      const nextProfiles = profileState.profiles || [];
      setProfiles(nextProfiles);
      setDraft({
        source,
        profileId,
        url: settings.ai_embedding_url || "",
        key: "",
        keySet: !!settings.ai_embedding_key_set,
        model: settings.ai_embedding_model || "",
      });
      if (source === "profile" && profileId && !nextProfiles.some((profile) => profile.id === profileId)) {
        setMessage({ type: "warning", text: copy.profileMissingWarning });
      }
      await refreshStatus(true);
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed, copy.profileMissingWarning, refreshStatus]);

  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => {
    const handleProfilesChanged = () => void loadSettings();
    window.addEventListener("nowen:ai-profiles-changed", handleProfilesChanged);
    return () => window.removeEventListener("nowen:ai-profiles-changed", handleProfilesChanged);
  }, [loadSettings]);

  const queuedJobs = (status?.index.pending || 0) + (status?.index.processing || 0);
  useEffect(() => {
    if (queuedJobs <= 0) return;
    const timer = window.setInterval(() => void refreshStatus(true), 5_000);
    return () => window.clearInterval(timer);
  }, [queuedJobs, refreshStatus]);

  const selectedProfile = profiles.find((profile) => profile.id === draft.profileId) || null;
  const profileMissing = draft.source === "profile" && !!draft.profileId && !selectedProfile;

  const chooseSource = (source: EmbeddingCredentialSource) => {
    setDraft((current) => ({
      ...current,
      source,
      profileId: source === "profile" ? current.profileId || profiles[0]?.id || "" : current.profileId,
    }));
    setMessage(null);
  };

  const saveSettings = async () => {
    if (draft.source === "profile" && !draft.profileId) {
      setMessage({ type: "warning", text: copy.profileRequired });
      return;
    }
    setSaving(true);
    setMessage(null);
    const previousModel = status?.embeddingModel || "";
    const previousSource = status?.embedding?.source || "chat";
    const previousProfileId = status?.embedding?.profileId || "";
    try {
      const payload = buildEmbeddingSettingsPayload(draft);
      const updateAISettings = api.updateAISettings as unknown as (
        data: typeof payload,
      ) => Promise<AISettingsResponse>;
      const result = await updateAISettings(payload);
      const nextSource = inferEmbeddingCredentialSource(result);
      const nextProfileId = result.ai_embedding_profile_id || "";
      const nextModel = result.ai_embedding_model || "";
      setDraft((current) => ({
        ...current,
        source: nextSource,
        profileId: nextProfileId,
        url: result.ai_embedding_url || "",
        key: "",
        keySet: !!result.ai_embedding_key_set,
        model: nextModel,
      }));
      await refreshStatus(true);
      window.dispatchEvent(new CustomEvent("nowen:ai-settings-changed"));
      const changed = previousModel !== nextModel
        || previousSource !== nextSource
        || previousProfileId !== nextProfileId;
      setMessage({
        type: !nextModel || changed ? "warning" : "success",
        text: !nextModel ? copy.disabledSaved : changed ? copy.configurationChanged : copy.saved,
      });
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  const rebuildIndex = async () => {
    if (!status?.index.configured) {
      setMessage({ type: "warning", text: status?.embedding?.error || copy.notConfigured });
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
  const sourceOptions: Array<{
    value: EmbeddingCredentialSource;
    title: string;
    description: string;
    icon: React.ReactNode;
  }> = [
    { value: "chat", title: copy.chatTitle, description: copy.chatDescription, icon: <MessageSquare size={16} /> },
    { value: "profile", title: copy.profileTitle, description: copy.profileDescription, icon: <Layers3 size={16} /> },
    { value: "custom", title: copy.customTitle, description: copy.customDescription, icon: <Settings2 size={16} /> },
  ];

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
          <div className="mt-5 space-y-2">
            <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{copy.sourceLabel}</div>
            <div className="grid gap-2 lg:grid-cols-3">
              {sourceOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseSource(option.value)}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3 text-left transition",
                    draft.source === option.value
                      ? "border-accent-primary bg-accent-primary/5 ring-2 ring-accent-primary/10"
                      : "border-zinc-200 bg-zinc-50/70 hover:border-accent-primary/30 dark:border-zinc-800 dark:bg-zinc-800/40",
                  )}
                >
                  <span className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-zinc-900",
                    draft.source === option.value ? "text-accent-primary" : "text-zinc-500 dark:text-zinc-300",
                  )}>
                    {option.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-zinc-800 dark:text-zinc-100">{option.title}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">{option.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {draft.source === "profile" && (
            <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-800/40">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{copy.profileTitle}</span>
                <select
                  value={draft.profileId}
                  onChange={(event) => setDraft((current) => ({ ...current, profileId: event.target.value }))}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="">{profiles.length ? copy.selectProfile : copy.noProfiles}</option>
                  {profileMissing && <option value={draft.profileId}>{copy.missingProfile} · {draft.profileId}</option>}
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name} · {profile.provider}</option>
                  ))}
                </select>
              </label>
              {selectedProfile ? (
                <div className="mt-2 rounded-lg bg-white px-3 py-2 text-[11px] leading-5 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <div className="font-medium text-zinc-700 dark:text-zinc-200">{selectedProfile.name}</div>
                  <div>{selectedProfile.provider} · {selectedProfile.apiUrl || "—"}</div>
                  <div>{copy.profileSummary}</div>
                </div>
              ) : profileMissing ? (
                <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  <span>{copy.profileMissingWarning}</span>
                </div>
              ) : null}
            </div>
          )}

          {draft.source === "custom" && (
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <label className="space-y-1.5">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  <Server size={12} />{copy.embeddingUrl}
                </span>
                <input
                  value={draft.url}
                  onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                  placeholder={copy.urlPlaceholder}
                  className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-zinc-400 focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900"
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
                    onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value }))}
                    placeholder={draft.keySet ? copy.savedKey : copy.keyPlaceholder}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 pr-10 text-sm outline-none transition placeholder:text-zinc-400 focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((value) => !value)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </label>
            </div>
          )}

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

          {(status?.embedding?.error || profileMissing) && (
            <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{status?.embedding?.error || copy.profileMissingWarning}</span>
            </div>
          )}
          <p className="mt-2 text-[10px] leading-4 text-zinc-400">{copy.backgroundHint}</p>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => void saveSettings()}
              disabled={busy || (draft.source === "profile" && !draft.profileId)}
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
