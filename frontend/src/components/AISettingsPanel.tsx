import React, { useState, useEffect, useCallback } from "react";
import { Bot, Loader2, Check, AlertCircle, RefreshCw, Eye, EyeOff, ChevronDown, Zap, CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface AISettingsState {
  ai_provider: string;
  ai_api_url: string;
  ai_api_key: string;
  ai_model: string;
  ai_api_key_set: boolean;
}

interface ProviderPreset {
  id: string;
  name: string;
  desc: string;
  models: string;
  url: string;
  defaultModel: string;
  needsKey: boolean;
  color: string; // gradient color
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "qwen",
    name: "通义千问",
    desc: "ai.qwenDesc",
    models: "Qwen-Turbo / Qwen-Plus / Qwen-Max",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    needsKey: true,
    color: "from-violet-500 to-blue-500",
  },
  {
    id: "openai",
    name: "OpenAI",
    desc: "ai.openaiDesc",
    models: "GPT-4o / GPT-4o-mini",
    url: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
    color: "from-emerald-500 to-teal-500",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    desc: "ai.geminiDesc",
    models: "gemini-2.0-flash / gemini-2.5-pro-preview",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    needsKey: true,
    color: "from-blue-500 to-cyan-500",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    desc: "ai.deepseekDesc",
    models: "DeepSeek-V3 / DeepSeek-R1",
    url: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    needsKey: true,
    color: "from-sky-500 to-indigo-500",
  },
  {
    id: "doubao",
    name: "豆包（火山引擎）",
    desc: "ai.doubaoDesc",
    models: "Doubao-1.5-lite / Doubao-1.5-pro",
    url: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-1.5-pro-32k",
    needsKey: true,
    color: "from-orange-500 to-pink-500",
  },
  {
    id: "ollama",
    name: "Custom / Ollama",
    desc: "ai.ollamaCustomDesc",
    models: "OpenAI 兼容接口 · Docker 自动连接",
    url: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b",
    needsKey: false,
    color: "from-zinc-500 to-zinc-600",
  },
];

export default function AISettingsPanel() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AISettingsState>({
    ai_provider: "openai", ai_api_url: "", ai_api_key: "", ai_model: "", ai_api_key_set: false,
  });
  const [localKey, setLocalKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveMsg, setSaveMsg] = useState("");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.getAISettings();
      setSettings(data);
      setLocalKey(data.ai_api_key_set ? data.ai_api_key : "");
      setIsConfigured(!!data.ai_api_url && (data.ai_api_key_set || !getPreset(data.ai_provider)?.needsKey));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  function getPreset(providerId: string): ProviderPreset | undefined {
    return PROVIDER_PRESETS.find(p => p.id === providerId);
  }

  const handleProviderChange = (provider: string) => {
    const preset = getPreset(provider);
    if (!preset) return;
    setSettings(prev => ({
      ...prev,
      ai_provider: provider,
      ai_api_url: preset.url,
      ai_model: preset.defaultModel,
    }));
    if (!preset.needsKey) setLocalKey("");
    setTestResult(null);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMsg("");
    try {
      const payload: any = {
        ai_provider: settings.ai_provider,
        ai_api_url: settings.ai_api_url,
        ai_model: settings.ai_model,
      };
      if (localKey && !localKey.includes("****")) {
        payload.ai_api_key = localKey;
      }
      const data = await api.updateAISettings(payload);
      setSettings(data);
      setIsConfigured(true);
      setSaveMsg(t("ai.saveSuccess"));
      setTimeout(() => setSaveMsg(""), 2000);
    } catch (err: any) {
      setSaveMsg(err.message || t("ai.saveFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const payload: any = {
        ai_provider: settings.ai_provider,
        ai_api_url: settings.ai_api_url,
        ai_model: settings.ai_model,
      };
      if (localKey && !localKey.includes("****")) payload.ai_api_key = localKey;
      await api.updateAISettings(payload);
      const result = await api.testAIConnection();
      setTestResult({ success: result.success, message: result.message || result.error || "" });
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || t("ai.testFailed") });
    } finally {
      setIsTesting(false);
    }
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const payload: any = {
        ai_provider: settings.ai_provider,
        ai_api_url: settings.ai_api_url,
        ai_model: settings.ai_model,
      };
      if (localKey && !localKey.includes("****")) payload.ai_api_key = localKey;
      await api.updateAISettings(payload);
      const data = await api.getAIModels();
      setModels(data.models || []);
      if (data.models?.length) setModelDropdownOpen(true);
    } catch { /* ignore */ }
    setLoadingModels(false);
  };

  const currentPreset = getPreset(settings.ai_provider);
  const needsKey = currentPreset?.needsKey ?? true;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t("ai.title")}</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("ai.description")}</p>
        </div>
        {isConfigured && (
          <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
            <CircleCheck size={14} />
            {t("ai.configured")}
          </span>
        )}
      </div>

      {/* Provider 卡片列表 */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t("ai.provider")}</label>
        <div className="space-y-2">
          {PROVIDER_PRESETS.map(p => {
            const isSelected = settings.ai_provider === p.id;
            return (
              <button
                key={p.id}
                onClick={() => handleProviderChange(p.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all text-left group",
                  isSelected
                    ? "border-accent-primary bg-accent-primary/5 dark:bg-accent-primary/10"
                    : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                )}
              >
                {/* Provider icon */}
                <div className={cn(
                  "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-gradient-to-br text-white",
                  p.color
                )}>
                  <Zap size={16} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-sm font-semibold",
                      isSelected ? "text-accent-primary" : "text-zinc-800 dark:text-zinc-200"
                    )}>
                      {p.name}
                    </span>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t(p.desc)}</span>
                  </div>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 truncate">
                    {p.models}
                  </p>
                </div>

                {/* 选中标记 */}
                {isSelected && (
                  <CircleCheck size={18} className="text-accent-primary shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 配置区域 */}
      <div className="space-y-4 p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/30 border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2 mb-1">
          <div className={cn("w-6 h-6 rounded-md flex items-center justify-center bg-gradient-to-br text-white", currentPreset?.color || "from-zinc-500 to-zinc-600")}>
            <Zap size={12} />
          </div>
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            {currentPreset?.name || settings.ai_provider}
          </span>
          <span className="text-[10px] text-zinc-400">{t("ai.configLabel")}</span>
        </div>

        {/* API URL */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t("ai.apiUrl")}</label>
          <input
            type="text"
            value={settings.ai_api_url}
            onChange={(e) => setSettings(prev => ({ ...prev, ai_api_url: e.target.value }))}
            placeholder={currentPreset?.url || "https://api.openai.com/v1"}
            className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all placeholder:text-zinc-400"
          />
        </div>

        {/* API Key */}
        {needsKey && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t("ai.apiKey")}</label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={localKey}
                onChange={(e) => { setLocalKey(e.target.value); setTestResult(null); }}
                placeholder={settings.ai_api_key_set ? t("ai.apiKeySet") : "sk-..."}
                className="w-full px-3 py-2 pr-10 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all placeholder:text-zinc-400"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        )}

        {/* Model */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t("ai.model")}</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                value={settings.ai_model}
                onChange={(e) => setSettings(prev => ({ ...prev, ai_model: e.target.value }))}
                placeholder={currentPreset?.defaultModel || "gpt-4o-mini"}
                className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all placeholder:text-zinc-400"
              />
              {modelDropdownOpen && models.length > 0 && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setModelDropdownOpen(false)} />
                  <div className="absolute z-50 top-full left-0 mt-1 w-full max-h-48 overflow-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl">
                    {models.map(m => (
                      <button
                        key={m.id}
                        onClick={() => { setSettings(prev => ({ ...prev, ai_model: m.id })); setModelDropdownOpen(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={fetchModels}
              disabled={loadingModels || !settings.ai_api_url}
              className="flex items-center gap-1.5 px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-600 dark:text-zinc-400 hover:border-accent-primary/50 hover:text-accent-primary transition-colors disabled:opacity-40 bg-white dark:bg-zinc-900"
            >
              {loadingModels ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t("ai.fetchModels")}
            </button>
          </div>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-white rounded-lg text-xs font-medium transition-all disabled:opacity-40"
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {t("ai.saveSettings")}
        </button>

        <button
          onClick={handleTest}
          disabled={isTesting || !settings.ai_api_url}
          className="flex items-center gap-1.5 px-4 py-1.5 border border-zinc-200 dark:border-zinc-800 rounded-lg text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:border-accent-primary/50 transition-all disabled:opacity-40"
        >
          {isTesting ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
          {t("ai.testConnection")}
        </button>

        {saveMsg && (
          <span className={cn("text-xs", saveMsg === t("ai.saveSuccess") ? "text-emerald-500" : "text-red-500")}>
            {saveMsg}
          </span>
        )}
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div className={cn(
          "flex items-center gap-2 p-3 rounded-lg text-sm",
          testResult.success
            ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400"
        )}>
          {testResult.success ? <Check size={16} /> : <AlertCircle size={16} />}
          {testResult.message}
        </div>
      )}
    </div>
  );
}
