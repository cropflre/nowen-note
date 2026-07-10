import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  aiProfiles,
  emitAIProfilesChanged,
  type AIModelOption,
  type AIProfile,
  type AIProfileDraft,
} from "@/lib/aiProfiles";

interface ProviderPreset {
  id: string;
  name: string;
  desc: string;
  url: string;
  defaultModel: string;
  needsKey: boolean;
  color: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "qwen", name: "通义千问", desc: "DashScope OpenAI 兼容接口", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", needsKey: true, color: "from-violet-500 to-blue-500" },
  { id: "openai", name: "OpenAI", desc: "OpenAI 官方接口", url: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", needsKey: true, color: "from-emerald-500 to-teal-500" },
  { id: "gemini", name: "Google Gemini", desc: "Gemini OpenAI 兼容接口", url: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.0-flash", needsKey: true, color: "from-blue-500 to-cyan-500" },
  { id: "deepseek", name: "DeepSeek", desc: "DeepSeek 官方接口", url: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", needsKey: true, color: "from-sky-500 to-indigo-500" },
  { id: "doubao", name: "豆包（火山引擎）", desc: "火山方舟 OpenAI 兼容接口", url: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "doubao-1.5-pro-32k", needsKey: true, color: "from-orange-500 to-pink-500" },
  { id: "ollama", name: "Ollama", desc: "本地或局域网模型", url: "http://localhost:11434/v1", defaultModel: "qwen2.5:7b", needsKey: false, color: "from-zinc-500 to-zinc-700" },
  { id: "custom", name: "自定义 API", desc: "任意 OpenAI 兼容服务", url: "", defaultModel: "", needsKey: true, color: "from-purple-500 to-indigo-500" },
];

const EMPTY_DRAFT: AIProfileDraft = {
  name: "",
  provider: "openai",
  apiUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
};

function getCopy() {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  if (!language.startsWith("zh")) {
    return {
      title: "AI service profiles",
      description: "Save multiple providers and switch them directly in AI Chat.",
      profiles: "Saved profiles",
      newProfile: "New profile",
      profileName: "Profile name",
      provider: "Provider",
      apiUrl: "API URL",
      apiKey: "API key",
      model: "Model",
      active: "Active",
      activate: "Use this profile",
      save: "Save profile",
      test: "Save & test",
      delete: "Delete",
      autoModels: "Models are fetched automatically after the URL and key are ready.",
      fetching: "Fetching models…",
      fetchModels: "Refresh models",
      noModels: "No model list returned. You can still enter a model manually.",
      saved: "Profile saved",
      activated: "Profile activated",
      testSuccess: "Connection succeeded",
      deleteConfirm: "Delete this AI profile?",
      atLeastOne: "At least one profile must remain.",
      loadFailed: "Failed to load AI profiles",
      nameRequired: "Enter a profile name",
      keyConfigured: "Saved key",
      customModel: "Enter model name",
    };
  }
  return {
    title: "AI 服务配置",
    description: "保存多个 AI 服务，并可在 AI 问答标题栏直接切换。",
    profiles: "已保存配置",
    newProfile: "新建配置",
    profileName: "配置名称",
    provider: "服务商",
    apiUrl: "API 地址",
    apiKey: "API Key",
    model: "模型",
    active: "当前使用",
    activate: "设为当前配置",
    save: "保存配置",
    test: "保存并测试",
    delete: "删除",
    autoModels: "API 地址和密钥就绪后会自动获取模型列表。",
    fetching: "正在获取模型…",
    fetchModels: "刷新模型",
    noModels: "接口没有返回模型列表，仍可手动填写模型名称。",
    saved: "配置已保存",
    activated: "已切换当前配置",
    testSuccess: "连接成功",
    deleteConfirm: "确定删除这个 AI 配置吗？",
    atLeastOne: "至少需要保留一个配置。",
    loadFailed: "AI 配置加载失败",
    nameRequired: "请输入配置名称",
    keyConfigured: "已保存密钥",
    customModel: "手动输入模型名称",
  };
}

function profileToDraft(profile: AIProfile): AIProfileDraft {
  return {
    name: profile.name,
    provider: profile.provider,
    apiUrl: profile.apiUrl,
    apiKey: profile.apiKey,
    model: profile.model,
  };
}

export default function AISettingsPanel() {
  const copy = useMemo(getCopy, []);
  const [profiles, setProfiles] = useState<AIProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AIProfileDraft>(EMPTY_DRAFT);
  const [models, setModels] = useState<AIModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [activating, setActivating] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [modelError, setModelError] = useState("");
  const discoverySeq = useRef(0);

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) || null;
  const preset = PROVIDER_PRESETS.find((item) => item.id === draft.provider) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
  const needsKey = preset.needsKey;

  const loadProfiles = useCallback(async (preferredId?: string) => {
    setLoading(true);
    try {
      const result = await aiProfiles.list();
      setProfiles(result.profiles);
      setActiveProfileId(result.activeProfileId);
      const target = result.profiles.find((item) => item.id === preferredId)
        || result.profiles.find((item) => item.id === result.activeProfileId)
        || result.profiles[0];
      if (target) {
        setSelectedId(target.id);
        setDraft(profileToDraft(target));
      }
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed]);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  const discoverModels = useCallback(async (silent = false) => {
    const seq = ++discoverySeq.current;
    if (!draft.apiUrl.trim()) {
      setModels([]);
      setModelError("");
      return;
    }
    if (needsKey && !draft.apiKey.trim() && !selectedProfile?.apiKeySet) {
      setModels([]);
      setModelError("");
      return;
    }

    setLoadingModels(true);
    if (!silent) setModelError("");
    try {
      const result = await aiProfiles.discoverModels(draft, selectedId || undefined);
      if (seq !== discoverySeq.current) return;
      setModels(result.models);
      setModelError(result.models.length === 0 ? copy.noModels : "");
      if (result.models.length > 0 && !draft.model) {
        setDraft((current) => ({ ...current, model: result.models[0].id }));
      }
    } catch (error) {
      if (seq !== discoverySeq.current) return;
      setModels([]);
      setModelError((error as Error)?.message || copy.noModels);
    } finally {
      if (seq === discoverySeq.current) setLoadingModels(false);
    }
  }, [copy.noModels, draft, needsKey, selectedId, selectedProfile?.apiKeySet]);

  useEffect(() => {
    const timer = window.setTimeout(() => void discoverModels(true), 700);
    return () => window.clearTimeout(timer);
  }, [draft.provider, draft.apiUrl, draft.apiKey, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectProfile = (profile: AIProfile) => {
    setSelectedId(profile.id);
    setDraft(profileToDraft(profile));
    setModels([]);
    setModelError("");
    setMessage(null);
    setModelOpen(false);
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft({ ...EMPTY_DRAFT, name: profiles.length ? `AI ${profiles.length + 1}` : "默认配置" });
    setModels([]);
    setModelError("");
    setMessage(null);
  };

  const changeProvider = (providerId: string) => {
    const next = PROVIDER_PRESETS.find((item) => item.id === providerId);
    if (!next) return;
    setDraft((current) => ({
      ...current,
      provider: providerId,
      apiUrl: next.url,
      apiKey: "",
      model: next.defaultModel,
    }));
    setModels([]);
    setModelError("");
  };

  const persistDraft = useCallback(async (activateNew = true) => {
    if (!draft.name.trim()) throw new Error(copy.nameRequired);
    return selectedId
      ? aiProfiles.update(selectedId, draft)
      : aiProfiles.create(draft, activateNew);
  }, [copy.nameRequired, draft, selectedId]);

  const saveProfile = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await persistDraft(true);
      await loadProfiles(result.profile.id);
      emitAIProfilesChanged(result.activeProfileId);
      setMessage({ type: "success", text: copy.saved });
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const saved = await persistDraft(true);
      let nextActiveId = saved.activeProfileId;
      if (saved.profile.id !== saved.activeProfileId) {
        const activated = await aiProfiles.activate(saved.profile.id);
        nextActiveId = activated.activeProfileId;
      }
      const result = await api.testAIConnection();
      await loadProfiles(saved.profile.id);
      emitAIProfilesChanged(nextActiveId);
      setMessage({
        type: result.success ? "success" : "error",
        text: result.message || result.error || (result.success ? copy.testSuccess : copy.loadFailed),
      });
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setTesting(false);
    }
  };

  const activateProfile = async () => {
    if (!selectedId || selectedId === activeProfileId) return;
    setActivating(true);
    setMessage(null);
    try {
      const result = await aiProfiles.activate(selectedId);
      setActiveProfileId(result.activeProfileId);
      emitAIProfilesChanged(result.activeProfileId);
      setMessage({ type: "success", text: copy.activated });
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setActivating(false);
    }
  };

  const deleteProfile = async () => {
    if (!selectedId) return;
    if (profiles.length <= 1) {
      setMessage({ type: "error", text: copy.atLeastOne });
      return;
    }
    if (!window.confirm(copy.deleteConfirm)) return;
    setSaving(true);
    try {
      const result = await aiProfiles.remove(selectedId);
      await loadProfiles(result.activeProfileId);
      emitAIProfilesChanged(result.activeProfileId);
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex min-h-[320px] items-center justify-center text-zinc-400"><Loader2 className="animate-spin" size={22} /></div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm">
          <Bot size={18} />
        </div>
        <div>
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{copy.title}</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{copy.description}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-2 dark:border-zinc-800 dark:bg-zinc-900/30">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{copy.profiles}</span>
            <button type="button" onClick={startNew} className="rounded-md p-1.5 text-zinc-500 hover:bg-white hover:text-accent-primary dark:hover:bg-zinc-800" title={copy.newProfile}>
              <Plus size={14} />
            </button>
          </div>
          <div className="max-h-[430px] space-y-1 overflow-auto">
            {profiles.map((profile) => {
              const active = profile.id === activeProfileId;
              const selected = profile.id === selectedId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => selectProfile(profile)}
                  className={cn(
                    "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-accent-primary/50 bg-white shadow-sm dark:bg-zinc-900"
                      : "border-transparent hover:bg-white dark:hover:bg-zinc-800/70",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{profile.name}</span>
                    {active && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />}
                  </div>
                  <div className="mt-1 truncate text-[10px] text-zinc-400">{profile.model || profile.provider}</div>
                </button>
              );
            })}
            {selectedId === null && (
              <div className="rounded-lg border border-dashed border-accent-primary/50 bg-accent-primary/5 px-3 py-2.5 text-sm font-medium text-accent-primary">
                {copy.newProfile}
              </div>
            )}
          </div>
        </aside>

        <section className="space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{copy.profileName}</span>
              <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{copy.provider}</span>
              <div className="relative">
                <select value={draft.provider} onChange={(event) => changeProvider(event.target.value)} className="w-full appearance-none rounded-lg border border-zinc-200 bg-white px-3 py-2 pr-8 text-sm outline-none focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900">
                  {PROVIDER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
              </div>
            </label>
          </div>

          <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/40">
            <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br text-white", preset.color)}><Zap size={13} /></div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{preset.name}</div>
              <div className="truncate text-[10px] text-zinc-400">{preset.desc}</div>
            </div>
            {selectedId === activeProfileId && selectedId !== null && (
              <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">{copy.active}</span>
            )}
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{copy.apiUrl}</span>
            <input value={draft.apiUrl} onChange={(event) => setDraft((current) => ({ ...current, apiUrl: event.target.value }))} placeholder="https://api.example.com/v1" className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900" />
          </label>

          {needsKey && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{copy.apiKey}</span>
              <div className="relative">
                <input type={showKey ? "text" : "password"} value={draft.apiKey} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} placeholder={selectedProfile?.apiKeySet ? copy.keyConfigured : "sk-..."} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 pr-10 text-sm outline-none focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900" />
                <button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{copy.model}</span>
              <button type="button" onClick={() => void discoverModels(false)} disabled={loadingModels || !draft.apiUrl} className="inline-flex items-center gap-1 text-[10px] text-accent-primary disabled:opacity-40">
                {loadingModels ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                {copy.fetchModels}
              </button>
            </div>
            <div className="relative">
              <input value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} onFocus={() => models.length > 0 && setModelOpen(true)} placeholder={preset.defaultModel || copy.customModel} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 pr-9 text-sm outline-none focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700 dark:bg-zinc-900" />
              {models.length > 0 && <button type="button" onClick={() => setModelOpen((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400"><ChevronDown size={14} /></button>}
              {modelOpen && models.length > 0 && (
                <>
                  <button type="button" aria-label="close" className="fixed inset-0 z-40 cursor-default" onClick={() => setModelOpen(false)} />
                  <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                    {models.map((model) => (
                      <button key={model.id} type="button" onClick={() => { setDraft((current) => ({ ...current, model: model.id })); setModelOpen(false); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-700 hover:bg-accent-primary/5 hover:text-accent-primary dark:text-zinc-200">
                        <span className="truncate">{model.name}</span>
                        {draft.model === model.id && <Check size={13} className="shrink-0" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="min-h-4 text-[10px]">
              {loadingModels ? <span className="text-zinc-400">{copy.fetching}</span>
                : modelError ? <span className="text-amber-600 dark:text-amber-400">{modelError}</span>
                : <span className="text-zinc-400">{copy.autoModels}</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <button type="button" onClick={() => void saveProfile()} disabled={saving || testing} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-primary/90 disabled:opacity-50">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {copy.save}
            </button>
            <button type="button" onClick={() => void testConnection()} disabled={testing || saving || !draft.apiUrl} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-4 py-2 text-xs font-medium text-zinc-700 hover:border-accent-primary/50 hover:text-accent-primary disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
              {testing ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}
              {copy.test}
            </button>
            {selectedId && selectedId !== activeProfileId && (
              <button type="button" onClick={() => void activateProfile()} disabled={activating || testing} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-4 py-2 text-xs font-medium text-emerald-600 hover:bg-emerald-500/5 disabled:opacity-50 dark:text-emerald-400">
                {activating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                {copy.activate}
              </button>
            )}
            {selectedId && (
              <button type="button" onClick={() => void deleteProfile()} disabled={saving || testing} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-500 hover:bg-red-500/5 disabled:opacity-50">
                <Trash2 size={13} />
                {copy.delete}
              </button>
            )}
            {message && (
              <span className={cn("ml-auto inline-flex items-center gap-1 text-xs", message.type === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500")}>
                {message.type === "success" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                {message.text}
              </span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
