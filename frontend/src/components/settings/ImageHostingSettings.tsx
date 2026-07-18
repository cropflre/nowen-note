/**
 * 第三方图床设置页
 *
 * 提供图床配置、测试连接、启用/禁用功能。
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Image, Save, Loader2, TestTube2, CheckCircle2, XCircle,
  AlertCircle, Trash2, Eye, EyeOff, Info,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { api } from "@/lib/api";
import { confirm } from "@/components/ui/confirm";

interface ImageHostingConfig {
  enabled: boolean;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  publicBaseUrl: string;
  pathPrefix: string;
  usePathStyle: boolean;
  maxFileSizeMb: number;
  allowedTypes: string[];
  fallbackToLocal: boolean;
  updatedAt: string | null;
}

export default function ImageHostingSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ImageHostingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; url?: string; error?: string } | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  // 表单状态
  const [formEnabled, setFormEnabled] = useState(false);
  const [formEndpoint, setFormEndpoint] = useState("");
  const [formRegion, setFormRegion] = useState("auto");
  const [formBucket, setFormBucket] = useState("");
  const [formAccessKeyId, setFormAccessKeyId] = useState("");
  const [formSecretAccessKey, setFormSecretAccessKey] = useState("");
  const [formPublicBaseUrl, setFormPublicBaseUrl] = useState("");
  const [formPathPrefix, setFormPathPrefix] = useState("images");
  const [formUsePathStyle, setFormUsePathStyle] = useState(true);
  const [formMaxFileSizeMb, setFormMaxFileSizeMb] = useState(10);
  const [formFallbackToLocal, setFormFallbackToLocal] = useState(true);

  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.imageHosting.getConfig();
      setConfig(data);
      setFormEnabled(data.enabled);
      setFormEndpoint(data.endpoint);
      setFormRegion(data.region);
      setFormBucket(data.bucket);
      setFormAccessKeyId(data.accessKeyId);
      setFormPublicBaseUrl(data.publicBaseUrl);
      setFormPathPrefix(data.pathPrefix);
      setFormUsePathStyle(data.usePathStyle);
      setFormMaxFileSizeMb(data.maxFileSizeMb);
      setFormFallbackToLocal(data.fallbackToLocal !== false);
      setFormSecretAccessKey(""); // 不回填密钥
    } catch (e: any) {
      console.warn("[ImageHostingSettings] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleSave = async () => {
    try {
      setSaving(true);
      const result = await api.imageHosting.saveConfig({
        enabled: formEnabled,
        provider: "s3-compatible",
        endpoint: formEndpoint,
        region: formRegion,
        bucket: formBucket,
        accessKeyId: formAccessKeyId,
        secretAccessKey: formSecretAccessKey || undefined, // 留空表示不修改
        publicBaseUrl: formPublicBaseUrl,
        pathPrefix: formPathPrefix,
        usePathStyle: formUsePathStyle,
        maxFileSizeMb: formMaxFileSizeMb,
        allowedTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
        fallbackToLocal: formFallbackToLocal,
      });
      setConfig(result);
      setFormFallbackToLocal(result.fallbackToLocal !== false);
      setFormSecretAccessKey(""); // 清空密钥输入
      toast.success(t("imageHosting.configSaved"));
    } catch (e: any) {
      toast.error(e?.message || t("imageHosting.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    try {
      setTesting(true);
      setTestResult(null);
      const result = await api.imageHosting.test();
      setTestResult(result);
      if (result.ok) {
        toast.success(t("imageHosting.testSuccess"));
      } else {
        toast.error(result.error || t("imageHosting.testFailed"));
      }
    } catch (e: any) {
      setTestResult({ ok: false, error: e?.message || "Test failed" });
      toast.error(e?.message || t("imageHosting.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!await confirm({ title: t("imageHosting.deleteConfirm"), danger: true })) return;
    try {
      await api.imageHosting.deleteConfig();
      await loadConfig();
      toast.success(t("imageHosting.configDeleted"));
    } catch (e: any) {
      toast.error(e?.message || t("imageHosting.deleteFailed"));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-tx-tertiary text-sm">
        <Loader2 size={14} className="animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 标题 */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Image className="w-4 h-4 text-accent-primary" />
          <h3 className="text-lg font-bold text-tx-primary">{t("imageHosting.title")}</h3>
        </div>
        <p className="text-sm text-tx-tertiary">{t("imageHosting.description")}</p>
      </div>

      {/* 状态提示 */}
      {config && (
        <div className={cn(
          "flex items-start gap-2 p-3 rounded-lg border text-sm",
          config.enabled
            ? "bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-300"
            : "bg-zinc-500/5 border-zinc-500/20 text-tx-tertiary"
        )}>
          {config.enabled ? <CheckCircle2 size={16} className="shrink-0 mt-0.5" /> : <Info size={16} className="shrink-0 mt-0.5" />}
          <div>
            <p className="font-medium">{config.enabled ? t("imageHosting.enabled") : t("imageHosting.disabled")}</p>
            {config.enabled && config.endpoint && (
              <p className="text-xs mt-0.5 opacity-70">{config.endpoint}/{config.bucket}</p>
            )}
          </div>
        </div>
      )}

      {/* 配置表单 */}
      <div className="space-y-4">
        {/* 启用开关 */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={formEnabled}
            onChange={(e) => setFormEnabled(e.target.checked)}
            className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30"
          />
          <span className="text-sm text-tx-secondary">{t("imageHosting.enableImageHosting")}</span>
        </label>

        {/* Endpoint */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Endpoint</label>
          <input
            type="text"
            value={formEndpoint}
            onChange={(e) => setFormEndpoint(e.target.value)}
            placeholder="https://s3.amazonaws.com"
            className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-2 outline-none focus:ring-2 focus:ring-accent-primary/30"
          />
        </div>

        {/* Region */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Region</label>
          <input
            type="text"
            value={formRegion}
            onChange={(e) => setFormRegion(e.target.value)}
            placeholder="us-east-1"
            className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-2 outline-none focus:ring-2 focus:ring-accent-primary/30"
          />
        </div>

        {/* Bucket */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Bucket</label>
          <input
            type="text"
            value={formBucket}
            onChange={(e) => setFormBucket(e.target.value)}
            placeholder="my-bucket"
            className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-2 outline-none focus:ring-2 focus:ring-accent-primary/30"
          />
        </div>

        {/* Access Key ID */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Access Key ID</label>
          <input
            type="text"
            value={formAccessKeyId}
            onChange={(e) => setFormAccessKeyId(e.target.value)}
            placeholder="AKIAIOSFODNN7EXAMPLE"
            className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-2 outline-none focus:ring-2 focus:ring-accent-primary/30"
          />
        </div>

        {/* Secret Access Key */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">
            Secret Access Key
            {config?.secretAccessKeySet && (
              <span className="ml-2 text-green-500">({t("imageHosting.secretSet")})</span>
            )}
          </label>
          <div className="relative">
            <input
              type={showSecret ? "text" : "password"}
              value={formSecretAccessKey}
              onChange={(e) => setFormSecretAccessKey(e.target.value)}
              placeholder={config?.secretAccessKeySet ? t("imageHosting.secretPlaceholder") : "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}
              className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-2 pr-10 outline-none focus:ring-2 focus:ring-accent-primary/30"
            />
            <button
              type="button"
              onClick={() => setShowSecret(!showSecret)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-tx-tertiary hover:text-tx-secondary"
            >
              {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {/* Public Base URL */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Public Base URL</label>
          <input
            type="text"
            value={formPublicBaseUrl}
            onChange={(e) => setFormPublicBaseUrl(e.target.value)}
            placeholder="https://cdn.example.com"
            className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-2 outline-none focus:ring-2 focus:ring-accent-primary/30"
          />
          <p className="text-[10px] text-tx-tertiary mt-1">{t("imageHosting.publicBaseUrlHint")}</p>
        </div>

        {/* Path Prefix */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Path Prefix</label>
          <input
            type="text"
            value={formPathPrefix}
            onChange={(e) => setFormPathPrefix(e.target.value)}
            placeholder="images"
            className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-2 outline-none focus:ring-2 focus:ring-accent-primary/30"
          />
        </div>

        {/* Use Path Style */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={formUsePathStyle}
            onChange={(e) => setFormUsePathStyle(e.target.checked)}
            className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30"
          />
          <span className="text-sm text-tx-secondary">{t("imageHosting.usePathStyle")}</span>
        </label>

        {/* Max File Size */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">{t("imageHosting.maxFileSize")}</label>
          <input
            type="number"
            value={formMaxFileSizeMb}
            onChange={(e) => setFormMaxFileSizeMb(Number(e.target.value))}
            min={1}
            max={100}
            className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-2 outline-none focus:ring-2 focus:ring-accent-primary/30"
          />
        </div>

        {/* Fallback */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={formFallbackToLocal}
            onChange={(e) => setFormFallbackToLocal(e.target.checked)}
            className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30"
          />
          <span className="text-sm text-tx-secondary">{t("imageHosting.fallbackToLocal")}</span>
        </label>
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div className={cn(
          "flex items-start gap-2 p-3 rounded-lg border text-sm",
          testResult.ok
            ? "bg-green-500/5 border-green-500/20 text-green-700 dark:text-green-300"
            : "bg-red-500/5 border-red-500/20 text-red-700 dark:text-red-300"
        )}>
          {testResult.ok ? <CheckCircle2 size={16} className="shrink-0 mt-0.5" /> : <XCircle size={16} className="shrink-0 mt-0.5" />}
          <div>
            <p className="font-medium">{testResult.ok ? t("imageHosting.testSuccess") : t("imageHosting.testFailed")}</p>
            {testResult.url && <p className="text-xs mt-0.5 break-all">{testResult.url}</p>}
            {testResult.error && <p className="text-xs mt-0.5">{testResult.error}</p>}
          </div>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-accent-primary text-white hover:opacity-90 disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {t("imageHosting.save")}
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || !formEnabled}
          className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg border border-app-border text-tx-secondary hover:text-tx-primary hover:bg-app-hover disabled:opacity-50 transition-colors"
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : <TestTube2 size={14} />}
          {t("imageHosting.testConnection")}
        </button>
        {config?.updatedAt && (
          <button
            type="button"
            onClick={handleDelete}
            className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg text-tx-tertiary hover:text-red-500 hover:bg-red-500/5 transition-colors ml-auto"
          >
            <Trash2 size={14} />
            {t("imageHosting.deleteConfig")}
          </button>
        )}
      </div>
    </div>
  );
}
