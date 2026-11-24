/**
 * 日历 ICS 镜像导出设置
 *
 * 按钮 + 弹窗模式，管理 S3 export targets：添加/编辑/删除/测试连接/立即导出。
 * 与 TaskCalendarFeedSettings 风格一致，放在日历订阅按钮旁边。
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Cloud, Plus, Pencil, Trash2, Loader2, X, TestTube2,
  Upload, Copy, CheckCircle2, XCircle, ExternalLink, Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";

// ====== 类型 ======

interface ExportTarget {
  id: string;
  userId: string;
  feedId: string;
  type: string;
  enabled: boolean;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  pathPrefix: string;
  publicBaseUrl: string;
  usePathStyle: boolean;
  publicUrl: string | null;
  lastExportAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FormData {
  name: string;
  feedId: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathPrefix: string;
  publicBaseUrl: string;
  usePathStyle: boolean;
  enabled: boolean;
}

const EMPTY_FORM: FormData = {
  name: "",
  feedId: "",
  endpoint: "",
  region: "auto",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  pathPrefix: "nowen-calendar",
  publicBaseUrl: "",
  usePathStyle: true,
  enabled: true,
};

// ====== 主组件（按钮 + 弹窗） ======

export function CalendarExportTargetSettings() {
  const [expanded, setExpanded] = useState(false);
  const [targets, setTargets] = useState<ExportTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [feedId, setFeedId] = useState<string | null>(null);

  // 加载 export targets
  const loadTargets = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.calendarExportTargets.list();
      setTargets(res.targets || []);
    } catch {
      // 静默降级
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载当前 feed（用于默认 feedId）
  const loadFeed = useCallback(async () => {
    try {
      const res = await api.taskCalendarFeed.get();
      if (res.feed?.id) setFeedId(res.feed.id);
    } catch {
      // 静默降级
    }
  }, []);

  // 打开弹窗时加载数据
  useEffect(() => {
    if (expanded) {
      loadTargets();
      loadFeed();
    }
  }, [expanded, loadTargets, loadFeed]);

  // Esc 关闭弹窗
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showForm) {
          setShowForm(false);
          setEditingId(null);
        } else {
          setExpanded(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, showForm]);

  // 打开新建表单
  const handleAdd = useCallback(() => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, feedId: feedId || "" });
    setShowForm(true);
  }, [feedId]);

  // 打开编辑表单
  const handleEdit = useCallback((target: ExportTarget) => {
    setEditingId(target.id);
    setForm({
      name: target.name,
      feedId: target.feedId,
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      accessKeyId: target.accessKeyId,
      secretAccessKey: "", // 编辑时不回填
      pathPrefix: target.pathPrefix,
      publicBaseUrl: target.publicBaseUrl,
      usePathStyle: target.usePathStyle,
      enabled: target.enabled,
    });
    setShowForm(true);
  }, []);

  // 关闭表单
  const handleCloseForm = useCallback(() => {
    setShowForm(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
  }, []);

  // 提交表单
  const handleSubmit = useCallback(async () => {
    if (!form.feedId || !form.endpoint || !form.bucket || !form.accessKeyId || !form.publicBaseUrl) {
      toast.error("请填写所有必填字段");
      return;
    }
    if (!editingId && !form.secretAccessKey) {
      toast.error("新建时密钥必填");
      return;
    }

    try {
      setSaving(true);
      if (editingId) {
        const updateData: any = {
          name: form.name,
          enabled: form.enabled,
          endpoint: form.endpoint,
          region: form.region,
          bucket: form.bucket,
          accessKeyId: form.accessKeyId,
          pathPrefix: form.pathPrefix,
          publicBaseUrl: form.publicBaseUrl,
          forcePathStyle: form.usePathStyle,
        };
        if (form.secretAccessKey) {
          updateData.secretAccessKey = form.secretAccessKey;
        }
        await api.calendarExportTargets.update(editingId, updateData);
        toast.success("更新成功");
      } else {
        await api.calendarExportTargets.create({
          feedId: form.feedId,
          name: form.name,
          enabled: form.enabled,
          endpoint: form.endpoint,
          region: form.region,
          bucket: form.bucket,
          accessKeyId: form.accessKeyId,
          secretAccessKey: form.secretAccessKey,
          pathPrefix: form.pathPrefix,
          publicBaseUrl: form.publicBaseUrl,
          forcePathStyle: form.usePathStyle,
        });
        toast.success("创建成功");
      }
      handleCloseForm();
      await loadTargets();
    } catch (e: any) {
      toast.error(e?.message || "操作失败");
    } finally {
      setSaving(false);
    }
  }, [form, editingId, handleCloseForm, loadTargets]);

  // 删除
  const handleDelete = useCallback(async (id: string) => {
    if (!await confirm({ title: "确定删除该导出目标？", danger: true })) return;
    try {
      setActionLoading(id);
      await api.calendarExportTargets.delete(id);
      toast.success("已删除");
      await loadTargets();
    } catch (e: any) {
      toast.error(e?.message || "删除失败");
    } finally {
      setActionLoading(null);
    }
  }, [loadTargets]);

  // 测试连接
  const handleTest = useCallback(async (id: string) => {
    try {
      setActionLoading(id);
      const res = await api.calendarExportTargets.test(id);
      if (res.ok) {
        toast.success("连接测试成功");
      } else {
        toast.error(res.error || "连接测试失败");
      }
    } catch (e: any) {
      toast.error(e?.message || "连接测试失败");
    } finally {
      setActionLoading(null);
      await loadTargets();
    }
  }, [loadTargets]);

  // 立即导出
  const handleExportNow = useCallback(async (id: string) => {
    try {
      setActionLoading(id);
      const res = await api.calendarExportTargets.exportNow(id);
      if (res.success) {
        toast.success("导出成功");
      } else {
        toast.error(res.error || "导出失败");
      }
    } catch (e: any) {
      toast.error(e?.message || "导出失败");
    } finally {
      setActionLoading(null);
      await loadTargets();
    }
  }, [loadTargets]);

  // 复制 URL
  const handleCopyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("已复制");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast.success("已复制");
    }
  }, []);

  // ====== 渲染 ======

  return (
    <>
      {/* 入口按钮 */}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={cn(
          "flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
          expanded
            ? "text-accent-primary bg-accent-primary/10"
            : "text-tx-tertiary hover:text-accent-primary hover:bg-accent-primary/5"
        )}
      >
        <Cloud size={13} />
        镜像导出
      </button>

      {/* 弹窗 */}
      {expanded && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center px-4 py-6">
          {/* 遮罩 */}
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-black/20 backdrop-blur-[1px]"
            onClick={() => setExpanded(false)}
          />
          {/* 弹窗卡片 */}
          <div
            className="relative w-full max-w-md max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border border-app-border bg-app-elevated shadow-2xl p-4 space-y-3"
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cloud size={14} className="text-accent-primary" />
                <h4 className="text-sm font-medium text-tx-primary">镜像导出</h4>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleAdd}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-tx-tertiary hover:text-accent-primary rounded-md hover:bg-accent-primary/5 transition-colors"
                >
                  <Plus size={13} />
                  添加
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="p-1 rounded-md text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-colors"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* 说明 */}
            <p className="text-[11px] text-tx-tertiary leading-relaxed">
              将当前任务日历 .ics 文件上传到 S3 兼容对象存储，方便手机系统日历订阅稳定的外部 URL。
            </p>

            {/* 加载中 */}
            {loading && (
              <div className="flex items-center gap-2 text-tx-tertiary text-xs py-4">
                <Loader2 size={13} className="animate-spin" />
                加载中...
              </div>
            )}

            {/* 空状态 */}
            {!loading && targets.length === 0 && (
              <div className="rounded-lg border border-dashed border-app-border p-4 text-center">
                <Cloud size={20} className="mx-auto text-tx-tertiary mb-2 opacity-50" />
                <p className="text-xs text-tx-tertiary">暂无导出目标</p>
                <p className="text-[11px] text-tx-tertiary mt-1">点击"添加"开始配置 S3 导出</p>
              </div>
            )}

            {/* 列表 */}
            {!loading && targets.map((target) => (
              <TargetCard
                key={target.id}
                target={target}
                loading={actionLoading === target.id}
                onEdit={() => handleEdit(target)}
                onDelete={() => handleDelete(target.id)}
                onTest={() => handleTest(target.id)}
                onExportNow={() => handleExportNow(target.id)}
                onCopyUrl={handleCopyUrl}
              />
            ))}

            {/* 提示 */}
            <p className="text-[11px] text-tx-tertiary leading-relaxed">
              配置 S3 兼容存储后，可将日历 ICS 文件自动镜像到外部 URL，供手机系统日历订阅。
            </p>
          </div>
        </div>
      )}

      {/* 表单弹窗 */}
      {showForm && (
        <TargetForm
          form={form}
          setForm={setForm}
          isEdit={!!editingId}
          saving={saving}
          onSubmit={handleSubmit}
          onClose={handleCloseForm}
        />
      )}
    </>
  );
}

// ====== 目标卡片 ======

function TargetCard({
  target,
  loading,
  onEdit,
  onDelete,
  onTest,
  onExportNow,
  onCopyUrl,
}: {
  target: ExportTarget;
  loading: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  onExportNow: () => void;
  onCopyUrl: (url: string) => void;
}) {
  const [showError, setShowError] = useState(false);

  return (
    <div className="rounded-lg border border-app-border bg-app-bg p-3 space-y-2">
      {/* 头部：名称 + 状态 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("w-2 h-2 rounded-full shrink-0", target.enabled ? "bg-green-500" : "bg-gray-400")} />
          <span className="text-xs font-medium text-tx-primary truncate">
            {target.name || "未命名"}
          </span>
          <span className="text-[10px] text-tx-tertiary px-1.5 py-0.5 rounded bg-app-hover">S3</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            disabled={loading}
            className="p-1 text-tx-tertiary hover:text-tx-secondary rounded transition-colors disabled:opacity-50"
            title="编辑"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={loading}
            className="p-1 text-tx-tertiary hover:text-red-500 rounded transition-colors disabled:opacity-50"
            title="删除"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* 信息 */}
      <div className="text-[11px] text-tx-tertiary space-y-0.5">
        <div className="flex gap-2">
          <span className="shrink-0">Endpoint:</span>
          <span className="truncate break-all">{target.endpoint}</span>
        </div>
        <div className="flex gap-2">
          <span className="shrink-0">Bucket:</span>
          <span>{target.bucket}</span>
        </div>
        {target.pathPrefix && (
          <div className="flex gap-2">
            <span className="shrink-0">Path:</span>
            <span className="break-all">{target.pathPrefix}/{target.userId}/{target.feedId}.ics</span>
          </div>
        )}
      </div>

      {/* 导出状态 */}
      {target.lastStatus && (
        <div className="flex items-start gap-1.5 text-[11px]">
          {target.lastStatus === "success" ? (
            <CheckCircle2 size={12} className="text-green-500 shrink-0 mt-0.5" />
          ) : (
            <XCircle size={12} className="text-red-500 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <span className={target.lastStatus === "success" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
              {target.lastStatus === "success" ? "导出成功" : "导出失败"}
            </span>
            {target.lastExportAt && (
              <span className="text-tx-tertiary ml-2">
                {new Date(target.lastExportAt).toLocaleString()}
              </span>
            )}
            {target.lastError && (
              <button
                type="button"
                onClick={() => setShowError(!showError)}
                className="text-red-500 ml-1 underline decoration-dotted"
              >
                {showError ? "隐藏" : "详情"}
              </button>
            )}
            {showError && target.lastError && (
              <p className="text-red-500 mt-1 break-words">{target.lastError}</p>
            )}
          </div>
        </div>
      )}

      {/* 公开 URL */}
      {target.publicUrl && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <ExternalLink size={11} className="text-tx-tertiary shrink-0" />
          <a
            href={target.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-primary hover:underline break-all"
          >
            {target.publicUrl}
          </a>
          <button
            type="button"
            onClick={() => onCopyUrl(target.publicUrl!)}
            className="p-0.5 text-tx-tertiary hover:text-tx-secondary rounded transition-colors shrink-0"
            title="复制链接"
          >
            <Copy size={11} />
          </button>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onTest}
          disabled={loading}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] text-tx-tertiary hover:text-tx-secondary bg-app-hover rounded-md hover:bg-app-hover/80 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <TestTube2 size={11} />}
          测试连接
        </button>
        <button
          type="button"
          onClick={onExportNow}
          disabled={loading}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] text-tx-tertiary hover:text-accent-primary bg-app-hover rounded-md hover:bg-accent-primary/5 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          立即导出
        </button>
      </div>
    </div>
  );
}

// ====== 表单弹窗 ======

function TargetForm({
  form,
  setForm,
  isEdit,
  saving,
  onSubmit,
  onClose,
}: {
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
  isEdit: boolean;
  saving: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const update = (key: keyof FormData, value: any) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center px-4 py-6">
      {/* 遮罩 */}
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
      />
      {/* 弹窗卡片 */}
      <div
        className="relative w-full max-w-sm max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border border-app-border bg-app-elevated shadow-2xl p-4 space-y-3"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-tx-primary">
            {isEdit ? "编辑导出目标" : "添加导出目标"}
          </h4>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* 名称 */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">名称</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="我的 S3 存储"
            className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-2 focus:ring-accent-primary/30 outline-none"
          />
        </div>

        {/* Endpoint */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Endpoint *</label>
          <input
            type="text"
            value={form.endpoint}
            onChange={(e) => update("endpoint", e.target.value)}
            placeholder="https://s3.example.com"
            className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-2 focus:ring-accent-primary/30 outline-none"
          />
        </div>

        {/* Region */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Region</label>
          <input
            type="text"
            value={form.region}
            onChange={(e) => update("region", e.target.value)}
            placeholder="auto"
            className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-2 focus:ring-accent-primary/30 outline-none"
          />
        </div>

        {/* Bucket */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Bucket *</label>
          <input
            type="text"
            value={form.bucket}
            onChange={(e) => update("bucket", e.target.value)}
            placeholder="nowen"
            className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-2 focus:ring-accent-primary/30 outline-none"
          />
        </div>

        {/* Access Key ID */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Access Key ID *</label>
          <input
            type="text"
            value={form.accessKeyId}
            onChange={(e) => update("accessKeyId", e.target.value)}
            placeholder="AKIAIOSFODNN7EXAMPLE"
            className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-2 focus:ring-accent-primary/30 outline-none"
          />
        </div>

        {/* Secret Access Key */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">
            Secret Access Key *{isEdit && <span className="text-tx-tertiary ml-1">(留空保留原密钥)</span>}
          </label>
          <input
            type="password"
            value={form.secretAccessKey}
            onChange={(e) => update("secretAccessKey", e.target.value)}
            placeholder={isEdit ? "留空表示不修改" : "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}
            className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-2 focus:ring-accent-primary/30 outline-none"
          />
        </div>

        {/* Path Prefix */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">{t("auditI18n.pathPrefix")}</label>
          <input
            type="text"
            value={form.pathPrefix}
            onChange={(e) => update("pathPrefix", e.target.value)}
            placeholder="nowen-calendar"
            className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-2 focus:ring-accent-primary/30 outline-none"
          />
        </div>

        {/* Public Base URL */}
        <div>
          <label className="block text-xs text-tx-tertiary mb-1">Public Base URL *</label>
          <input
            type="text"
            value={form.publicBaseUrl}
            onChange={(e) => update("publicBaseUrl", e.target.value)}
            placeholder="https://cdn.example.com/nowen"
            className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-2 focus:ring-accent-primary/30 outline-none"
          />
        </div>

        {/* Force Path Style */}
        <label className="flex items-center gap-2.5 cursor-pointer min-h-[32px]">
          <input
            type="checkbox"
            checked={form.usePathStyle}
            onChange={(e) => update("usePathStyle", e.target.checked)}
            className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30"
          />
          <span className="text-xs text-tx-secondary">使用 Path Style（推荐，R2 / MinIO / 自建 S3 适用）</span>
        </label>

        {/* Enabled */}
        <label className="flex items-center gap-2.5 cursor-pointer min-h-[32px]">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => update("enabled", e.target.checked)}
            className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30"
          />
          <span className="text-xs text-tx-secondary">启用</span>
        </label>

        {/* 安全提示 */}
        <div className="flex items-start gap-1.5 p-2 rounded-lg bg-app-hover text-[11px] text-tx-tertiary">
          <Info size={12} className="shrink-0 mt-0.5" />
          <span>S3 密钥会加密保存在服务器数据库中。编辑时留空表示保留原密钥。</span>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onSubmit}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-accent-primary rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            {isEdit ? "保存" : "创建"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-xs text-tx-tertiary hover:text-tx-secondary bg-app-hover rounded-lg transition-colors disabled:opacity-50"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
