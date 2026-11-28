import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Share2,
  Sparkles,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getNonChatModelKind } from "@/lib/chatModelType";
import { rememberAIProfileConnection, useAIConnectionAvailable } from "@/lib/aiConnection";
import PluginPromptPackSettingsSection from "@/components/settings/PluginPromptPackSettingsSection";
import SpeechSettingsPanel from "@/components/SpeechSettingsPanel";
import {
  aiProfiles,
  emitAIProfilesChanged,
  type AIModelOption,
  type AIProfile,
  type AIProfileDraft,
  type AIProxyStatus,
  getAIProfilesScope,
  type AvailableAIProfiles,
  type ManagedSharedAIProfile,
  type AIProfileMember,
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
  { id: "anthropic", name: "Anthropic", desc: "Anthropic Messages 原生接口", url: "https://api.anthropic.com/v1", defaultModel: "", needsKey: true, color: "from-orange-500 to-amber-500" },
  { id: "gemini", name: "Google Gemini", desc: "Gemini OpenAI 兼容接口", url: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.0-flash", needsKey: true, color: "from-blue-500 to-cyan-500" },
  { id: "deepseek", name: "DeepSeek", desc: "DeepSeek 官方接口", url: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", needsKey: true, color: "from-sky-500 to-indigo-500" },
  { id: "doubao", name: "豆包（火山引擎）", desc: "火山方舟 OpenAI 兼容接口", url: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "doubao-1.5-pro-32k", needsKey: true, color: "from-orange-500 to-pink-500" },
  { id: "lmstudio", name: "LM Studio", desc: "本地或局域网 OpenAI 兼容服务", url: "http://127.0.0.1:1234/v1", defaultModel: "", needsKey: false, color: "from-cyan-500 to-blue-600" },
  { id: "ollama", name: "Ollama", desc: "本地或局域网模型", url: "http://localhost:11434/v1", defaultModel: "qwen2.5:7b", needsKey: false, color: "from-zinc-500 to-zinc-700" },
  { id: "custom", name: "自定义 API", desc: "任意 OpenAI 兼容服务", url: "", defaultModel: "", needsKey: true, color: "from-purple-500 to-indigo-500" },
];

const EMPTY_DRAFT: AIProfileDraft = {
  name: "",
  provider: "openai",
  apiUrl: "https://api.openai.com/v1",
  apiKey: "",
  customHeaders: {},
  model: "gpt-4o-mini",
};

function getCopy() {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  if (!language.startsWith("zh")) {
    return {
      managementHint: "Manage shared profiles on the current server here. In desktop local mode, manage team profiles through the team server website.",
      disabledMember: "Disabled", personal: "Personal profiles", shared: "Shared profiles", manageShared: "Manage shared profiles", publish: "Publish as shared profile", provided: "Provided by administrator", unavailable: "The selected shared profile is unavailable. Choose another profile.", sharedHint: "Shared chat credentials stay on the server. Vector search requires its own configuration.", enabled: "Allow shared use", members: "Members allowed to use this profile", noShared: "No shared profiles are available to you.", noMembers: "No members available", sharedTest: "Save & test shared profile", sharedDelete: "Delete this shared profile and revoke all access?", publishHint: "Published as an independent shared profile. Select members and save to grant access.", unsupported: "This server does not support shared AI profiles.",
      title: "AI service profiles",
      description: "Save multiple providers and switch them directly in AI Chat.",
      profiles: "Saved profiles",
      newProfile: "New profile",
      profileName: "Profile name",
      provider: "Provider",
      apiUrl: "API URL",
      apiKey: "API key",
      advancedHeaders: "Advanced: custom request headers",
      headerName: "Header name",
      headerValue: "Header value",
      addHeader: "Add header",
      removeHeader: "Remove header",
      duplicateHeader: "Header names must be unique (case-insensitive).",
      headerHint: "Saved values are hidden. Re-enter the value when renaming a header. Custom authentication headers can replace the API key.",
      apiUrlHint: "Enter the base URL including /v1 if required. The chat endpoint is appended automatically; Gemini uses the OpenAI-compatible API.",
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
      onlyNonChatModels: "Only embedding/reranking models were found. Configure embedding models under Vector search below.",
      saved: "Profile saved",
      activated: "Profile activated",
      testSuccess: "Connection succeeded",
      deleteConfirm: "Delete this AI profile?",
      atLeastOne: "At least one profile must remain.",
      loadFailed: "Failed to load AI profiles",
      nameRequired: "Enter a profile name",
      keyConfigured: "Saved key",
      customModel: "Enter model name",
      embeddingHint: "This is an embedding model, not a chat model. Configure and test it under Vector search (Embedding) below.",
      rerankHint: "This is a reranking model and cannot be used for AI chat. Choose a chat model.",
      goToEmbedding: "Go to Embedding settings",
    };
  }
  return {
    managementHint: "此处管理当前服务器的共享配置。桌面本地模式下，团队配置请通过团队服务器网页管理。",
    disabledMember: "已停用", personal: "个人配置", shared: "共享配置", manageShared: "管理共享配置", publish: "发布为共享配置", provided: "管理员提供", unavailable: "当前共享配置不可用，请重新选择模型。", sharedHint: "共享聊天凭据仅保留在服务器；向量检索仍需独立配置。", enabled: "允许共享使用", members: "允许使用的成员", noShared: "暂无可使用的共享配置。", noMembers: "暂无成员", sharedTest: "保存并测试共享配置", sharedDelete: "确定删除共享配置并撤销所有成员的使用权限吗？", publishHint: "已发布为独立共享配置，请选择成员并保存授权。", unsupported: "当前服务器不支持共享 AI 配置。",
    title: "AI 服务配置",
    description: "保存多个 AI 服务，并可在 AI 问答标题栏直接切换。",
    profiles: "已保存配置",
    newProfile: "新建配置",
    profileName: "配置名称",
    provider: "服务商",
    apiUrl: "API 地址",
    apiKey: "API Key",
    advancedHeaders: "高级：自定义请求头",
    headerName: "请求头名称",
    headerValue: "请求头值",
    addHeader: "添加请求头",
    removeHeader: "移除请求头",
    duplicateHeader: "请求头名称不能重复（不区分大小写）。",
    headerHint: "已保存的值会隐藏；重命名请求头后请重新输入值。使用自定义鉴权头时，API Key 可留空。",
    apiUrlHint: "填写基础地址，按服务要求包含 /v1，系统会自动追加聊天路径。Gemini 使用 OpenAI 兼容接口。",
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
    onlyNonChatModels: "仅发现向量或重排序模型；向量模型请到下方「向量检索」配置。",
    saved: "配置已保存",
    activated: "已切换当前配置",
    testSuccess: "连接成功",
    deleteConfirm: "确定删除这个 AI 配置吗？",
    atLeastOne: "至少需要保留一个配置。",
    loadFailed: "AI 配置加载失败",
    nameRequired: "请输入配置名称",
    keyConfigured: "已保存密钥",
    customModel: "手动输入模型名称",
    embeddingHint: "这是向量模型，不支持 AI 对话。请在下方「向量检索（Embedding）」中配置并测试。",
    rerankHint: "这是重排序模型，不能用于 AI 对话。请选择聊天模型。",
    goToEmbedding: "前往向量检索配置",
  };
}

function profileToDraft(profile: AIProfile): AIProfileDraft {
  return {
    name: profile.name,
    provider: profile.provider,
    apiUrl: profile.apiUrl,
    apiKey: profile.apiKey,
    customHeaders: profile.customHeaders || {},
    model: profile.model,
  };
}

export default function AISettingsPanel() {
  const copy = useMemo(getCopy, []);
  const aiAvailable = useAIConnectionAvailable();
  const [available, setAvailable] = useState<AvailableAIProfiles | null>(null);
  const [manageShared, setManageShared] = useState(false);
  const [managedProfiles, setManagedProfiles] = useState<ManagedSharedAIProfile[]>([]);
  const [members, setMembers] = useState<AIProfileMember[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [sharedEnabled, setSharedEnabled] = useState(true);
  const loadSeq = useRef(0);
  const [profiles, setProfiles] = useState<AIProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AIProfileDraft>(EMPTY_DRAFT);
  const [models, setModels] = useState<AIModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [proxyStatus, setProxyStatus] = useState<AIProxyStatus | null>(null);
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
  const nonChatKind = getNonChatModelKind(draft.model);
  const nonChatHint = nonChatKind === "embedding" ? copy.embeddingHint : nonChatKind === "rerank" ? copy.rerankHint : "";

  const identity = useRef(getAIProfilesScope());
  const preferredSelection = useRef<string | undefined>(undefined);
  const readAvailable = useCallback(() => aiProfiles.available(), []);

  const loadProfiles = useCallback(async (preferredId?: string, shared = manageShared) => {
    preferredId ||= preferredSelection.current;
    const seq = ++loadSeq.current;
    discoverySeq.current++;
    setModels([]); setModelError(""); setModelOpen(false); setLoadingModels(false);
    const scope = getAIProfilesScope();
    setLoading(true);
    try {
      const result = await readAvailable();
      const managed = shared && result.isAdmin ? await aiProfiles.shared.list() : null;
      if (seq !== loadSeq.current || scope !== getAIProfilesScope()) return;
      setAvailable(result);
      if (!result.isAdmin) setManageShared(false);
      if (managed) { setManagedProfiles(managed.profiles); setMembers(managed.members); }
      const rows = managed ? managed.profiles : result.personalProfiles;
      const activeId = result.active.scope === (managed ? "shared" : "personal") ? result.active.id : "";
      setProfiles(rows);
      setActiveProfileId(activeId);
      const target = rows.find((item) => item.id === preferredId) || rows.find((item) => item.id === activeId) || rows[0];
      preferredSelection.current = undefined;
      setSelectedId(target?.id || null);
      setDraft(target ? profileToDraft(target) : { ...EMPTY_DRAFT });
      const sharedTarget = managed?.profiles.find((item) => item.id === target?.id);
      setMemberIds(sharedTarget?.memberIds || []);
      setSharedEnabled(sharedTarget?.enabled ?? true);
    } catch (error) {
      if (seq === loadSeq.current && scope === getAIProfilesScope()) setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [copy.loadFailed, manageShared, readAvailable]);

  useEffect(() => { void loadProfiles(); return () => { loadSeq.current++; }; }, [loadProfiles]);
  useEffect(() => {
    const refresh = () => {
      const scope = getAIProfilesScope();
      void readAvailable().then((result) => {
        if (scope !== getAIProfilesScope()) return;
        setAvailable(result);
        setActiveProfileId(result.active.scope === (manageShared ? "shared" : "personal") ? result.active.id : "");
      }).catch((error: Error) => { if (scope === getAIProfilesScope()) setMessage({ type: "error", text: error.message }); });
    };
    const reset = () => {
      if (identity.current === getAIProfilesScope()) return;
      identity.current = getAIProfilesScope();
      loadSeq.current++;
      discoverySeq.current++;
      setProxyStatus(null); setAvailable(null); setProfiles([]); setManagedProfiles([]); setMembers([]); setMemberIds([]); setDraft({ ...EMPTY_DRAFT }); setSelectedId(null); setActiveProfileId(""); setMessage(null);
      void loadProfiles();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("nowen:ai-profiles-changed", refresh);
    window.addEventListener("nowen:token-changed", reset);
    window.addEventListener("nowen:server-url-changed", reset);
    window.addEventListener("nowen:mobile-local-mode-changed", reset);
    window.addEventListener("storage", reset);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("nowen:ai-profiles-changed", refresh);
      window.removeEventListener("nowen:token-changed", reset);
      window.removeEventListener("nowen:server-url-changed", reset);
      window.removeEventListener("nowen:mobile-local-mode-changed", reset);
      window.removeEventListener("storage", reset);
    };
  }, [loadProfiles, manageShared, readAvailable]);
  useEffect(() => {
    let alive = true;
    void aiProfiles.proxyStatus?.().then((status) => {
      if (alive) setProxyStatus(status);
    }).catch(() => {
      // Older versions may not implement this endpoint yet.
      if (alive) setProxyStatus(null);
    });
    return () => { alive = false; };
  }, []);

  const discoverModels = useCallback(async (silent = false) => {
    const seq = ++discoverySeq.current;
    if (manageShared) return;
    if (!draft.apiUrl.trim()) {
      setModels([]);
      setModelError("");
      return;
    }
    if (needsKey && !draft.apiKey.trim() && !selectedProfile?.apiKeySet && !Object.values(draft.customHeaders || {}).some(Boolean)) {
      setModels([]);
      setModelError("");
      return;
    }

    setLoadingModels(true);
    if (!silent) setModelError("");
    try {
      const result = await aiProfiles.discoverModels(draft, selectedId || undefined);
      if (seq !== discoverySeq.current) return;
      const chatModels = result.models.filter((model) => !getNonChatModelKind(model.id));
      setModels(chatModels);
      setModelError(chatModels.length === 0
        ? (result.filteredNonChatCount ? copy.onlyNonChatModels : copy.noModels)
        : "");
      if (chatModels.length > 0 && !draft.model) {
        setDraft((current) => ({ ...current, model: chatModels[0].id }));
      }
    } catch (error) {
      if (seq !== discoverySeq.current) return;
      setModels([]);
      setModelError((error as Error)?.message || copy.noModels);
    } finally {
      if (seq === discoverySeq.current) setLoadingModels(false);
    }
  }, [copy.noModels, draft, needsKey, selectedId, selectedProfile?.apiKeySet, manageShared]);

  useEffect(() => {
    const timer = window.setTimeout(() => void discoverModels(true), 700);
    return () => window.clearTimeout(timer);
  }, [draft.provider, draft.apiUrl, draft.apiKey, draft.customHeaders, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectProfile = (profile: AIProfile) => {
    setSelectedId(profile.id);
    setDraft(profileToDraft(profile));
    const shared = managedProfiles.find((item) => item.id === profile.id);
    setMemberIds(shared?.memberIds || []);
    setSharedEnabled(shared?.enabled ?? true);
    setModels([]);
    setModelError("");
    setMessage(null);
    setModelOpen(false);
  };

  const startNew = () => {
    setSelectedId(null);
    setMemberIds([]); setSharedEnabled(true);
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
      customHeaders: {},
      model: next.defaultModel,
    }));
    setModels([]);
    setModelError("");
  };

  const updateHeader = (index: number, name: string, value: string) => {
    const entries = Object.entries(draft.customHeaders || {});
    if (entries.some(([key], i) => i !== index && key.trim().toLowerCase() === name.trim().toLowerCase())) {
      setMessage({ type: "error", text: copy.duplicateHeader });
      return;
    }
    entries[index] = [name, value];
    setDraft((current) => ({ ...current, customHeaders: Object.fromEntries(entries) }));
  };

  const persistDraft = useCallback(async (activateNew = true) => {
    if (!draft.name.trim()) throw new Error(copy.nameRequired);
    if (manageShared) {
      const payload = { ...draft, enabled: sharedEnabled, memberIds, revision: managedProfiles.find((item) => item.id === selectedId)?.revision };
      const result = selectedId ? await aiProfiles.shared.update(selectedId, payload) : await aiProfiles.shared.create(payload);
      return { ...result, activeProfileId };
    }
    return selectedId
      ? aiProfiles.update(selectedId, draft)
      : aiProfiles.create(draft, activateNew);
  }, [copy.nameRequired, draft, selectedId, manageShared, sharedEnabled, memberIds, managedProfiles, activeProfileId]);

  const saveProfile = async () => {
    const operationScope = getAIProfilesScope();
    if (nonChatKind) {
      setMessage({ type: "error", text: nonChatHint });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await persistDraft(false);
      if (operationScope !== getAIProfilesScope()) return;
      await loadProfiles(result.profile.id);
      if (operationScope !== getAIProfilesScope()) return;
      emitAIProfilesChanged(result.activeProfileId);
      setMessage({ type: "success", text: copy.saved });
    } catch (error) {
      if (operationScope !== getAIProfilesScope()) return;
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    const operationScope = getAIProfilesScope();
    if (nonChatKind) {
      setMessage({ type: "error", text: nonChatHint });
      return;
    }
    if (!draft.name.trim()) {
      setMessage({ type: "error", text: copy.nameRequired });
      return;
    }
    setTesting(true);
    setMessage(null);
    try {
      if (manageShared) {
        const saved = await persistDraft(false);
        if (operationScope !== getAIProfilesScope()) return;
        const tested = await aiProfiles.shared.test(saved.profile.id).catch((error: Error) => ({ success: false, error: error.message, message: undefined }));
        if (operationScope !== getAIProfilesScope()) return;
        await loadProfiles(saved.profile.id);
        if (operationScope !== getAIProfilesScope()) return;
        if ("enabled" in saved.profile) rememberAIProfileConnection(saved.profile, tested.success);
        emitAIProfilesChanged();
        setMessage({ type: tested.success ? "success" : "error", text: tested.message || tested.error || copy.testSuccess });
        return;
      }
      // Never mutate the active profile on a failed connectivity test.
      const reportFailedActiveTest = () => {
        if (!selectedProfile || selectedProfile.id !== activeProfileId) return;
        const savedHeaders = selectedProfile.customHeaders || {};
        const draftHeaders = Object.entries(draft.customHeaders || {});
        const unchanged = draft.provider === selectedProfile.provider
          && draft.apiUrl.trim().replace(/\/+$/, "") === selectedProfile.apiUrl
          && draft.apiKey === selectedProfile.apiKey
          && draft.model.trim() === selectedProfile.model
          && Object.keys(savedHeaders).length === draftHeaders.length
          && draftHeaders.every(([name, value]) => savedHeaders[name] === value);
        if (!unchanged) return;
        rememberAIProfileConnection(selectedProfile, false);
        emitAIProfilesChanged(selectedProfile.id);
      };
      const tested = await aiProfiles.testDraft(draft, selectedId || undefined).catch((error) => {
        if (operationScope === getAIProfilesScope()) reportFailedActiveTest();
        throw error;
      });
      if (operationScope !== getAIProfilesScope()) return;
      if (!tested.success) {
        reportFailedActiveTest();
        setMessage({ type: "error", text: tested.error || tested.message || copy.loadFailed });
        return;
      }
      const saved = await persistDraft(true);
      if (operationScope !== getAIProfilesScope()) return;
      let nextActiveId = saved.activeProfileId;
      if (saved.profile.id !== saved.activeProfileId) {
        const activated = await aiProfiles.activate(saved.profile.id);
        nextActiveId = activated.activeProfileId;
      }
      if (operationScope !== getAIProfilesScope()) return;
      await loadProfiles(saved.profile.id);
      if (operationScope !== getAIProfilesScope()) return;
      rememberAIProfileConnection(saved.profile, true);
      emitAIProfilesChanged(nextActiveId);
      setMessage({ type: "success", text: tested.message || copy.testSuccess });
    } catch (error) {
      if (operationScope !== getAIProfilesScope()) return;
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setTesting(false);
    }
  };

  const activateProfile = async () => {
    const operationScope = getAIProfilesScope();
    if (!selectedId || selectedId === activeProfileId) return;
    setActivating(true);
    setMessage(null);
    try {
      if (manageShared) {
        await aiProfiles.activateSelection({ scope: "shared", id: selectedId });
        if (operationScope !== getAIProfilesScope()) return;
        await loadProfiles(selectedId);
        if (operationScope !== getAIProfilesScope()) return;
        emitAIProfilesChanged();
      } else {
        const result = await aiProfiles.activate(selectedId);
        if (operationScope !== getAIProfilesScope()) return;
        setActiveProfileId(result.activeProfileId);
        emitAIProfilesChanged(result.activeProfileId);
      }
      setMessage({ type: "success", text: copy.activated });
    } catch (error) {
      if (operationScope !== getAIProfilesScope()) return;
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setActivating(false);
    }
  };

  const deleteProfile = async () => {
    const operationScope = getAIProfilesScope();
    if (!selectedId) return;
    if (!manageShared && profiles.length <= 1) {
      setMessage({ type: "error", text: copy.atLeastOne });
      return;
    }
    if (!window.confirm(manageShared ? copy.sharedDelete : copy.deleteConfirm)) return;
    setSaving(true);
    try {
      if (manageShared) {
        const profile = managedProfiles.find((item) => item.id === selectedId)!;
        await aiProfiles.shared.remove(profile.id, profile.revision);
        if (operationScope !== getAIProfilesScope()) return;
        await loadProfiles();
        if (operationScope !== getAIProfilesScope()) return;
        emitAIProfilesChanged();
      } else {
        const result = await aiProfiles.remove(selectedId);
        if (operationScope !== getAIProfilesScope()) return;
        await loadProfiles(result.activeProfileId);
        if (operationScope !== getAIProfilesScope()) return;
        emitAIProfilesChanged(result.activeProfileId);
      }
    } catch (error) {
      if (operationScope !== getAIProfilesScope()) return;
      setMessage({ type: "error", text: (error as Error)?.message || copy.loadFailed });
    } finally {
      setSaving(false);
    }
  };

  const activateShared = async (id: string) => {
    const operationScope = getAIProfilesScope();
    setActivating(true); setMessage(null);
    try {
      await aiProfiles.activateSelection({ scope: "shared", id });
      if (operationScope !== getAIProfilesScope()) return;
      const result = await readAvailable();
      if (operationScope !== getAIProfilesScope()) return;
      setAvailable(result);
      setActiveProfileId(manageShared ? id : "");
      emitAIProfilesChanged();
    } catch (error) { if (operationScope !== getAIProfilesScope()) return; setMessage({ type: "error", text: (error as Error).message }); }
    finally { setActivating(false); }
  };

  const publishProfile = async () => {
    const operationScope = getAIProfilesScope();
    if (!selectedId) return;
    setSaving(true); setMessage(null);
    try {
      const result = await aiProfiles.shared.create({ sourceProfileId: selectedId, enabled: true, memberIds: [] });
      if (operationScope !== getAIProfilesScope()) return;
      preferredSelection.current = result.profile.id;
      setManageShared(true);
      setMessage({ type: "success", text: copy.publishHint });
    } catch (error) { if (operationScope !== getAIProfilesScope()) return; setMessage({ type: "error", text: (error as Error).message }); }
    finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-app-border/70 bg-app-elevated/60 text-tx-tertiary backdrop-blur-sm">
        <Loader2 className="animate-spin text-violet-500" size={22} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-2xl border border-app-border/80 bg-gradient-to-br from-fuchsia-500/[0.07] via-app-elevated/85 to-violet-500/[0.07] p-5 shadow-xs backdrop-blur-sm">
        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-fuchsia-400/15 blur-2xl" />
        <div className="relative flex flex-wrap items-center gap-3.5">
          <motion.span
            whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
            transition={{ duration: 0.45 }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-fuchsia-500/20 via-violet-400/18 to-indigo-500/20 text-fuchsia-600 shadow-xs ring-1 ring-fuchsia-500/25 dark:text-fuchsia-300"
          >
            <Bot size={20} />
          </motion.span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold tracking-tight text-tx-primary">{copy.title}</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-tx-secondary">{copy.description}</p>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-fuchsia-500/20 bg-fuchsia-500/10 px-3 py-1 text-[11px] font-semibold text-fuchsia-700 dark:text-fuchsia-300">
            <Sparkles size={12} />
            <span>{profiles.length}</span>
          </div>
        </div>
      </div>

      <div
        className="rounded-2xl border border-app-border/80 bg-app-elevated/75 px-4 py-3.5 text-xs shadow-xs backdrop-blur-sm"
        aria-label="AI 网络代理状态"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-sky-500/12 text-sky-600 dark:text-sky-300">
            <Globe size={13} />
          </span>
          <span className="font-semibold text-tx-primary">AI 网络代理</span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
              proxyStatus?.enabled && proxyStatus.valid
                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                : proxyStatus?.enabled && !proxyStatus.valid
                  ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                  : "bg-app-hover/90 text-tx-secondary",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                proxyStatus?.enabled && proxyStatus.valid
                  ? "bg-emerald-500"
                  : proxyStatus?.enabled && !proxyStatus.valid
                    ? "bg-rose-500"
                    : "bg-tx-tertiary",
              )}
            />
            {proxyStatus ? proxyStatus.enabled ? proxyStatus.valid ? "服务端已启用" : "配置无效" : "直连" : "状态未知"}
          </span>
        </div>
        <p className="mt-2 leading-relaxed text-tx-secondary">
          {proxyStatus?.message || "代理由 Nowen Server 管理员通过 NOWEN_AI_PROXY_URL 环境变量配置，设置后需重启服务端。"}
        </p>
        <p className="mt-1 leading-relaxed text-tx-tertiary">
          代理仅影响服务端 AI 请求（包括模型发现、对话及 Embedding），不改变当前设备的连接或笔记同步；本地模型默认直连。
        </p>
      </div>

      {available && (
        <section
          aria-label={copy.shared}
          className="space-y-3 rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm"
        >
          <div className="flex items-start gap-3">
            <motion.span
              whileHover={{ rotate: [0, -10, 10, 0], scale: 1.06 }}
              transition={{ duration: 0.4 }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/18 to-indigo-500/18 text-violet-600 ring-1 ring-violet-500/20 dark:text-violet-300"
            >
              <Share2 size={16} />
            </motion.span>
            <div className="min-w-0">
              <h4 className="text-sm font-bold text-tx-primary">{copy.shared}</h4>
              <p className="mt-0.5 text-xs leading-relaxed text-tx-secondary">{copy.sharedHint}</p>
            </div>
          </div>
          {available.remoteError && (
            <p role="alert" className="rounded-xl border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
              {available.remoteError}
            </p>
          )}
          {available.unavailable && (
            <p role="alert" className="rounded-xl border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
              {copy.unavailable}
            </p>
          )}
          {!available.sharedSupported && <p className="text-xs text-tx-tertiary">{copy.unsupported}</p>}
          {available.sharedSupported && !available.remoteError && !available.sharedProfiles.length && (
            <p className="rounded-xl border border-dashed border-app-border/80 bg-app-surface/50 px-3.5 py-2.5 text-xs text-tx-tertiary">
              {copy.noShared}
            </p>
          )}
          {available.sharedProfiles.map((profile) => {
            const isSharedActive = available.active.scope === "shared" && available.active.id === profile.id;
            return (
              <div
                key={profile.id}
                className={cn(
                  "flex flex-wrap items-center justify-between gap-2.5 rounded-xl border px-3.5 py-3 transition-all",
                  isSharedActive
                    ? "border-emerald-400/40 bg-emerald-500/[0.06] shadow-xs"
                    : "border-app-border/70 bg-app-surface/75 hover:border-violet-400/35 hover:shadow-xs",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-tx-primary">
                    <span className="truncate">{profile.name}</span>
                    <span className="shrink-0 rounded-full bg-violet-500/12 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                      {copy.provided}
                    </span>
                  </p>
                  <p className="mt-0.5 break-all text-xs text-tx-secondary">{profile.model} · {profile.provider}</p>
                </div>
                <button
                  type="button"
                  disabled={activating || isSharedActive}
                  onClick={() => void activateShared(profile.id)}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-all disabled:opacity-60",
                    isSharedActive
                      ? "border border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                      : "border border-emerald-500/35 bg-app-elevated text-emerald-600 hover:-translate-y-0.5 hover:bg-emerald-500/10 dark:text-emerald-400",
                  )}
                >
                  {isSharedActive ? copy.active : copy.activate}
                </button>
              </div>
            );
          })}
        </section>
      )}
      {available?.isAdmin && (
        <div
          className="inline-flex items-center gap-1 rounded-2xl border border-app-border/80 bg-app-surface/80 p-1 shadow-xs"
          role="group"
          aria-label={copy.profiles}
        >
          <button
            type="button"
            aria-pressed={!manageShared}
            onClick={() => setManageShared(false)}
            className="rounded-xl px-3.5 py-1.5 text-xs font-semibold text-tx-secondary transition-all hover:text-tx-primary aria-pressed:bg-app-elevated aria-pressed:text-fuchsia-600 aria-pressed:shadow-xs dark:aria-pressed:text-fuchsia-300"
          >
            {copy.personal}
          </button>
          <button
            type="button"
            aria-pressed={manageShared}
            onClick={() => setManageShared(true)}
            className="rounded-xl px-3.5 py-1.5 text-xs font-semibold text-tx-secondary transition-all hover:text-tx-primary aria-pressed:bg-app-elevated aria-pressed:text-fuchsia-600 aria-pressed:shadow-xs dark:aria-pressed:text-fuchsia-300"
          >
            {copy.manageShared}
          </button>
        </div>
      )}
      {manageShared && (
        <p className="rounded-xl border border-violet-500/20 bg-violet-500/[0.06] px-3.5 py-2 text-xs leading-5 text-tx-secondary">
          {copy.managementHint}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-2xl border border-app-border/80 bg-app-elevated/75 p-3 shadow-xs backdrop-blur-sm">
          <div className="mb-2.5 flex items-center justify-between px-1">
            <span className="text-xs font-bold text-tx-secondary">{copy.profiles}</span>
            <button
              type="button"
              onClick={startNew}
              className="flex h-7 w-7 items-center justify-center rounded-xl border border-app-border/80 bg-app-surface text-tx-secondary transition-all hover:scale-105 hover:border-fuchsia-400/50 hover:text-fuchsia-600 dark:hover:text-fuchsia-300"
              title={copy.newProfile}
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="max-h-[450px] space-y-1.5 overflow-auto pr-0.5">
            {profiles.map((profile) => {
              const active = profile.id === activeProfileId;
              const selected = profile.id === selectedId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => selectProfile(profile)}
                  className={cn(
                    "w-full rounded-xl border px-3 py-2.5 text-left transition-all",
                    selected
                      ? "border-fuchsia-400/55 bg-gradient-to-br from-fuchsia-500/[0.09] via-app-elevated to-violet-500/[0.08] shadow-xs ring-1 ring-fuchsia-500/15"
                      : "border-transparent bg-app-surface/50 hover:border-app-border/80 hover:bg-app-elevated",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">{profile.name}</span>
                    {active && <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-tx-tertiary">{profile.model || profile.provider}</div>
                </button>
              );
            })}
            {selectedId === null && (
              <div className="rounded-xl border border-dashed border-fuchsia-400/60 bg-fuchsia-500/[0.08] px-3 py-2.5 text-sm font-semibold text-fuchsia-600 dark:text-fuchsia-300">
                {copy.newProfile}
              </div>
            )}
          </div>
        </aside>

        <section className="min-w-0 space-y-4 rounded-2xl border border-app-border/80 bg-app-elevated/85 p-5 shadow-xs backdrop-blur-sm">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-tx-secondary">{copy.profileName}</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2 text-sm text-tx-primary outline-none transition-all focus:border-fuchsia-400 focus:ring-2 focus:ring-fuchsia-500/15"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold text-tx-secondary">{copy.provider}</span>
              <div className="relative">
                <select
                  value={draft.provider}
                  onChange={(event) => changeProvider(event.target.value)}
                  className="w-full appearance-none rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2 pr-9 text-sm text-tx-primary outline-none transition-all focus:border-fuchsia-400 focus:ring-2 focus:ring-fuchsia-500/15"
                >
                  {PROVIDER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-tx-tertiary" />
              </div>
            </label>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-app-border/70 bg-app-surface/75 px-3.5 py-2.5">
            <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-xs", preset.color)}>
              <Zap size={14} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold text-tx-primary">{preset.name}</div>
              <div className="truncate text-[11px] text-tx-tertiary">{preset.desc}</div>
            </div>
            {selectedId === activeProfileId && selectedId !== null && (
              <span className="ml-auto shrink-0 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                {copy.active}
              </span>
            )}
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-tx-secondary">{copy.apiUrl}</span>
            <input
              value={draft.apiUrl}
              onChange={(event) => setDraft((current) => ({ ...current, apiUrl: event.target.value }))}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2 text-sm text-tx-primary outline-none transition-all focus:border-fuchsia-400 focus:ring-2 focus:ring-fuchsia-500/15"
            />
          </label>

          <p className="text-xs leading-relaxed text-tx-tertiary">{copy.apiUrlHint}</p>

          {needsKey && (
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-tx-secondary">{copy.apiKey}</span>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                  placeholder={selectedProfile?.apiKeySet ? copy.keyConfigured : "sk-..."}
                  className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2 pr-10 text-sm text-tx-primary outline-none transition-all focus:border-fuchsia-400 focus:ring-2 focus:ring-fuchsia-500/15"
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
          )}

          <details className="rounded-xl border border-app-border/80 bg-app-surface/55 p-3.5">
            <summary className="cursor-pointer text-xs font-semibold text-tx-secondary hover:text-tx-primary">{copy.advancedHeaders}</summary>
            <div className="mt-3 space-y-2.5">
              <p className="text-xs leading-relaxed text-tx-tertiary">{copy.headerHint}</p>
              {Object.entries(draft.customHeaders || {}).map(([name, value], index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={`${copy.headerName} ${index + 1}`}
                    value={name}
                    onChange={(event) => updateHeader(index, event.target.value, value)}
                    placeholder="x-session"
                    className="min-w-0 flex-1 rounded-xl border border-app-border/80 bg-app-elevated px-3 py-1.5 text-xs text-tx-primary outline-none focus:border-fuchsia-400"
                  />
                  <input
                    aria-label={`${copy.headerValue} ${index + 1}`}
                    type="password"
                    autoComplete="new-password"
                    value={value}
                    onChange={(event) => updateHeader(index, name, event.target.value)}
                    placeholder={copy.headerValue}
                    className="min-w-0 flex-1 rounded-xl border border-app-border/80 bg-app-elevated px-3 py-1.5 text-xs text-tx-primary outline-none focus:border-fuchsia-400"
                  />
                  <button
                    type="button"
                    aria-label={`${copy.removeHeader} ${index + 1}`}
                    onClick={() => setDraft((current) => ({ ...current, customHeaders: Object.fromEntries(Object.entries(current.customHeaders || {}).filter((_, i) => i !== index)) }))}
                    className="rounded-lg p-1.5 text-tx-tertiary transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={Object.hasOwn(draft.customHeaders || {}, "") || Object.keys(draft.customHeaders || {}).length >= 32}
                onClick={() => setDraft((current) => ({ ...current, customHeaders: { ...current.customHeaders, "": "" } }))}
                className="inline-flex items-center gap-1 rounded-lg bg-fuchsia-500/10 px-2.5 py-1 text-xs font-semibold text-fuchsia-600 transition-colors hover:bg-fuchsia-500/15 disabled:opacity-40 dark:text-fuchsia-300"
              >
                <Plus size={12} />{copy.addHeader}
              </button>
            </div>
          </details>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-tx-secondary">{copy.model}</span>
              <button
                type="button"
                onClick={() => void discoverModels(false)}
                disabled={manageShared || loadingModels || !draft.apiUrl}
                className="inline-flex items-center gap-1 rounded-lg bg-fuchsia-500/10 px-2.5 py-1 text-[11px] font-semibold text-fuchsia-600 transition-colors hover:bg-fuchsia-500/15 disabled:opacity-40 dark:text-fuchsia-300"
              >
                {loadingModels ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                {copy.fetchModels}
              </button>
            </div>
            <div className="relative">
              <input
                value={draft.model}
                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
                onFocus={() => models.length > 0 && setModelOpen(true)}
                placeholder={preset.defaultModel || copy.customModel}
                className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2 pr-9 text-sm text-tx-primary outline-none transition-all focus:border-fuchsia-400 focus:ring-2 focus:ring-fuchsia-500/15"
              />
              {models.length > 0 && (
                <button
                  type="button"
                  onClick={() => setModelOpen((value) => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-tx-tertiary hover:text-tx-primary"
                >
                  <ChevronDown size={14} />
                </button>
              )}
              {modelOpen && models.length > 0 && (
                <>
                  <button type="button" aria-label="close" className="fixed inset-0 z-40 cursor-default" onClick={() => setModelOpen(false)} />
                  <div className="absolute z-50 mt-1.5 max-h-60 w-full overflow-auto rounded-xl border border-app-border bg-app-elevated py-1.5 shadow-xl">
                    {models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => { setDraft((current) => ({ ...current, model: model.id })); setModelOpen(false); }}
                        className="flex w-full items-center justify-between px-3.5 py-2 text-left text-sm text-tx-primary transition-colors hover:bg-fuchsia-500/10 hover:text-fuchsia-600 dark:hover:text-fuchsia-300"
                      >
                        <span className="truncate">{model.name}</span>
                        {draft.model === model.id && <Check size={13} className="shrink-0 text-fuchsia-500" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="min-h-4 text-[11px]">
              {loadingModels ? <span className="text-tx-tertiary">{copy.fetching}</span>
                : modelError ? <span className="text-amber-600 dark:text-amber-400">{modelError}</span>
                : <span className="text-tx-tertiary">{manageShared ? copy.customModel : copy.autoModels}</span>}
            </div>
          </div>

          {nonChatKind && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200">
              <span className="flex-1">{nonChatHint}</span>
              {nonChatKind === "embedding" && (
                <button
                  type="button"
                  className="shrink-0 rounded-lg border border-amber-400/50 bg-app-elevated/80 px-2.5 py-1.5 font-semibold transition hover:bg-amber-500/15"
                  onClick={() => document.querySelector(".nowen-embedding-settings")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  {copy.goToEmbedding}
                </button>
              )}
            </div>
          )}

          {manageShared && (
            <fieldset className="space-y-3 rounded-xl border border-app-border/80 bg-app-surface/55 p-3.5">
              <legend className="inline-flex items-center gap-1.5 px-1.5 text-xs font-semibold text-tx-secondary">
                <Users size={12} className="text-violet-500" />
                {copy.members}
              </legend>
              <label className="flex items-center gap-2 text-sm font-medium text-tx-primary">
                <input
                  type="checkbox"
                  checked={sharedEnabled}
                  onChange={(event) => setSharedEnabled(event.target.checked)}
                  className="h-4 w-4 rounded accent-fuchsia-600"
                />
                {copy.enabled}
              </label>
              <div className="grid max-h-48 gap-2 overflow-auto sm:grid-cols-2">
                {members.map((member) => (
                  <label
                    key={member.id}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-app-border/60 bg-app-elevated/80 px-2.5 py-2 text-xs text-tx-primary"
                  >
                    <input
                      type="checkbox"
                      checked={memberIds.includes(member.id)}
                      disabled={!!member.isDisabled && !memberIds.includes(member.id)}
                      onChange={(event) => setMemberIds((ids) => event.target.checked ? [...ids, member.id] : ids.filter((id) => id !== member.id))}
                      className="h-3.5 w-3.5 rounded accent-fuchsia-600"
                    />
                    <span className="truncate">{member.displayName || member.username}{member.isDisabled ? ` · ${copy.disabledMember}` : ""}</span>
                  </label>
                ))}
                {!members.length && <p className="text-xs text-tx-tertiary">{copy.noMembers}</p>}
              </div>
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-app-border/70 pt-4">
            <button
              type="button"
              onClick={() => void saveProfile()}
              disabled={saving || testing}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-gradient-to-r from-fuchsia-500 via-violet-500 to-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-violet-500/20 transition-all hover:-translate-y-0.5 hover:shadow-md disabled:translate-y-0 disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {copy.save}
            </button>
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={testing || saving || !draft.apiUrl}
              className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-4 py-2 text-xs font-semibold text-tx-primary transition-all hover:-translate-y-0.5 hover:border-fuchsia-400/50 hover:text-fuchsia-600 disabled:translate-y-0 disabled:opacity-50 dark:hover:text-fuchsia-300"
            >
              {testing ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}
              {manageShared ? copy.sharedTest : copy.test}
            </button>
            {selectedId && selectedId !== activeProfileId && (!manageShared || available?.sharedProfiles.some((item) => item.id === selectedId)) && (
              <button
                type="button"
                onClick={() => void activateProfile()}
                disabled={activating || testing}
                className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-700 transition-all hover:-translate-y-0.5 hover:bg-emerald-500/15 disabled:translate-y-0 disabled:opacity-50 dark:text-emerald-300"
              >
                {activating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                {copy.activate}
              </button>
            )}
            {selectedId && !manageShared && available?.isAdmin && (
              <button
                type="button"
                onClick={() => void publishProfile()}
                disabled={saving || testing}
                className="shrink-0 whitespace-nowrap rounded-xl border border-violet-500/30 bg-violet-500/10 px-3.5 py-2 text-xs font-semibold text-violet-700 transition-all hover:-translate-y-0.5 hover:bg-violet-500/15 disabled:translate-y-0 disabled:opacity-50 dark:text-violet-300"
              >
                {copy.publish}
              </button>
            )}
            {selectedId && (
              <button
                type="button"
                onClick={() => void deleteProfile()}
                disabled={saving || testing}
                className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-rose-500 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
              >
                <Trash2 size={13} />
                {copy.delete}
              </button>
            )}
            {message && (
              <span
                className={cn(
                  "ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
                  message.type === "success"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "bg-rose-500/10 text-rose-600 dark:text-rose-300",
                )}
              >
                {message.type === "success" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                {message.text}
              </span>
            )}
          </div>
        </section>
      </div>
      {aiAvailable && <PluginPromptPackSettingsSection />}
      <SpeechSettingsPanel />
    </div>
  );
}
