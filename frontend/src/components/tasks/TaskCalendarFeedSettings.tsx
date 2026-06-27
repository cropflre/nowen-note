import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Calendar, Copy, RefreshCw, Trash2, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { api, getBaseUrl } from "@/lib/api";
import { toast } from "@/lib/toast";

interface CalendarFeed {
  id: string;
  token: string;
  enabled: boolean;
  includeCompleted: boolean;
  includeDescription: boolean;
  defaultAlarmMinutes: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function TaskCalendarFeedSettings() {
  const { t } = useTranslation();

  const alarmOptions = useMemo(() => [
    { value: 0, label: t("tasks.calendarFeed.alarm0") },
    { value: 5, label: t("tasks.calendarFeed.alarm5") },
    { value: 10, label: t("tasks.calendarFeed.alarm10") },
    { value: 30, label: t("tasks.calendarFeed.alarm30") },
    { value: 60, label: t("tasks.calendarFeed.alarm60") },
    { value: 1440, label: t("tasks.calendarFeed.alarm1440") },
  ], [t]);

  const [feed, setFeed] = useState<CalendarFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const loadFeed = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.taskCalendarFeed.get();
      setFeed(res.feed);
    } catch {
      // 日历订阅入口是增强能力，加载失败时静默降级，不阻塞待办主流程。
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  // Esc 关闭弹窗
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const handleCreate = useCallback(async () => {
    try {
      setActionLoading("create");
      const res = await api.taskCalendarFeed.create();
      setFeed(res.feed);
      toast.success(t("tasks.calendarFeed.created"));
    } catch {
      toast.error(t("tasks.calendarFeed.error"));
    } finally {
      setActionLoading(null);
    }
  }, [t]);

  const handleUpdate = useCallback(async (data: Partial<CalendarFeed>) => {
    try {
      setActionLoading("update");
      const res = await api.taskCalendarFeed.update(data);
      setFeed(res.feed);
      toast.success(t("tasks.calendarFeed.updated"));
    } catch {
      toast.error(t("tasks.calendarFeed.error"));
    } finally {
      setActionLoading(null);
    }
  }, [t]);

  const handleDisable = useCallback(async () => {
    if (!window.confirm(t("tasks.calendarFeed.confirmDisable"))) return;
    try {
      setActionLoading("disable");
      await handleUpdate({ enabled: false });
    } finally {
      setActionLoading(null);
    }
  }, [handleUpdate, t]);

  const handleRotate = useCallback(async () => {
    if (!window.confirm(t("tasks.calendarFeed.confirmRotate"))) return;
    try {
      setActionLoading("rotate");
      await api.taskCalendarFeed.rotateToken();
      await loadFeed();
      toast.success(t("tasks.calendarFeed.rotated"));
    } catch {
      toast.error(t("tasks.calendarFeed.error"));
    } finally {
      setActionLoading(null);
    }
  }, [loadFeed, t]);

  // 生成完整绝对 URL（手机系统日历需要完整域名，不能用相对路径）
  const getAbsoluteIcsUrl = useCallback(() => {
    if (!feed?.token) return "";
    const base = getBaseUrl().replace(/\/api$/, "");
    // 如果 getBaseUrl() 返回相对路径（如 "/api"），base 为空，使用 window.location.origin
    const origin = base || (typeof window !== "undefined" ? window.location.origin : "");
    return `${origin}/api/calendar/ics/${feed.token}`;
  }, [feed?.token]);

  // 检测是否为本机地址（手机无法访问）
  const isLocalhost = useCallback((url: string) => {
    return /localhost|127\.0\.0\.1|\[::1\]/.test(url);
  }, []);

  const handleCopy = useCallback(async () => {
    const url = getAbsoluteIcsUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("tasks.calendarFeed.copied"));
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast.success(t("tasks.calendarFeed.copied"));
    }
  }, [getAbsoluteIcsUrl, t]);

  const icsUrl = getAbsoluteIcsUrl();

  if (loading) {
    return (
      <button
        type="button"
        disabled
        className="flex items-center gap-1 px-2 py-1 text-xs text-tx-tertiary rounded-md"
      >
        <Loader2 size={13} className="animate-spin" />
        {t("tasks.calendarFeed.loading")}
      </button>
    );
  }

  // 未启用状态：显示启用按钮
  if (!feed) {
    return (
      <button
        type="button"
        onClick={handleCreate}
        disabled={actionLoading === "create"}
        className="flex items-center gap-1 px-2 py-1 text-xs text-tx-tertiary hover:text-accent-primary rounded-md hover:bg-accent-primary/5 transition-colors"
      >
        {actionLoading === "create" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Calendar size={13} />
        )}
        {t("tasks.calendarFeed.enable")}
      </button>
    );
  }

  // 已启用状态：入口按钮 + fixed modal
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={cn(
          "flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors",
          expanded
            ? "text-accent-primary bg-accent-primary/10"
            : feed.enabled
              ? "text-accent-primary bg-accent-primary/5 hover:bg-accent-primary/10"
              : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover"
        )}
      >
        <Calendar size={13} />
        {t("tasks.calendarFeed.title")}
      </button>

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
            className="relative w-full max-w-sm max-h-[calc(100vh-48px)] overflow-y-auto rounded-2xl border border-app-border bg-app-elevated shadow-2xl p-4 space-y-3"
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-tx-primary">{t("tasks.calendarFeed.title")}</h4>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="p-1 rounded-md text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            {/* 说明 */}
            <p className="text-xs text-tx-tertiary leading-relaxed">
              {t("tasks.calendarFeed.description")}
            </p>

            {/* 状态 */}
            <div className="flex items-center gap-2 text-xs">
              <span className={cn("w-2 h-2 rounded-full", feed.enabled ? "bg-green-500" : "bg-gray-400")} />
              <span className="text-tx-secondary">
                {feed.enabled ? t("tasks.calendarFeed.active") : t("tasks.calendarFeed.disabled")}
              </span>
              {feed.lastAccessedAt && (
                <span className="text-tx-tertiary ml-auto">
                  {t("tasks.calendarFeed.lastAccess")}: {new Date(feed.lastAccessedAt).toLocaleDateString()}
                </span>
              )}
            </div>

            {/* 订阅链接 */}
            <div className="space-y-1">
              <label className="block text-xs text-tx-tertiary">{t("tasks.calendarFeed.link")}</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={icsUrl}
                  className="flex-1 px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-secondary truncate"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-tx-tertiary bg-app-hover rounded-lg hover:bg-app-hover/80 transition-colors"
                >
                  <Copy size={13} />
                </button>
              </div>
              {/* webcal 链接（iOS/macOS 一键订阅） */}
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={icsUrl ? icsUrl.replace(/^https?:\/\//, "webcal://") : ""}
                  className="flex-1 px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-tertiary truncate"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const webcalUrl = icsUrl.replace(/^https?:\/\//, "webcal://");
                    try { await navigator.clipboard.writeText(webcalUrl); toast.success(t("tasks.calendarFeed.copied")); } catch {}
                  }}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-tx-tertiary bg-app-hover rounded-lg hover:bg-app-hover/80 transition-colors"
                >
                  <Copy size={13} />
                </button>
              </div>
              <p className="text-[10px] text-tx-tertiary mt-1">
                {t("tasks.calendarFeed.subscribeHint", { defaultValue: "在 iOS/macOS 日历 app 中选择「添加订阅」并粘贴上方链接" })}
              </p>
              {/* 本机地址警告：手机无法访问 localhost */}
              {isLocalhost(icsUrl) && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                  ⚠️ 当前订阅地址是本机地址，手机系统日历无法访问。请改用公网域名或局域网 IP。
                </p>
              )}
            </div>

            {/* 导出已完成待办 */}
            <label className="flex items-center gap-2.5 cursor-pointer min-h-[32px]">
              <input
                type="checkbox"
                checked={feed.includeCompleted}
                onChange={(e) => handleUpdate({ includeCompleted: e.target.checked })}
                disabled={actionLoading === "update"}
                className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30"
              />
              <span className="text-xs text-tx-secondary">{t("tasks.calendarFeed.includeCompleted")}</span>
            </label>

            {/* 导出描述 */}
            <label className="flex items-center gap-2.5 cursor-pointer min-h-[32px]">
              <input
                type="checkbox"
                checked={feed.includeDescription}
                onChange={(e) => handleUpdate({ includeDescription: e.target.checked })}
                disabled={actionLoading === "update"}
                className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30"
              />
              <span className="text-xs text-tx-secondary">{t("tasks.calendarFeed.includeDescription")}</span>
            </label>

            {/* 默认提醒时间 */}
            <div className="space-y-1">
              <label className="block text-xs text-tx-tertiary">{t("tasks.calendarFeed.defaultAlarm")}</label>
              <select
                value={feed.defaultAlarmMinutes}
                onChange={(e) => handleUpdate({ defaultAlarmMinutes: Number(e.target.value) })}
                disabled={actionLoading === "update"}
                className="w-full px-2.5 py-1.5 text-xs bg-app-bg rounded-lg border border-app-border text-tx-primary focus:ring-accent-primary/30"
              >
                {alarmOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* 操作按钮 */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={handleRotate}
                disabled={actionLoading === "rotate"}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-tx-tertiary hover:text-amber-600 bg-app-hover rounded-lg hover:bg-amber-50 transition-colors disabled:opacity-50"
              >
                {actionLoading === "rotate" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                {t("tasks.calendarFeed.rotate")}
              </button>
              <button
                type="button"
                onClick={handleDisable}
                disabled={actionLoading === "disable"}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-tx-tertiary hover:text-red-600 bg-app-hover rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50 ml-auto"
              >
                {actionLoading === "disable" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                {t("tasks.calendarFeed.disable")}
              </button>
            </div>

            {/* 提示 */}
            <p className="text-[11px] text-tx-tertiary leading-relaxed">
              {t("tasks.calendarFeed.hint")}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
