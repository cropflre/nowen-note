import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Layers3,
  ListFilter,
  Loader2,
  MessageSquare,
  PlugZap,
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
  discoverEmbeddingModels,
  mergeEmbeddingModelOptions,
  testEmbeddingModel,
  type EmbeddingModelOption,
  type EmbeddingTestResult,
} from "@/lib/embeddingModelDiscovery";
import {
  buildEmbeddingSettingsPayload,
  inferEmbeddingCredentialSource,
  type EmbeddingCredentialSource,
} from "@/lib/embeddingProfileSelection";
import { cn } from "@/lib/utils";
import EmbeddingIndexFailureDetails from "@/components/EmbeddingIndexFailureDetails";

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
  ai_embedding_timeout_seconds?: string;
}

interface EmbeddingDraft {
  source: EmbeddingCredentialSource;
  profileId: string;
  url: string;
  key: string;
  keySet: boolean;
  model: string;
  timeoutSeconds: string;
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
  timeoutSeconds: "30",
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
      discoverModels: "Refresh models",
      discoveringModels: "Refreshing…",
      testModel: "Test embedding model",
      testingModel: "Testing…",
      discoveredModels: "Discovered models",
      recommended: "recommended",
      noEmbeddingModels: "No likely embedding models were found. You can still enter a model name manually.",
      modelsFound: (count: number, recommended: number) => `Found ${count} candidate models (${recommended} recommended).`,
      testSucceeded: (dimension: number, durationMs: number) => `Embedding test passed: ${dimension} dimensions · ${durationMs} ms.`,
      modelRequired: "Enter an embedding model before testing.",
      discoverFailed: "Failed to refresh embedding models",
      testFailed: "Embedding model test failed",
      advanced: "Advanced settings",
      indexTimeout: "Index request timeout (seconds)",
      indexTimeoutHint: "30–600 seconds, default 30. Applies to background note and attachment indexing. For a slow local model, try 120 or 300 seconds. Search keeps its 30-second limit; the model test uses 15 seconds. After saving, retry failed jobs below without rebuilding the index.",
      invalidTimeout: "Enter a whole number from 30 to 600 seconds.",
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
      backgroundHint: "Search indexing runs in the background and does not modify note contents.",
      initializing: "Awaiting first index",
      extensionFailure: "Extension load failed",
      initializingHint: "The extension is loaded. The first successful index initializes the vector table; pending jobs may run now.",
      extensionFailureHint: "The sqlite-vec extension failed to load. Check the server logs or native module installation.",
      retried: (count: number) => `Queued ${count} failed jobs without clearing existing vectors.`,
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
    discoverModels: "刷新模型列表",
    discoveringModels: "正在刷新…",
    testModel: "测试 Embedding 模型",
    testingModel: "正在测试…",
    discoveredModels: "发现的模型",
    recommended: "推荐",
    noEmbeddingModels: "未发现疑似 Embedding 模型，仍可手动填写模型名称。",
    modelsFound: (count: number, recommended: number) => `发现 ${count} 个候选模型，其中 ${recommended} 个推荐。`,
    testSucceeded: (dimension: number, durationMs: number) => `Embedding 测试成功：${dimension} 维 · ${durationMs} 毫秒。`,
    modelRequired: "请先填写要测试的 Embedding 模型。",
    discoverFailed: "刷新 Embedding 模型失败",
    testFailed: "Embedding 模型测试失败",
    advanced: "高级设置",
    indexTimeout: "索引请求超时（秒）",
    indexTimeoutHint: "范围 30～600 秒，默认 30 秒，仅用于笔记和附件的后台索引。本地模型较慢时可设为 120 或 300 秒。在线搜索仍限时 30 秒，模型测试限时 15 秒。保存后可在下方重试失败任务，无需重建索引。",
    invalidTimeout: "请输入 30～600 秒之间的整数。",
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
    backgroundHint: "后台异步建立搜索索引，不会修改原笔记内容。",
    initializing: "等待首次向量索引",
    extensionFailure: "扩展加载失败",
    initializingHint: "向量扩展已加载，首个索引成功后会自动建立向量表；后台任务可以继续处理。",
    extensionFailureHint: "sqlite-vec 扩展加载失败，请检查服务端日志或原生模块安装，不是 Embedding API 的问题。",
    retried: (count: number) => `已重新入队 ${count} 个失败任务，已有向量索引保持不变。`,
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

export default function EmbeddingSettingsPanel({ showIndexControls = true }: { showIndexControls?: boolean } = {}) {
  const copy = useMemo(getCopy, []);
  const [draft, setDraft] = useState<EmbeddingDraft>(EMPTY_DRAFT);
  const [profiles, setProfiles] = useState<AIProfile[]>([]);
  const [status, setStatus] = useState<ReliableStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<EmbeddingModelOption[]>([]);
  const [testResult, setTestResult] = useState<EmbeddingTestResult | null>(null);
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
        timeoutSeconds: settings.ai_embedding_timeout_seconds || "30",
      });
      setDiscoveredModels([]);
      setTestResult(null);
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
    if (!showIndexControls || queuedJobs <= 0) return;
    const timer = window.setInterval(() => void refreshStatus(true), 5_000);
    return () => window.clearInterval(timer);
  }, [queuedJobs, refreshStatus, showIndexControls]);

  const selectedProfile = profiles.find((profile) => profile.id === draft.profileId) || null;
  const profileMissing = draft.source === "profile" && !!draft.profileId && !selectedProfile;
  const modelOptions = useMemo(
    () => mergeEmbeddingModelOptions(MODEL_SUGGESTIONS, discoveredModels),
    [discoveredModels],
  );

  const clearProbeState = () => {
    setDiscoveredModels([]);
    setTestResult(null);
  };

  const chooseSource = (source: EmbeddingCredentialSource) => {
    setDraft((current) => ({
      ...current,
      source,
      profileId: source === "profile" ? current.profileId || profiles[0]?.id || "" : current.profileId,
    }));
    clearProbeState();
    setMessage(null);
  };

  const refreshModels = async () => {
    if (draft.source === "profile" && !draft.profileId) {
      setMessage({ type: "warning", text: copy.profileRequired });
      return;
    }
    setDiscovering(true);
    setMessage(null);
    setTestResult(null);
    try {
      const result = await discoverEmbeddingModels(draft);
      setDiscoveredModels(result.models);
      const recommendedCount = result.models.filter((model) => model.recommended).length;
      setMessage({
        type: result.models.length > 0 ? "success" : "warning",
        text: result.models.length > 0
          ? copy.modelsFound(result.models.length, recommendedCount)
          : copy.noEmbeddingModels,
      });
    } catch (error) {
      setDiscoveredModels([]);
      setMessage({ type: "error", text: (error as Error)?.message || copy.discoverFailed });
    } finally {
      setDiscovering(false);
    }
  };

  const runEmbeddingTest = async () => {
    if (draft.source === "profile" && !draft.profileId) {
      setMessage({ type: "warning", text: copy.profileRequired });
      return;
    }
    if (!draft.model.trim()) {
      setMessage({ type: "warning", text: copy.modelRequired });
      return;
    }
    setTesting(true);
    setMessage(null);
    setTestResult(null);
    try {
      const result = await testEmbeddingModel(draft);
      setTestResult(result);
      setMessage({ type: "success", text: copy.testSucceeded(result.dimension, result.durationMs) });
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.testFailed });
    } finally {
      setTesting(false);
    }
  };

  const saveSettings = async () => {
    const timeoutSeconds = Number(draft.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 600) {
      setMessage({ type: "warning", text: copy.invalidTimeout });
      return;
    }
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
        timeoutSeconds: result.ai_embedding_timeout_seconds || "30",
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
  const vectorState = index?.vectorState || (index?.vectorAvailable ? "ready" : "unavailable");
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
    <section className="rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm sm:p-6">
      <div className="flex flex-wrap items-start gap-3.5">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.45 }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/20 via-indigo-400/18 to-blue-500/20 text-violet-600 shadow-xs ring-1 ring-violet-500/25 dark:text-violet-300"
        >
          <Database size={20} />
        </motion.span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-tx-primary">{copy.title}</h3>
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
              index?.configured
                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                : "bg-amber-500/12 text-amber-700 dark:text-amber-300",
            )}>
              <span className={cn("h-1.5 w-1.5 rounded-full", index?.configured ? "bg-emerald-500" : "bg-amber-500")} />
              {index?.configured ? copy.enabled : copy.disabled}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-tx-secondary">{copy.description}</p>
        </div>
        {showIndexControls && <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={statusLoading || busy}
          className="inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3 text-xs font-semibold text-tx-secondary transition-all hover:-translate-y-0.5 hover:border-violet-400/50 hover:text-violet-600 disabled:translate-y-0 disabled:opacity-50 dark:hover:text-violet-300"
          title={copy.refresh}
        >
          {statusLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          <span className="hidden sm:inline">{copy.refresh}</span>
        </button>}
      </div>

      {loading ? (
        <div className="mt-5 flex min-h-40 items-center justify-center text-tx-tertiary">
          <Loader2 size={20} className="animate-spin text-violet-500" />
        </div>
      ) : (
        <>
          <div className="mt-5 space-y-2.5">
            <div className="text-xs font-semibold text-tx-secondary">{copy.sourceLabel}</div>
            <div className="grid gap-2.5 lg:grid-cols-3">
              {sourceOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseSource(option.value)}
                  className={cn(
                    "group flex items-start gap-3 rounded-2xl border p-3.5 text-left transition-all",
                    draft.source === option.value
                      ? "border-violet-400/60 bg-gradient-to-br from-violet-500/[0.09] via-app-elevated to-indigo-500/[0.08] shadow-xs ring-2 ring-violet-500/15"
                      : "border-app-border/75 bg-app-surface/65 hover:-translate-y-0.5 hover:border-violet-400/35 hover:bg-app-elevated",
                  )}
                >
                  <span className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-xs transition-transform group-hover:scale-105",
                    draft.source === option.value
                      ? "bg-gradient-to-br from-violet-500/20 to-indigo-500/20 text-violet-600 ring-1 ring-violet-500/25 dark:text-violet-300"
                      : "bg-app-elevated text-tx-secondary",
                  )}>
                    {option.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-bold text-tx-primary">{option.title}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-tx-secondary">{option.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {draft.source === "profile" && (
            <div className="mt-4 rounded-2xl border border-app-border/80 bg-app-surface/65 p-3.5">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-tx-secondary">{copy.profileTitle}</span>
                <select
                  value={draft.profileId}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, profileId: event.target.value }));
                    clearProbeState();
                    setMessage(null);
                  }}
                  className="w-full rounded-xl border border-app-border/80 bg-app-elevated px-3.5 py-2.5 text-sm text-tx-primary outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15"
                >
                  <option value="">{profiles.length ? copy.selectProfile : copy.noProfiles}</option>
                  {profileMissing && <option value={draft.profileId}>{copy.missingProfile} · {draft.profileId}</option>}
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name} · {profile.provider}</option>
                  ))}
                </select>
              </label>
              {selectedProfile ? (
                <div className="mt-2.5 rounded-xl border border-app-border/60 bg-app-elevated/85 px-3.5 py-2.5 text-[11px] leading-5 text-tx-secondary">
                  <div className="font-semibold text-tx-primary">{selectedProfile.name}</div>
                  <div>{selectedProfile.provider} · {selectedProfile.apiUrl || "—"}</div>
                  <div className="text-tx-tertiary">{copy.profileSummary}</div>
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
            <div className="mt-4 grid gap-3.5 lg:grid-cols-2">
              <label className="space-y-1.5">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-tx-secondary">
                  <Server size={12} className="text-violet-500" />{copy.embeddingUrl}
                </span>
                <input
                  value={draft.url}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, url: event.target.value }));
                    clearProbeState();
                  }}
                  placeholder={copy.urlPlaceholder}
                  className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2.5 text-sm text-tx-primary outline-none transition placeholder:text-tx-tertiary focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15"
                />
              </label>

              <label className="space-y-1.5">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-tx-secondary">
                  <KeyRound size={12} className="text-violet-500" />{copy.embeddingKey}
                </span>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={draft.key}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, key: event.target.value }));
                      clearProbeState();
                    }}
                    placeholder={draft.keySet ? copy.savedKey : copy.keyPlaceholder}
                    className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2.5 pr-10 text-sm text-tx-primary outline-none transition placeholder:text-tx-tertiary focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((value) => !value)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-tx-tertiary transition-colors hover:text-tx-primary"
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </label>
            </div>
          )}

          <label className="mt-4 block space-y-1.5">
            <span className="text-xs font-semibold text-tx-secondary">{copy.embeddingModel}</span>
            <input
              value={draft.model}
              onChange={(event) => {
                setDraft((current) => ({ ...current, model: event.target.value }));
                setTestResult(null);
              }}
              placeholder={copy.modelPlaceholder}
              list="nowen-embedding-model-suggestions"
              className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2.5 text-sm text-tx-primary outline-none transition placeholder:text-tx-tertiary focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15"
            />
            <datalist id="nowen-embedding-model-suggestions">
              {modelOptions.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </datalist>
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[11px] text-tx-tertiary">
              <span>{copy.examples}</span>
              {MODEL_SUGGESTIONS.map((model) => (
                <button
                  key={model}
                  type="button"
                  onClick={() => {
                    setDraft((current) => ({ ...current, model }));
                    setTestResult(null);
                  }}
                  className="rounded-full border border-app-border/80 bg-app-surface/80 px-2.5 py-0.5 font-mono text-[11px] text-tx-secondary transition-all hover:-translate-y-0.5 hover:border-violet-400/50 hover:text-violet-600 dark:hover:text-violet-300"
                >
                  {model}
                </button>
              ))}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshModels()}
                disabled={discovering || testing || busy || profileMissing}
                className="inline-flex min-h-9 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3.5 py-2 text-xs font-semibold text-tx-primary transition-all hover:-translate-y-0.5 hover:border-violet-400/50 hover:text-violet-600 disabled:translate-y-0 disabled:opacity-50 dark:hover:text-violet-300"
              >
                {discovering ? <Loader2 size={13} className="animate-spin" /> : <ListFilter size={13} />}
                {discovering ? copy.discoveringModels : copy.discoverModels}
              </button>
              <button
                type="button"
                onClick={() => void runEmbeddingTest()}
                disabled={discovering || testing || busy || profileMissing || !draft.model.trim()}
                className="inline-flex min-h-9 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-violet-500/35 bg-violet-500/10 px-3.5 py-2 text-xs font-semibold text-violet-700 transition-all hover:-translate-y-0.5 hover:bg-violet-500/15 disabled:translate-y-0 disabled:opacity-50 dark:text-violet-300"
              >
                {testing ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
                {testing ? copy.testingModel : copy.testModel}
              </button>
              {discoveredModels.length > 0 && (
                <select
                  value=""
                  onChange={(event) => {
                    if (!event.target.value) return;
                    setDraft((current) => ({ ...current, model: event.target.value }));
                    setTestResult(null);
                  }}
                  className="min-h-9 min-w-52 flex-1 rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-xs text-tx-primary outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15"
                >
                  <option value="">{copy.discoveredModels} · {discoveredModels.length}</option>
                  {discoveredModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.recommended ? "★ " + model.name + " · " + copy.recommended : model.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {testResult && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 size={13} />
                <span>{testResult.dimension} {copy.dimension} · {testResult.durationMs} ms · {testResult.provider}</span>
              </div>
            )}
          </label>

          <details className="mt-4 rounded-xl border border-app-border/80 bg-app-surface/55 p-3.5">
            <summary className="cursor-pointer text-xs font-semibold text-tx-secondary hover:text-tx-primary">{copy.advanced}</summary>
            <label className="mt-3 block space-y-1.5">
              <span className="text-xs font-semibold text-tx-secondary">{copy.indexTimeout}</span>
              <input
                type="number"
                min={30}
                max={600}
                step={1}
                value={draft.timeoutSeconds}
                disabled={busy}
                onChange={(event) => setDraft((current) => ({ ...current, timeoutSeconds: event.target.value }))}
                className="block w-32 rounded-xl border border-app-border/80 bg-app-elevated px-3.5 py-2 text-sm text-tx-primary outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15"
              />
              <p className="text-xs leading-5 text-tx-tertiary">{copy.indexTimeoutHint}</p>
            </label>
          </details>

          {showIndexControls && <div className="mt-5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-app-border/70 bg-app-surface/75 p-3.5">
              <div className="text-[11px] font-medium text-tx-tertiary">{copy.notes}</div>
              <div className="mt-1 text-base font-bold tabular-nums text-tx-primary">
                {index ? `${index.indexedNotes}/${index.totalNotes}` : "—"}
              </div>
            </div>
            <div className="rounded-xl border border-app-border/70 bg-app-surface/75 p-3.5">
              <div className="text-[11px] font-medium text-tx-tertiary">{copy.attachments}</div>
              <div className="mt-1 text-base font-bold tabular-nums text-tx-primary">
                {index ? `${index.indexedAttachments}/${index.totalAttachments}` : "—"}
              </div>
            </div>
            <div className="rounded-xl border border-app-border/70 bg-app-surface/75 p-3.5">
              <div className="text-[11px] font-medium text-tx-tertiary">{copy.queue}</div>
              <div className="mt-1.5 text-xs font-semibold tabular-nums text-tx-primary">
                {index
                  ? `${copy.pending} ${index.pending} · ${copy.processing} ${index.processing} · ${copy.failed} ${index.failed}`
                  : copy.statusLoading}
              </div>
            </div>
            <div className="rounded-xl border border-app-border/70 bg-app-surface/75 p-3.5">
              <div className="text-[11px] font-medium text-tx-tertiary">{copy.vectorEngine}</div>
              <div className={cn(
                "mt-1.5 text-xs font-bold",
                vectorState === "ready" ? "text-emerald-600 dark:text-emerald-400" : vectorState === "unavailable" ? "text-rose-600 dark:text-rose-400" : "text-blue-600 dark:text-blue-400",
              )}>
                {vectorState === "ready" ? copy.ready : vectorState === "initializing" ? copy.initializing : copy.extensionFailure}
                {index?.vectorDimension ? ` · ${index.vectorDimension} ${copy.dimension}` : ""}
              </div>
            </div>
          </div>}

          {(status?.embedding?.error || profileMissing) && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{status?.embedding?.error || copy.profileMissingWarning}</span>
            </div>
          )}
          {showIndexControls && index?.configured && vectorState !== "ready" && (
             <p className="mt-2 text-xs leading-5 text-tx-secondary">
               {vectorState === "initializing" ? copy.initializingHint : copy.extensionFailureHint}
             </p>
           )}
           {showIndexControls && <EmbeddingIndexFailureDetails
             failed={index?.failed || 0}
             onRetried={async (count) => {
               await refreshStatus(true);
               setMessage({ type: "success", text: copy.retried(count) });
             }}
           />}
           {showIndexControls && <p className="mt-2 text-[11px] leading-4 text-tx-tertiary">{copy.backgroundHint}</p>}

          <div className="mt-5 flex flex-wrap items-center gap-2.5 border-t border-app-border/70 pt-4">
            <button
              type="button"
              onClick={() => void saveSettings()}
              disabled={busy || (draft.source === "profile" && !draft.profileId)}
              className="inline-flex min-h-9 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-indigo-500/20 transition-all hover:-translate-y-0.5 hover:shadow-md disabled:translate-y-0 disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {saving ? copy.saving : copy.save}
            </button>
            {showIndexControls && <button
              type="button"
              onClick={() => void rebuildIndex()}
              disabled={busy || !index?.configured}
              className="inline-flex min-h-9 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-violet-500/35 bg-violet-500/10 px-4 py-2 text-xs font-semibold text-violet-700 transition-all hover:-translate-y-0.5 hover:bg-violet-500/15 disabled:translate-y-0 disabled:opacity-50 dark:text-violet-300"
            >
              {rebuilding ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              {rebuilding ? copy.rebuilding : copy.rebuild}
            </button>}

            {message && (
              <span className={cn(
                "inline-flex min-w-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium sm:ml-auto",
                message.type === "success"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : message.type === "warning"
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "bg-rose-500/10 text-rose-600 dark:text-rose-300",
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
