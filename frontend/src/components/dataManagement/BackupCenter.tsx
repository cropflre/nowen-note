import React, { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, Loader2, AlertCircle, AlertTriangle, HardDrive, RefreshCw, Save, ShieldAlert, Lock, Eye, EyeOff, X, Mail, Send, Settings as SettingsIcon, ChevronDown, ChevronRight, BookOpen, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, withSudo, getServerUrl } from "@/lib/api";
import { isDesktop } from "@/lib/desktopBridge";
import { isElectronFullLocalRuntime } from "@/lib/uploadRequest";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import { runFullBackupJob } from "@/lib/fullBackupJobClient";
import { formatSupportError, formatSupportReference } from "@/lib/supportError";
import { backupWebDavApi } from "@/lib/backupWebDavApi";
import DataProtectionOverview from "./DataProtectionOverview";
import RestoreCenter from "./RestoreCenter";
import AdvancedDataManagement from "./AdvancedDataManagement";

function fmtBytes(n: number | undefined | null): string {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

type BackupStatus = Awaited<ReturnType<typeof api.backup.status>>;
type BackupRow = Awaited<ReturnType<typeof api.backup.list>>[number];
type RestoreDryRun = NonNullable<Awaited<ReturnType<typeof api.backup.restore>>["dryRun"]>;

export default function BackupCenter({ migration, advanced }: { migration: React.ReactNode; advanced: React.ReactNode }) {
  const { t } = useTranslation();
  const locationLabel = t(isElectronFullLocalRuntime(getServerUrl(), isDesktop()) ? "dataManager.overview.local" : "dataManager.overview.server");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [remoteBackups, setRemoteBackups] = useState<Awaited<ReturnType<typeof backupWebDavApi.list>>>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [remoteImporting, setRemoteImporting] = useState(false);
  const [webdav, setWebdav] = useState<Awaited<ReturnType<typeof backupWebDavApi.config>> | null>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"db-only" | "full" | null>(null);
  const [createMsg, setCreateMsg] = useState<{ type: "ok" | "err" | "progress"; text: string } | null>(null);

  // 「导入外部 .bak/.zip」状态独立于 create：它不生成新备份，而是把用户硬盘上
  // 的文件搬进 backupDir 再补 .meta.json。独立 importing 让按钮 loading 态
  // 不会卡住"立即备份"那两个按钮，UI 上也能并行显示。
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 当前用户角色/邮箱：
  //   - isAdmin 决定是否渲染「邮件通道（SMTP）」配置折叠区——SMTP 含凭证，非管理员看不到；
  //   - currentEmail 作为发邮件对话框的默认值，省去管理员手输，降低误发风险。
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentEmail, setCurrentEmail] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => {
        if (cancelled) return;
        setIsAdmin((u as any)?.role === "admin");
        setCurrentEmail((u as any)?.email || "");
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  // 「发送到邮箱」目标备份与对话框状态
  const [sendEmailTarget, setSendEmailTarget] = useState<BackupRow | null>(null);

  // sudoToken 缓存：withSudo 在 SUDO_REQUIRED 时会重新询问密码，
  // 缓存让"备份 → 删除 → 改间隔" 这串连续操作只需输一次密码。
  const sudoTokenRef = useRef<string | null>(null);

  // 自动备份配置区本地状态：避免每次拖滑杆都打 status；只在 status 重载时同步。
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoIntervalHours, setAutoIntervalHours] = useState(24);
  // 调度模式：interval=按间隔小时；daily=每天 HH:mm。默认 interval（兼容旧行为）。
  const [autoMode, setAutoMode] = useState<"interval" | "daily">("interval");
  const [autoDailyAt, setAutoDailyAt] = useState("03:00");
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [autoTimeZone, setAutoTimeZone] = useState(browserTimeZone);
  // 自动备份保留数量，默认 15，范围 1~100。
  const [autoKeepCount, setAutoKeepCount] = useState(15);
  // 自动备份成功后是否发邮件 + 收件人。默认 false；启用时邮箱必填。
  const [autoEmailOnSuccess, setAutoEmailOnSuccess] = useState(false);
  const [autoEmailTo, setAutoEmailTo] = useState("");
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoMsg, setAutoMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 恢复对话框：选中要恢复的备份 + dryRun 预览结果
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 并行拿状态 + 列表，减少首屏等待
      const [s, list] = await Promise.all([api.backup.status(), api.backup.list()]);
      setStatus(s);
      setBackups(list);
      void backupWebDavApi.config().then(setWebdav).catch(() => setWebdav(null));
      // 同步自动备份本地编辑值
      setAutoEnabled(s.autoBackupRunning);
      setAutoIntervalHours(s.autoBackupIntervalHours);
      // 新字段：旧后端不返回这些字段时回退默认值，避免 UI 闪烁
      setAutoMode(s.autoBackupMode === "daily" ? "daily" : "interval");
      setAutoDailyAt(s.autoBackupDailyAt || "03:00");
      // Do not silently shift legacy server-local jobs until the admin saves.
      setAutoTimeZone(s.autoBackupTimeZone || browserTimeZone);
      setAutoKeepCount(typeof s.autoBackupKeepCount === "number" ? s.autoBackupKeepCount : 15);
      setAutoEmailOnSuccess(s.autoBackupEmailOnSuccess === true);
      setAutoEmailTo(s.autoBackupEmailTo || "");
    } catch (err: any) {
      setError(err.message || "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const refresh = () => { void backupWebDavApi.config().then(setWebdav).catch(() => setWebdav(null)); };
    window.addEventListener("nowen-backup-webdav-config-changed", refresh);
    return () => window.removeEventListener("nowen-backup-webdav-config-changed", refresh);
  }, []);

  useEffect(() => {
    if (!restoreOpen || !webdav?.enabled || !webdav.configured) return;
    let cancelled = false;
    setRemoteBackups([]);
    setRemoteLoading(true);
    setRemoteError("");
    backupWebDavApi.list().then((rows) => {
      if (!cancelled) setRemoteBackups(rows);
    }).catch((error) => {
      if (!cancelled) setRemoteError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!cancelled) setRemoteLoading(false); });
    return () => { cancelled = true; };
  }, [restoreOpen, webdav?.enabled, webdav?.configured, webdav?.endpoint, webdav?.remotePath]);

  /**
   * 询问密码弹窗 —— 自定义 Modal（替代浏览器原生 prompt，统一深浅色与产品视觉）。
   *
   * 设计要点：
   *  - askPassword() 返回 Promise<string | null>：
   *      点确定 -> resolve(密码字符串)；点取消/关闭 -> resolve(null)。
   *      withSudo 拿到 null 会直接返回 null，调用方根据 null 判定"用户取消"。
   *  - 状态只放 setSudoAsk（包含 resolve 闭包），密码本身放 sudoPwd state。
   *      关闭时立即清空密码，避免 React state 里残留明文。
   *  - 不在这里调 requestSudoToken：BackupSection 走的是 withSudo(action, askPwd)，
   *      withSudo 内部会自己用密码换 sudoToken；保持职责单一。
   */
  const [sudoAsk, setSudoAsk] = useState<{ resolve: (v: string | null) => void } | null>(null);
  const [sudoPwd, setSudoPwd] = useState("");
  const [sudoShowPwd, setSudoShowPwd] = useState(false);

  const askPassword = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        setSudoPwd("");
        setSudoShowPwd(false);
        setSudoAsk({ resolve });
      }),
    [],
  );

  const closeSudoAsk = useCallback(
    (value: string | null) => {
      sudoAsk?.resolve(value);
      setSudoAsk(null);
      setSudoPwd("");
      setSudoShowPwd(false);
    },
    [sudoAsk],
  );

  const handleCreate = async (type: "db-only" | "full") => {
    setCreating(type);
    setCreateMsg(null);
    try {
      const out = await withSudo<{ filename: string; size: number }>(
        async (tk) => {
          if (type === "full") {
            return runFullBackupJob(
              api.backup.fullJobs,
              tk,
              "数据管理：手动全量备份",
              { onStatus: (text) => setCreateMsg({ type: "progress", text }) },
            );
          }
          return api.backup.create(type, tk);
        },
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        // 用户取消密码框
        setCreating(null);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      setCreateMsg({
        type: "ok",
        text: t("dataManager.backup.createSuccess", {
          filename: out.result.filename,
          size: fmtBytes(out.result.size),
        }),
      });
      await reload();
      if (type === "full") {
        const remote = await backupWebDavApi.config().catch(() => webdav);
        if (remote?.enabled && remote.configured) {
          setCreateMsg({ type: "progress", text: t("dataManager.overview.uploadingRemote") });
          try {
            await backupWebDavApi.upload(out.result.filename, out.sudoToken);
            setCreateMsg({ type: "ok", text: t("dataManager.overview.backupRemoteSuccess") });
          } catch (error) {
            setCreateMsg({ type: "err", text: t("dataManager.overview.remoteFailed", { error: error instanceof Error ? error.message : String(error) }) });
          }
        }
      }
    } catch (err: unknown) {
      const issue = formatSupportError(err, "备份创建失败，请检查服务器日志");
      const reference = formatSupportReference(issue);
      setCreateMsg({
        type: "err",
        text: t("dataManager.backup.createFailed", { error: issue.message })
          + (reference ? `（故障编号：${reference}）` : ""),
      });
    } finally {
      setCreating(null);
    }
  };

  /**
   * 导入外部 .bak / .zip 备份到当前实例的备份仓库。
   *
   * 行为取舍：
   *   - 上传成功后 **不自动进入恢复流程**，只是刷新列表让新备份显现 —— 恢复仍
   *     要管理员自己在列表里点，走 dryRun 预览 + sudo 二次确认。理由是邮件
   *     投递 / 跨机拷贝拿到的备份，管理员 80% 的情况下想先看"这份到底有多少
   *     笔记 / 附件"再下决定，而不是一键覆盖当前库。
   *   - 成功后把 input.value 清空，允许同一个文件重复选择（浏览器默认会静默
   *     吞掉相同文件名的第二次 change）。
   *   - 错误信息直接透传后端 error 字段，便于管理员看到"文件头校验失败 / 格式
   *     版本过高"这类具体原因。
   */
  const handleImport = async (file: File) => {
    setImporting(true);
    setImportMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.backup.upload(file, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        // 用户取消密码框
        setImporting(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      setImportMsg({
        type: "ok",
        text: t("dataManager.backup.importSuccess", {
          filename: out.result.filename,
          size: fmtBytes(out.result.size),
        }),
      });
      reload();
    } catch (err) {
      const issue = formatSupportError(err, "备份导入失败，请检查文件格式或服务器日志");
      const reference = formatSupportReference(issue);
      setImportMsg({
        type: "err",
        text: t("dataManager.backup.importFailed", { error: issue.message })
          + (reference ? `（故障编号：${reference}）` : ""),
      });
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (filename: string) => {
    // 删除虽然不影响业务运行，但同样要 sudo（后端强制）；UI 仍弹 confirm 防误点
    const ok = await confirmDialog({
      title: t("dataManager.backup.deleteConfirm"),
      confirmText: t("common.delete", "删除"),
      danger: true,
    });
    if (!ok) return;
    try {
      const out = await withSudo(
        (tk) => api.backup.remove(filename, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) return;
      sudoTokenRef.current = out.sudoToken;
      reload();
    } catch (err: any) {
      setError(err.message || "delete failed");
    }
  };

  const handleRemoteRestore = async (filename: string) => {
    setRemoteImporting(true);
    setRemoteError("");
    try {
      const out = await withSudo((token) => backupWebDavApi.import(filename, token), askPassword, sudoTokenRef.current);
      if (!out) return;
      sudoTokenRef.current = out.sudoToken;
      const list = await api.backup.list();
      setBackups(list);
      const target = list.find((row) => row.filename === out.result.filename);
      if (!target) throw new Error(t("dataManager.backup.noBackups"));
      setRestoreTarget(target);
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : String(error));
    } finally { setRemoteImporting(false); }
  };

  /** 保存自动备份配置 —— 走 sudo */
  const handleSaveAuto = async (enabled = autoEnabled) => {
    // 启用邮件通知前的本地校验：避免点保存才被后端 400 顶回
    if (enabled && autoEmailOnSuccess) {
      const okMail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(autoEmailTo.trim());
      if (!okMail) {
        setAutoMsg({ type: "err", text: t("dataManager.backup.autoEmailInvalid") });
        return;
      }
    }
    if (autoMode === "daily") {
      try { new Intl.DateTimeFormat("en-US", { timeZone: autoTimeZone }); }
      catch {
        setAutoMsg({ type: "err", text: t("dataManager.backup.invalidTimeZone") });
        return;
      }
    }
    setAutoSaving(true);
    setAutoMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.backup.setAuto(enabled, autoIntervalHours, tk, {
          mode: autoMode,
          dailyAt: autoDailyAt,
          timeZone: autoTimeZone,
          keepCount: autoKeepCount,
          emailOnSuccess: autoEmailOnSuccess,
          emailTo: autoEmailTo.trim(),
        }),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setAutoSaving(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      setAutoMsg({ type: "ok", text: out.result.message });
      // 重新拉一次 status，确保 autoBackupRunning 等字段是后端最新值
      reload();
    } catch (err: any) {
      setAutoMsg({
        type: "err",
        text: t("dataManager.backup.saveAutoFailed", { error: err.message || "error" }),
      });
    } finally {
      setAutoSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <DataProtectionOverview
        loading={loading} available={status !== null && !error}
        healthy={!!status?.backupDirWritable && !status?.degraded && backups.some((b) => b.type === "full")}
        lastBackup={backups.reduce<string | null>((latest, b) => !latest || b.createdAt > latest ? b.createdAt : latest, null)}
        automatic={status?.autoBackupRunning ?? false}
        schedule={!status?.autoBackupRunning ? t("dataManager.backup.autoDisabledLabel") : status.autoBackupMode === "daily" ? `${t("dataManager.overview.daily", { time: status.autoBackupDailyAt || "03:00" })} · ${status.autoBackupTimeZone || status.autoBackupServerTimeZone || "UTC"}` : t("dataManager.overview.interval", { hours: status.autoBackupIntervalHours })}
        location={webdav?.enabled && webdav.configured ? `${locationLabel} / WebDAV` : locationLabel}
        busy={creating !== null} saving={autoSaving}
        onBackup={() => void handleCreate("full")} onRestore={() => setRestoreOpen((open) => !open)}
        onAutomaticChange={(enabled) => void handleSaveAuto(enabled)}
      />
      {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
      {createMsg && <p role="status" className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">{createMsg.text}</p>}
      {autoMsg && <p role="status" className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">{autoMsg.text}</p>}
      {migration}
      <AdvancedDataManagement open={advancedOpen} onToggle={() => setAdvancedOpen((open) => !open)}>
        {/* ===== 健康告警区（按严重度从高到低） ===== */}
        {status && (
          <div className="space-y-2">
            {/* 红：备份目录不可写 —— 根本写不进去 */}
            {!status.backupDirWritable && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40">
                <ShieldAlert size={16} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-semibold text-red-700 dark:text-red-400">
                    {t("dataManager.backup.notWritableTitle")}
                  </div>
                  <div className="text-red-600 dark:text-red-300 mt-0.5">
                    {t("dataManager.backup.notWritableDesc", { dir: status.backupDir })}
                  </div>
                </div>
              </div>
            )}

            {/* 红：链路降级（连续失败/长时间未成功） */}
            {status.degraded && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40">
                <AlertTriangle size={16} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs flex-1 min-w-0">
                  <div className="font-semibold text-red-700 dark:text-red-400">
                    {t("dataManager.backup.degradedTitle")}
                  </div>
                  <div className="text-red-600 dark:text-red-300 mt-0.5">
                    {t("dataManager.backup.degradedDesc")}
                  </div>
                  {status.consecutiveFailures > 0 && (
                    <div className="text-red-600 dark:text-red-300 mt-1">
                      {t("dataManager.backup.consecutiveFailures", { n: status.consecutiveFailures })}
                      {status.lastFailureReason && (
                        <span className="block font-mono text-[11px] mt-0.5 opacity-80 break-all">
                          {status.lastFailureReason}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 黄：同物理卷 —— 不挡正常运行，只是容灾削弱 */}
            {status.sameVolume && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-700/40">
                <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-semibold text-amber-700 dark:text-amber-400">
                    {t("dataManager.backup.sameVolumeTitle")}
                  </div>
                  <div className="text-amber-600 dark:text-amber-300 mt-0.5">
                    {t("dataManager.backup.sameVolumeDesc")}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== 备份目录配置区 ===== */}
        {/*
          为什么单独抽：sameVolume 警告/不可写错误已经在顶部横幅出现，
          管理员看完应该有一个 "立刻能动手切换" 的入口，而不是去改 docker-compose
          重启容器（那对生产环境而言是几分钟的不可用窗口）。

          流程：
            1. 输入候选路径 → 点 "校验" → 调 setDir(dryRun=true) →
               显示 ok/reason/sameVolume/freeBytes；
            2. 校验通过且管理员确认 → 点 "切换" → withSudo + setDir(dryRun=false)；
               切换成功后旧目录文件不会迁移，前端 i18n 文案明确告知。
        */}
        <BackupDirSection
          currentBackupDir={status?.backupDir ?? ""}
          currentDataDir={status?.dataDir ?? ""}
          currentSameVolume={status?.sameVolume ?? false}
          askPassword={askPassword}
          sudoTokenRef={sudoTokenRef}
          onSwitched={() => {
            // 切换成功后重新拉 status —— sameVolume 横幅、可用空间、目录都会更新
            reload();
          }}
        />

        {/* ===== 自动备份配置区 ===== */}
        {/*
          字段持久化由后端 BackupManager 写到 system_settings.backup:auto；
          重启后由 readEffectiveAutoConfig 读出。这里 UI 只负责暴露开关 + 间隔，
          点 "保存" 才真正下发；改完不点保存离开页面则不生效（避免拖滑杆误触发）。
        */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              <RefreshCw size={14} className="text-emerald-500" />
              {t("dataManager.backup.autoConfigTitle")}
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoEnabled}
                onChange={(e) => setAutoEnabled(e.target.checked)}
                className="w-4 h-4 accent-emerald-600"
              />
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                {autoEnabled ? t("dataManager.backup.autoEnabledLabel") : t("dataManager.backup.autoDisabledLabel")}
              </span>
            </label>
          </div>

          <div className={autoEnabled ? "space-y-3" : "opacity-50 pointer-events-none space-y-3"}>
            {/* 调度模式切换：interval（每 N 小时） / daily（每天 HH:mm）。
                旧版本只有 interval，daily 是新增——能精确落在低峰时段，
                避免重启服务后调度被踢出固定节奏。 */}
            <div className="flex items-center gap-3 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="whitespace-nowrap">{t("dataManager.backup.scheduleModeLabel")}</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="auto-backup-mode"
                  value="interval"
                  checked={autoMode === "interval"}
                  onChange={() => setAutoMode("interval")}
                  className="accent-emerald-600"
                  disabled={!autoEnabled}
                />
                <span>{t("dataManager.backup.scheduleModeInterval")}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="auto-backup-mode"
                  value="daily"
                  checked={autoMode === "daily"}
                  onChange={() => setAutoMode("daily")}
                  className="accent-emerald-600"
                  disabled={!autoEnabled}
                />
                <span>{t("dataManager.backup.scheduleModeDaily")}</span>
              </label>
            </div>

            {/* interval 模式：滑块 + 数字 */}
            {autoMode === "interval" && (
              <div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                    {t("dataManager.backup.intervalLabel")}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={168}
                    step={1}
                    value={Math.min(autoIntervalHours, 168)}
                    onChange={(e) => setAutoIntervalHours(Number(e.target.value))}
                    className="flex-1 accent-emerald-600"
                    disabled={!autoEnabled}
                  />
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={autoIntervalHours}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setAutoIntervalHours(Math.max(1, Math.min(720, Math.round(n))));
                    }}
                    className="w-16 px-2 py-1 text-xs text-right rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                    disabled={!autoEnabled}
                  />
                  <span className="text-xs text-zinc-500 whitespace-nowrap">
                    {t("dataManager.backup.intervalUnit")}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  {t("dataManager.backup.intervalHint")}
                </div>
              </div>
            )}

            {/* 显式时间 + IANA 时区，避免 Docker 的 UTC 与管理员本地时间混淆。 */}
            {autoMode === "daily" && (
              <div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                    {t("dataManager.backup.dailyAtLabel")}
                  </label>
                  <input
                    type="time"
                    value={autoDailyAt}
                    onChange={(e) => setAutoDailyAt(e.target.value || "03:00")}
                    className="px-2 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                    disabled={!autoEnabled}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                  <label htmlFor="backup-daily-timezone">{t("dataManager.backup.timeZoneLabel")}</label>
                  <input
                    id="backup-daily-timezone"
                    type="text"
                    list="backup-timezone-suggestions"
                    value={autoTimeZone}
                    onChange={(e) => setAutoTimeZone(e.target.value)}
                    className="w-48 rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                    disabled={!autoEnabled}
                    placeholder="Asia/Shanghai"
                  />
                  <datalist id="backup-timezone-suggestions">
                    {[browserTimeZone, "Asia/Shanghai", "UTC", "Asia/Tokyo", "Europe/London", "America/New_York", "Australia/Sydney"]
                      .filter((value, index, all) => all.indexOf(value) === index)
                      .map((value) => <option key={value} value={value} />)}
                  </datalist>
                </div>
                {status?.autoBackupTimeZone == null && status?.autoBackupRunning && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    {t("dataManager.backup.legacyTimeZoneHint", { timeZone: status.autoBackupServerTimeZone || "UTC" })}
                  </p>
                )}
                {status?.autoBackupNextRunAt && (
                  <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                    {t("dataManager.backup.nextRunLabel")}: {new Date(status.autoBackupNextRunAt).toLocaleString(undefined, {
                      timeZone: status.autoBackupTimeZone || status.autoBackupServerTimeZone || "UTC",
                    })} ({status.autoBackupTimeZone || status.autoBackupServerTimeZone || "UTC"})
                  </p>
                )}
                <div className="text-[11px] text-zinc-400 mt-1">
                  {t("dataManager.backup.dailyAtHint")}
                </div>
              </div>
            )}

            {/* 自动备份按类型保留；手动创建仍只统一清理 db-only，不删除手动 full */}
            <div className="flex items-center gap-3">
              <label className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                {t("dataManager.backup.keepCountLabel")}
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={autoKeepCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setAutoKeepCount(Math.max(1, Math.min(100, Math.round(n))));
                }}
                className="w-20 px-2 py-1 text-xs text-right rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
              />
              <span className="text-[11px] text-zinc-400">
                {t("dataManager.backup.keepCountHint")}
              </span>
            </div>

            {/* 自动发邮件：勾选后必须填合法邮箱；后端在 SMTP 未启用时会静默 skip */}
            <div className="border-t border-zinc-200 dark:border-zinc-700 pt-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoEmailOnSuccess}
                  onChange={(e) => setAutoEmailOnSuccess(e.target.checked)}
                  className="w-4 h-4 accent-emerald-600"
                  disabled={!autoEnabled}
                />
                <span className="text-xs text-zinc-700 dark:text-zinc-300">
                  {t("dataManager.backup.autoEmailLabel")}
                </span>
              </label>
              {autoEmailOnSuccess && (
                <div className="flex items-center gap-2 pl-6">
                  <input
                    type="email"
                    value={autoEmailTo}
                    onChange={(e) => setAutoEmailTo(e.target.value)}
                    placeholder={t("dataManager.backup.autoEmailPlaceholder")}
                    className="flex-1 px-2 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                    disabled={!autoEnabled}
                  />
                </div>
              )}
              <div className="text-[11px] text-zinc-400 pl-6">
                {t("dataManager.backup.autoEmailHint")}
              </div>
            </div>
          </div>

          {autoMsg && (
            <div className={`text-xs flex items-start gap-1 ${autoMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
              {autoMsg.type === "ok" ? <CheckCircle size={12} className="mt-0.5" /> : <AlertCircle size={12} className="mt-0.5" />}
              <span>{autoMsg.text}</span>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={() => void handleSaveAuto()}
              disabled={
                autoSaving ||
                // 没变化就禁用，避免无意义 sudo 弹框：所有可编辑字段都要纳入比对
                (status !== null &&
                  status.autoBackupRunning === autoEnabled &&
                  status.autoBackupIntervalHours === autoIntervalHours &&
                  (status.autoBackupMode ?? "interval") === autoMode &&
                  (status.autoBackupDailyAt ?? "03:00") === autoDailyAt &&
                  (autoMode !== "daily" || status.autoBackupTimeZone === autoTimeZone) &&
                  (status.autoBackupKeepCount ?? 15) === autoKeepCount &&
                  (status.autoBackupEmailOnSuccess ?? false) === autoEmailOnSuccess &&
                  (status.autoBackupEmailTo ?? "") === autoEmailTo.trim())
              }
              className={`flex items-center justify-center py-1.5 px-3 rounded-lg text-xs font-medium transition-all ${autoSaving
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
                }`}
            >
              {autoSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  {t("dataManager.backup.savingAuto")}
                </>
              ) : (
                t("dataManager.backup.saveAuto")
              )}
            </button>
          </div>
        </div>

        {/* ===== 立即备份按钮 =====
            布局取舍：
              - 之前用 grid-cols-3 等宽，导致中文最长的"立即备份（仅数据库）"被强制换行，
                整行按钮变成两倍高、视觉破败。
              - 改成 flex-wrap：每个按钮按内容自适应宽度（min-w-0 + flex-1 让它们尽量分摊宽度），
                文字加 whitespace-nowrap 严禁换行；窄屏（<sm）回退为竖排堆叠。
              - 统一固定按钮高度 h-9，避免 loading/正常态切换时高度跳动。 */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <button
            onClick={() => handleCreate("db-only")}
            disabled={creating !== null}
            className={`flex-1 min-w-0 sm:min-w-[10rem] h-9 flex items-center justify-center px-3 rounded-lg font-medium text-sm whitespace-nowrap transition-all ${creating !== null
              ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
              : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
              }`}
          >
            {creating === "db-only" ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin flex-shrink-0" />
                <span className="truncate">{t("dataManager.backup.creating")}</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-1.5 flex-shrink-0" />
                <span className="truncate">{t("dataManager.backup.createDb")}</span>
              </>
            )}
          </button>
        </div>
        <div data-nowen-backup-webdav-host="true" />
        {isAdmin && <SmtpConfigSection askPassword={askPassword} sudoTokenRef={sudoTokenRef} />}
        {advanced}
      </AdvancedDataManagement>

      {restoreOpen && <RestoreCenter
        backups={backups} remoteBackups={webdav?.enabled ? remoteBackups : []} locationLabel={locationLabel}
        remoteLoading={remoteLoading} remoteError={remoteError} busy={remoteImporting || importing || creating !== null}
        importMessage={importMsg?.text ?? null} advanced={advancedOpen}
        onRefresh={() => { void reload(); if (webdav?.enabled && webdav.configured) { setRemoteLoading(true); setRemoteError(""); void backupWebDavApi.list().then(setRemoteBackups).catch((error) => setRemoteError(error instanceof Error ? error.message : String(error))).finally(() => setRemoteLoading(false)); } }}
        onFile={(file) => void handleImport(file)} onRestore={setRestoreTarget}
        onRemoteRestore={(filename) => void handleRemoteRestore(filename)} onDelete={(filename) => void handleDelete(filename)} onEmail={setSendEmailTarget}
      />}

      {/* ===== 发送到邮箱 对话框 ===== */}
      {sendEmailTarget && (
        <BackupSendEmailDialog
          target={sendEmailTarget}
          defaultTo={currentEmail}
          onClose={() => setSendEmailTarget(null)}
          askPassword={askPassword}
          sudoTokenRef={sudoTokenRef}
          onSent={reload}
        />
      )}

      {/* ===== 恢复对话框（高危） ===== */}
      {restoreTarget && (
        <BackupRestoreDialog
          target={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onSuccess={() => {
            setRestoreTarget(null);
            // 重启后刷新页面让用户登录新会话；先 reload 状态以便看到 lastSuccessAt 等
            reload();
          }}
          askPassword={askPassword}
          sudoTokenRef={sudoTokenRef}
        />
      )}

      {/* ===== 自定义 sudo 密码确认 Modal =====
          替代原生 window.prompt：
            - 视觉与产品深浅色统一，移除浏览器顶部"localhost:5173 显示"的尴尬抬头；
            - 密码框默认隐藏可一键切换显隐；
            - 支持 Esc 关闭、回车提交，遮罩点击取消；
            - 关闭时务必 resolve(null)，避免 withSudo 永远挂起。 */}
      <AnimatePresence>
        {sudoAsk && (
          <motion.div
            key="sudo-ask"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            {/* 半透明遮罩 */}
            <div
              className="absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
              onClick={() => closeSudoAsk(null)}
            />
            <motion.form
              initial={{ scale: 0.95, y: 10, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 10, opacity: 0 }}
              transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (!sudoPwd) return;
                closeSudoAsk(sudoPwd);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSudoAsk(null);
                }
              }}
              className="relative w-full max-w-md bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
            >
              {/* 标题栏 */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
                <h4 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  <Lock className="w-3.5 h-3.5 text-amber-500" />
                  {t("dataManager.backup.sudoTitle") || "身份验证"}
                </h4>
                <button
                  type="button"
                  onClick={() => closeSudoAsk(null)}
                  className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  aria-label="close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* 内容 */}
              <div className="p-5 space-y-3">
                {/* 提示横幅：复用现有 sudoPrompt 文案，带 amber 警示色 */}
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50/70 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-700/40 text-amber-700 dark:text-amber-300 text-xs leading-relaxed">
                  <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    {t("dataManager.backup.sudoPrompt") ||
                      "请输入当前密码以确认本次备份/恢复操作（5 分钟内连续操作只需输一次）"}
                  </span>
                </div>

                {/* 密码输入：左侧 lock 图标 + 右侧显隐切换按钮 */}
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {t("dataManager.backup.sudoPasswordLabel") || "当前密码"}
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Lock className="w-3.5 h-3.5 text-zinc-400" />
                  </div>
                  <input
                    type={sudoShowPwd ? "text" : "password"}
                    value={sudoPwd}
                    onChange={(e) => setSudoPwd(e.target.value)}
                    placeholder={t("dataManager.backup.sudoPasswordPlaceholder") || "输入登录密码"}
                    autoFocus
                    autoComplete="current-password"
                    className="block w-full pl-9 pr-10 py-2.5 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setSudoShowPwd((v) => !v)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                    tabIndex={-1}
                    aria-label={sudoShowPwd ? "hide password" : "show password"}
                  >
                    {sudoShowPwd ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => closeSudoAsk(null)}
                    className="px-3.5 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
                  >
                    {t("common.cancel") || "取消"}
                  </button>
                  <button
                    type="submit"
                    disabled={!sudoPwd}
                    className="px-3.5 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    {t("common.confirm") || "确定"}
                  </button>
                </div>
              </div>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

// ============================================================================
// 备份恢复对话框 —— 两步走：dryRun 预览 → sudo 验证 → 真正恢复
// ----------------------------------------------------------------------------
// 为什么单独抽组件：
//  1. 状态机较复杂（dryRun loading / 已预览 / 正在恢复 / 已恢复），塞在
//     BackupSection 里会让父组件 useState 数量翻倍；
//  2. 弹窗内部的多步骤交互可以独立卸载，关掉对话框就丢光中间态，避免泄漏；
//  3. 后续若要把恢复入口从备份页移到通知中心、或独立出"灾难恢复向导"，
//     抽出来更易复用。
//
// **极强警告语**：恢复=覆盖整库，包括其他用户的数据；后端会在覆盖前先做安全
// 备份（见 BackupManager.restoreFromDbOnly / restoreFromZip），即使误恢复也
// 可以从 .pre-restore.bak 二次回滚，但 UI 仍要把这一行影响范围讲明白。
// ============================================================================
function BackupRestoreDialog(props: {
  target: BackupRow;
  onClose: () => void;
  onSuccess: () => void;
  askPassword: () => string | null | Promise<string | null>;
  sudoTokenRef: React.MutableRefObject<string | null>;
}) {
  const { target, onClose, onSuccess, askPassword, sudoTokenRef } = props;
  const { t } = useTranslation();
  const [stage, setStage] = useState<"loading" | "preview" | "restoring" | "done" | "error">("loading");
  const [dryRun, setDryRun] = useState<RestoreDryRun | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [errorReference, setErrorReference] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // 进入对话框立刻调 dryRun 拿预览
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.backup.restore(target.filename, true);
        if (cancelled) return;
        if (!res.success || !res.dryRun) {
          setErrorMsg(res.error || "preview failed");
          setStage("error");
          return;
        }
        setDryRun(res.dryRun);
        setStage("preview");
      } catch (err: unknown) {
        if (cancelled) return;
        const issue = formatSupportError(err, "备份预检失败，请根据故障编号检查服务器日志");
        setErrorMsg(issue.message);
        setErrorReference(formatSupportReference(issue));
        setStage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.filename]);

  const handleConfirm = async () => {
    if (!confirmed) return;
    setStage("restoring");
    setErrorMsg("");
    setErrorReference(null);
    try {
      const out = await withSudo(
        (tk) => api.backup.restore(target.filename, false, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        // 用户在密码框点了取消
        setStage("preview");
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      if (!out.result.success) {
        setErrorMsg(out.result.error || "restore failed");
        setStage("error");
        return;
      }
      setStage("done");
      // 给用户 2.5 秒看到"恢复成功，请重启"提示后再回到列表
      setTimeout(() => onSuccess(), 2500);
    } catch (err: unknown) {
      const issue = formatSupportError(err, "恢复失败；如已开始恢复，请勿重复提交，请先检查服务器日志");
      setErrorMsg(issue.message);
      setErrorReference(formatSupportReference(issue));
      setStage("error");
    }
  };

  // 计算总影响行数（dryRun 时用）
  const totalClear = dryRun?.tables.reduce((s, t2) => s + t2.willClear, 0) ?? 0;
  const totalInsert = dryRun?.tables.reduce((s, t2) => s + t2.willInsert, 0) ?? 0;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
      >
        {/* 标题区 */}
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
          <ShieldAlert size={18} className="text-amber-500" />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {t("dataManager.backup.restoreTitle")}
          </h3>
          <span className="ml-auto text-[11px] font-mono text-zinc-500 truncate max-w-[260px]" title={target.filename}>
            {new Date(target.createdAt).toLocaleString()}
          </span>
        </div>

        {/* 高危横幅 */}
        <div className="px-5 py-3 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-700/40 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">{t("dataManager.backup.restoreDangerTitle")}</div>
            <div className="mt-0.5">{t("dataManager.backup.restoreDangerDesc")}</div>
          </div>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {stage === "loading" && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 size={14} className="animate-spin" />
              {t("dataManager.backup.restoreLoadingPreview")}
            </div>
          )}

          {(stage === "preview" || stage === "restoring") && dryRun && (
            <>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                  <div className="text-zinc-500 mb-0.5">{t("dataManager.backup.willClear")}</div>
                  <div className="font-semibold text-red-600 dark:text-red-400">{totalClear.toLocaleString()}</div>
                </div>
                <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                  <div className="text-zinc-500 mb-0.5">{t("dataManager.backup.willInsert")}</div>
                  <div className="font-semibold text-emerald-600 dark:text-emerald-400">{totalInsert.toLocaleString()}</div>
                </div>

              </div>

              <div className="text-xs text-zinc-500 mt-1">
                {t("dataManager.backup.fileBundle", {
                  attachments: dryRun.files.attachments,
                  fonts: dryRun.files.fonts,
                  plugins: dryRun.files.plugins,
                })}
              </div>

              {(dryRun.backupType === "db-only" || target.type === "db-only") && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                  <div>
                    <div className="font-semibold text-amber-700 dark:text-amber-300">
                      {t("dataManager.backup.dbOnlyRestoreWarningTitle")}
                    </div>
                    <div className="mt-0.5 text-amber-700/90 dark:text-amber-300/90">
                      {t("dataManager.backup.dbOnlyRestoreWarningDesc")}
                    </div>
                  </div>
                </div>
              )}

              {dryRun.attachmentAudit && (
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/70 dark:bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
                  {t("dataManager.backup.attachmentAuditSummary", {
                    archive: dryRun.attachmentAudit.archiveCount,
                    rows: dryRun.attachmentAudit.dbRows,
                    paths: dryRun.attachmentAudit.dbDistinctPaths,
                  })}
                </div>
              )}

              {/* 表级明细：只显示净变化 != 0 的，避免一屏几十张表全 0 */}
              <details className="text-xs text-zinc-500"><summary>{t("dataManager.overview.restoreDetails")}</summary>
              <div className="border border-zinc-200 dark:border-zinc-700 rounded overflow-hidden">
                <div className="text-[11px] font-semibold text-zinc-500 px-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/50 grid grid-cols-[1fr_auto_auto] gap-3">
                  <span>{t("dataManager.backup.tableName")}</span>
                  <span className="text-right w-20">{t("dataManager.backup.colClear")}</span>
                  <span className="text-right w-20">{t("dataManager.backup.colInsert")}</span>
                </div>
                <div className="max-h-48 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
                  {dryRun.tables
                    .filter((tb) => tb.willClear || tb.willInsert)
                    .map((tb) => (
                      <div
                        key={tb.name}
                        className="text-[11px] px-3 py-1 grid grid-cols-[1fr_auto_auto] gap-3 font-mono text-zinc-700 dark:text-zinc-300"
                      >
                        <span className="truncate" title={tb.name}>{tb.name}</span>
                        <span className="text-right w-20 text-red-500">{tb.willClear || ""}</span>
                        <span className="text-right w-20 text-emerald-600">{tb.willInsert || ""}</span>
                      </div>
                    ))}
                </div>
              </div>

              </details>
              <label className="flex items-start gap-2 pt-2 text-xs text-zinc-600 dark:text-zinc-400">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 accent-amber-600" />
                <span>{t("dataManager.overview.restoreConfirm")}</span>
              </label>
            </>
          )}

          {stage === "done" && (
            <div className="flex flex-col items-center justify-center py-6 gap-2 text-center">
              <CheckCircle size={32} className="text-emerald-500" />
              <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                {t("dataManager.backup.restoreDoneTitle")}
              </div>
              <div className="text-xs text-zinc-500">
                {t("dataManager.backup.restoreDoneDesc")}
              </div>
            </div>
          )}

          {stage === "error" && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">{t("dataManager.backup.restoreFailed")}</div>
                <div className="text-xs mt-0.5 break-all">{errorMsg}</div>
                {errorReference && (
                  <button type="button"
                    title="复制故障编号"
                    className="mt-2 text-xs underline underline-offset-2"
                    onClick={() => {
                      if (!navigator.clipboard?.writeText) {
                        window.prompt("复制故障编号", errorReference);
                        return;
                      }
                      void navigator.clipboard.writeText(errorReference);
                    }}
                  >
                    故障编号：{errorReference}（点击复制）
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底栏 */}
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          {stage !== "done" && (
            <button
              onClick={onClose}
              disabled={stage === "restoring"}
              className="px-3 py-1.5 text-xs rounded border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              {t("dataManager.backup.cancel")}
            </button>
          )}
          {stage === "preview" && (
            <button
              onClick={handleConfirm}
              disabled={!confirmed}
              className={`px-3 py-1.5 text-xs rounded font-semibold flex items-center gap-1.5 ${confirmed
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-zinc-200 dark:bg-zinc-700 text-zinc-400 cursor-not-allowed"
                }`}
            >
              <ShieldAlert size={12} />
              {t("dataManager.backup.confirmRestore")}
            </button>
          )}
          {stage === "restoring" && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 size={12} className="animate-spin" />
              {t("dataManager.backup.restoring")}
            </div>
          )}
          {stage === "error" && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded bg-zinc-600 hover:bg-zinc-700 text-white"
            >
              {t("dataManager.backup.close")}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================================
// 备份目录配置区 —— 让管理员在 UI 直接切换 backupDir，不必改 docker-compose
// ----------------------------------------------------------------------------
// 设计要点：
//  1. 双行布局：上面显示 "当前备份目录 / 数据目录"，下面是 "新路径输入 + 校验/切换"。
//     不把切换塞进同一个目录展示卡里，是因为切换是低频高风险操作，需要明显视觉
//     分割（折叠面板/独立卡片二选一，这里选了独立卡片避免多一次点击）。
//  2. 校验是 dryRun 调用，无需 sudo —— 用户改路径时可能多次试探，反复弹密码框
//     体验极差；真正切换才走 sudo。
//  3. 切换不迁移历史备份文件：在按钮 hint 和成功提示里都讲清楚，让管理员知道
//     需要时手动 docker exec cp（避免 GUI 触发几十 GB IO 风暴）。
//  4. 同卷警告以橙色而非红色显示——后端不会因 sameVolume=true 拒绝切换
//     （比如管理员就是要换到同卷的另一个目录），但要让用户清楚这一点没解决核心问题。
// ============================================================================
function BackupDirSection(props: {
  currentBackupDir: string;
  currentDataDir: string;
  currentSameVolume: boolean;
  askPassword: () => string | null | Promise<string | null>;
  sudoTokenRef: React.MutableRefObject<string | null>;
  onSwitched: () => void;
}) {
  const { currentBackupDir, currentDataDir, currentSameVolume, askPassword, sudoTokenRef, onSwitched } = props;
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  // checkResult：dryRun 校验的最近一次结果。null 表示用户还没校验过。
  const [checkResult, setCheckResult] = useState<{
    ok: boolean;
    resolved: string;
    sameVolume?: boolean;
    freeBytes?: number | null;
    reason?: string;
    message?: string;
  } | null>(null);
  const [opMsg, setOpMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 输入变化时把上次校验结果清空 —— 否则用户改了路径却看到旧的"通过"会误以为新路径也 OK
  useEffect(() => {
    setCheckResult(null);
    setOpMsg(null);
  }, [input]);

  const handleCheck = async () => {
    if (!input.trim()) return;
    setChecking(true);
    setCheckResult(null);
    setOpMsg(null);
    try {
      const res = await api.backup.setDir(input.trim(), true);
      setCheckResult(res);
    } catch (err: any) {
      // 后端 400 时也走 catch（request() 会把 4xx 抛错）。
      // 把 message 透出给用户，便于看到 "目录不可写" 等具体原因。
      setCheckResult({
        ok: false,
        resolved: input.trim(),
        message: err?.message || "check failed",
      });
    } finally {
      setChecking(false);
    }
  };

  const handleSwitch = async () => {
    if (!checkResult?.ok) return;
    // 二次 confirm —— 这是会影响所有未来备份位置的全局操作
    const ok = await confirmDialog({
      title: t("dataManager.backup.dirSwitchConfirm", { path: checkResult.resolved }),
      danger: true,
    });
    if (!ok) {
      return;
    }
    setSwitching(true);
    setOpMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.backup.setDir(input.trim(), false, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setSwitching(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      if (!out.result.ok) {
        setOpMsg({ type: "err", text: out.result.message || "switch failed" });
        setSwitching(false);
        return;
      }
      setOpMsg({ type: "ok", text: t("dataManager.backup.dirSwitchSuccess", { path: out.result.resolved }) });
      setInput("");
      setCheckResult(null);
      onSwitched();
    } catch (err: any) {
      setOpMsg({ type: "err", text: err?.message || "switch failed" });
    } finally {
      setSwitching(false);
    }
  };

  // 是否处于"已校验通过、可以切换"的活跃状态——用于决定是否展开切换面板
  const canSwitch = checkResult?.ok === true;

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-4 space-y-4">
      {/* —— 标题 —— */}
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
        <HardDrive size={14} className="text-emerald-500" />
        {t("dataManager.backup.dirConfigTitle")}
      </div>

      {/* —— 当前生效值（双栏） —— */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-800/40 px-3 py-2">
          <div className="text-[11px] text-zinc-500 mb-1">{t("dataManager.backup.currentBackupDir")}</div>
          <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 truncate" title={currentBackupDir}>
            {currentBackupDir || "—"}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-800/40 px-3 py-2">
          <div className="text-[11px] text-zinc-500 mb-1">{t("dataManager.backup.currentDataDir")}</div>
          <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 truncate" title={currentDataDir}>
            {currentDataDir || "—"}
          </div>
        </div>
      </div>

      {/* —— 同卷警告 —— */}
      {currentSameVolume && (
        <div className="flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-700/40 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          <span>{t("dataManager.backup.dirSameVolumeHint")}</span>
        </div>
      )}

      {/* —— 输入 + 校验 —— */}
      <div className="space-y-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
        <label className="text-xs text-zinc-600 dark:text-zinc-400 block">
          {t("dataManager.backup.dirInputLabel")}
        </label>
        {/* 用 group 让 input 与 校验按钮 视觉融合（同高、共享圆角、加 focus 整体高亮） */}
        <div className="flex items-stretch h-9 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 focus-within:ring-2 focus-within:ring-emerald-500 focus-within:border-transparent overflow-hidden">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("dataManager.backup.dirInputPlaceholder") || "/mnt/backup-volume"}
            disabled={checking || switching}
            className="flex-1 min-w-0 px-3 text-xs font-mono bg-transparent text-zinc-800 dark:text-zinc-200 focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={handleCheck}
            disabled={!input.trim() || checking || switching}
            className="px-3.5 text-xs font-medium border-l border-zinc-300 dark:border-zinc-600 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap"
          >
            {checking ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
            {checking ? t("dataManager.backup.dirChecking") : t("dataManager.backup.dirCheck")}
          </button>
        </div>

        {/* —— 校验结果 —— */}
        {checkResult && (
          checkResult.ok ? (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-700/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-xs space-y-1.5">
              <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-semibold">
                <CheckCircle size={12} />
                {t("dataManager.backup.dirCheckOk")}
              </div>
              <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 break-all leading-snug">
                → {checkResult.resolved}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                <span>
                  {t("dataManager.backup.freeSpace")}:{" "}
                  <span className="font-semibold">{fmtBytes(checkResult.freeBytes ?? 0)}</span>
                </span>
                {checkResult.sameVolume && (
                  <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <AlertTriangle size={11} />
                    {t("dataManager.backup.dirCheckSameVolume")}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-red-200 dark:border-red-700/40 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-xs space-y-1">
              <div className="flex items-center gap-1.5 text-red-700 dark:text-red-400 font-semibold">
                <AlertCircle size={12} />
                {t("dataManager.backup.dirCheckFailed")}
              </div>
              <div className="text-red-600 dark:text-red-300 break-all leading-snug">
                {checkResult.message || checkResult.reason}
              </div>
            </div>
          )
        )}

        {/* —— 操作结果 —— */}
        {opMsg && (
          <div
            className={`flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-xs ${opMsg.type === "ok"
              ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700/40"
              : "bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-300 border border-red-200 dark:border-red-700/40"
              }`}
          >
            {opMsg.type === "ok" ? (
              <CheckCircle size={12} className="mt-0.5 flex-shrink-0" />
            ) : (
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
            )}
            <span className="break-all leading-snug">{opMsg.text}</span>
          </div>
        )}

        {/* —— 切换面板：仅当校验通过时才显示，避免按钮"灰着挡视线"的问题 —— */}
        {canSwitch && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-700/40 bg-amber-50/60 dark:bg-amber-500/5 p-3 space-y-2.5">
            <div className="flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              <span>{t("dataManager.backup.dirMigrateHint")}</span>
            </div>
            <button
              onClick={handleSwitch}
              disabled={switching}
              className={`w-full flex items-center justify-center py-2 px-3 rounded-lg text-xs font-medium transition-all ${switching
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                : "bg-amber-600 hover:bg-amber-700 text-white shadow-sm"
                }`}
            >
              {switching ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  {t("dataManager.backup.dirSwitching")}
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3.5 h-3.5 mr-1.5" />
                  {t("dataManager.backup.dirSwitch")}
                </>
              )}
            </button>
          </div>
        )}

        {/* 校验未通过时只露一行小提示，不占大块视觉 */}
        {!canSwitch && !checkResult && (
          <div className="text-[11px] text-zinc-500 leading-snug pt-0.5">
            {t("dataManager.backup.dirMigrateHint")}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 发送备份到邮箱 —— 对话框
// ----------------------------------------------------------------------------
// 为什么要单独对话框：
//   1. 发邮件触达互联网，必须让管理员先确认收件地址（从默认的"自己邮箱"改成别的
//      地址是一个有意识的动作，不能一键误发给错误对象）；
//   2. 附件上限 25 MB 的拦截在后端，UI 层提前做一次大小检查，避免把备份读进内存后
//      才被后端拒；同时在"正在发送"态把按钮禁用，避免双击重发；
//   3. 后端成功返回的 SMTP lastResponse（形如 "250 Ok: queued as xxx"）直接 toast，
//      能让管理员对"邮件是不是真的被服务器收下"有确定感，比单纯 "发送成功" 可信。
// ============================================================================
function BackupSendEmailDialog(props: {
  target: BackupRow;
  defaultTo: string;
  onClose: () => void;
  askPassword: () => Promise<string | null>;
  sudoTokenRef: React.MutableRefObject<string | null>;
  /** 发送成功（尤其在 createNew 情况下）后触发，用于让上层刷新备份列表。 */
  onSent?: () => void;
}) {
  const { t } = useTranslation();
  const { target, defaultTo, onClose, askPassword, sudoTokenRef, onSent } = props;
  const [to, setTo] = useState(defaultTo);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 附件格式：
  //   - "current"：直接发当前这条备份（zip 或 .bak，取决于 target.type）
  //   - "full"   ：请求后端现场新建一份 .zip 全量备份再发送
  //   - "db-only"：请求后端现场新建一份 .bak 数据库快照再发送
  // 说明：当用户选了一个"生成"选项，但所选格式恰好等于当前备份格式时，
  //      前端不做聪明降级——后端照单生成，这样用户能拿到一份"新时间戳"的备份，
  //      并与邮件投递时间一致，符合"每次发送 = 一次独立归档"的预期。
  type SendFormat = "current" | "full" | "db-only";
  const [format, setFormat] = useState<SendFormat>("current");

  // 前端硬拦截上限（与后端 EMAIL_ATTACHMENT_LIMIT 保持一致，25MB）
  const ATTACH_LIMIT = 25 * 1024 * 1024;
  // 只有"发送当前备份"时才能预知大小；选"生成新备份"时大小未知，
  // 超限由后端 413 再拦，不在前端硬拒——避免阻塞合理的小库全量备份。
  const tooLarge = format === "current" && target.size > ATTACH_LIMIT;

  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim());

  const handleSend = async () => {
    if (!emailValid || sending || tooLarge) return;
    setSending(true);
    setMsg(null);
    try {
      const out = await withSudo(
        (tk) =>
          api.backup.sendEmail(
            target.filename,
            to.trim(),
            tk,
            note.trim() || undefined,
            format, // "current" | "full" | "db-only"
          ),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        // 用户取消 sudo
        setSending(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      const sentName = out.result.filename || target.filename;
      setMsg({
        type: "ok",
        text: out.result.generatedNew
          ? t("dataManager.backup.sendEmailGeneratedSuccess", {
            filename: sentName,
            to: to.trim(),
            resp: out.result.lastResponse || "",
          })
          : t("dataManager.backup.sendEmailSuccess", {
            to: to.trim(),
            resp: out.result.lastResponse || "",
          }),
      });
      // 生成了新备份时，通知上层刷新列表；发送当前备份时不需要
      if (out.result.generatedNew && onSent) onSent();
    } catch (err: any) {
      setMsg({
        type: "err",
        text: t("dataManager.backup.sendEmailFailed", { error: err?.message || "error" }),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key="send-email"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[65] flex items-center justify-center p-4"
      >
        <div
          className="absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
        <motion.div
          initial={{ scale: 0.95, y: 10, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.95, y: 10, opacity: 0 }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
          className="relative w-full max-w-md bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              <Mail className="w-3.5 h-3.5 text-sky-500" />
              {t("dataManager.backup.sendEmailTitle")}
            </h4>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-5 space-y-3">
            {/* 备份摘要 */}
            <div className="text-xs text-zinc-600 dark:text-zinc-400 p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-800 space-y-0.5">
              <div className="font-mono truncate" title={target.filename}>{target.filename}</div>
              <div className="opacity-70">
                {target.type} · {fmtBytes(target.size)} · {new Date(target.createdAt).toLocaleString()}
              </div>
            </div>

            {/* 附件格式选择
                 - 当前备份：直接发 target 本身；
                 - full(.zip)：数据库 + 附件 + 字体 + 插件 + 密钥，真正"全家桶"；
                 - db-only(.bak)：仅 SQLite 快照，附件会丢，但体积最小最适合邮件。
                "生成"两项会在后端顺手落成一条新备份，相当于"邮件发送 = 一次归档"。*/}
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("dataManager.backup.sendEmailFormat")}
              </label>
              <div className="grid grid-cols-1 gap-1.5">
                {([
                  {
                    val: "current" as const,
                    label: t("dataManager.backup.sendEmailFormatCurrent", {
                      type: target.type,
                      size: fmtBytes(target.size),
                    }),
                    hint: t("dataManager.backup.sendEmailFormatCurrentHint"),
                  },
                  {
                    val: "full" as const,
                    label: t("dataManager.backup.sendEmailFormatFull"),
                    hint: t("dataManager.backup.sendEmailFormatFullHint"),
                  },
                  {
                    val: "db-only" as const,
                    label: t("dataManager.backup.sendEmailFormatDbOnly"),
                    hint: t("dataManager.backup.sendEmailFormatDbOnlyHint"),
                  },
                ]).map((opt) => (
                  <label
                    key={opt.val}
                    className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition ${format === opt.val
                      ? "border-sky-400 dark:border-sky-500/60 bg-sky-50 dark:bg-sky-500/10"
                      : "border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                      }`}
                  >
                    <input
                      type="radio"
                      name="send-email-format"
                      value={opt.val}
                      checked={format === opt.val}
                      onChange={() => setFormat(opt.val)}
                      className="mt-0.5 accent-sky-600"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-medium text-zinc-800 dark:text-zinc-200">
                        {opt.label}
                      </span>
                      <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                        {opt.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* 超大提示（仅"发送当前备份"时按 target.size 预判） */}
            {tooLarge && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300 text-xs leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{t("dataManager.backup.sendEmailTooLarge")}</span>
              </div>
            )}

            {/* 收件人 */}
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("dataManager.backup.sendEmailTo")}
              </label>
              <input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
              />
              {!emailValid && to && (
                <div className="text-[11px] text-red-500 mt-1">
                  {t("dataManager.backup.sendEmailInvalid")}
                </div>
              )}
            </div>

            {/* 备注（可选） */}
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("dataManager.backup.sendEmailNote")}
                <span className="opacity-60 ml-1 font-normal">
                  ({t("dataManager.backup.sendEmailNoteOptional")})
                </span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                rows={2}
                maxLength={500}
                placeholder={t("dataManager.backup.sendEmailNotePlaceholder")}
                className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500 resize-none"
              />
            </div>

            {/* 结果 */}
            {msg && (
              <div
                className={`flex items-start gap-2 p-2.5 rounded-lg text-xs leading-relaxed ${msg.type === "ok"
                  ? "bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-700/40 text-emerald-700 dark:text-emerald-300"
                  : "bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300"
                  }`}
              >
                {msg.type === "ok" ? (
                  <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                )}
                <span className="break-all">{msg.text}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 bg-zinc-50 dark:bg-zinc-900/40 border-t border-zinc-100 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
            >
              {t("common.close") || "关闭"}
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={!emailValid || sending || tooLarge}
              className="px-3.5 py-1.5 text-xs rounded-lg bg-sky-600 hover:bg-sky-700 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
            >
              {sending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              {t("dataManager.backup.sendEmailBtn")}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ============================================================================
// SMTP 常见邮箱速查 / 教程入口（管理员）
// ----------------------------------------------------------------------------
// 为什么内置这块：
//   - docs/backup-email-smtp.md 是完整文档，但"部署在内网 / 断网运维"的管理员
//     点不到 GitHub；把最关键的速查表（主机/端口/TLS/密码来源）内联到前端，
//     保证**不联网也能配通**常见的 QQ/163/Gmail/Outlook；
//   - 同时给一个"查看完整教程"的外链（GitHub docs），能联网的用户一键跳走看
//     详细点击路径、授权码生成步骤、故障排查；
//   - 刻意做成默认折叠，避免老手每次看到一长串说明。
// ============================================================================
function SmtpProviderGuide() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);

  // 速查表按"中文环境优先本地邮箱，英文环境优先国际邮箱"的顺序排列，
  // 让第一眼看到的就是当前用户最可能用的那家。
  const zhFirst = i18n.language?.toLowerCase().startsWith("zh");
  type Row = {
    name: string;
    host: string;
    port: string;
    tls: "on" | "off" | "465on-587off";
    passNote: string; // 密码来源的一句话说明，已翻译
  };
  const cn: Row[] = [
    { name: "QQ", host: "smtp.qq.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passAuthCodeQQ") },
    { name: "163", host: "smtp.163.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passAuthCode163") },
    { name: "126", host: "smtp.126.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passAuthCode163") },
    { name: "exmail", host: "smtp.exmail.qq.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passClientPass") },
  ];
  const intl: Row[] = [
    { name: "Gmail", host: "smtp.gmail.com", port: "465 / 587", tls: "465on-587off", passNote: t("dataManager.smtp.guide.passAppPassword") },
    { name: "Outlook", host: "smtp.office365.com", port: "587", tls: "off", passNote: t("dataManager.smtp.guide.passAppPassword") },
    { name: "Yahoo", host: "smtp.mail.yahoo.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passAppPassword") },
  ];
  const rows: Row[] = zhFirst ? [...cn, ...intl] : [...intl, ...cn];

  const tlsLabel = (v: Row["tls"]) =>
    v === "on"
      ? t("dataManager.smtp.guide.tlsOn")
      : v === "off"
        ? t("dataManager.smtp.guide.tlsOff")
        : t("dataManager.smtp.guide.tlsDepends");

  const docUrl = "https://github.com/cropflre/nowen-note/blob/main/docs/backup-email-smtp.md";

  return (
    <div className="rounded-lg border border-sky-200/70 dark:border-sky-500/30 bg-sky-50/60 dark:bg-sky-500/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={14} className="text-sky-600 dark:text-sky-400" />
        ) : (
          <ChevronRight size={14} className="text-sky-600 dark:text-sky-400" />
        )}
        <BookOpen size={14} className="text-sky-600 dark:text-sky-400" />
        <span className="text-xs font-medium text-sky-800 dark:text-sky-200">
          {t("dataManager.smtp.guide.title")}
        </span>
        <span className="ml-auto text-[11px] text-sky-700/70 dark:text-sky-300/70">
          {t("dataManager.smtp.guide.subtitle")}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          {/* 顶部简述：先告诉用户"必须用授权码 / App Password" */}
          <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            {t("dataManager.smtp.guide.intro")}
          </p>

          {/* 速查表 */}
          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
            <table className="w-full text-[11px]">
              <thead className="bg-zinc-50 dark:bg-zinc-800/60 text-zinc-600 dark:text-zinc-400">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colProvider")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colHost")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colPort")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colTls")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colPass")}</th>
                </tr>
              </thead>
              <tbody className="text-zinc-700 dark:text-zinc-300">
                {rows.map((r) => (
                  <tr key={r.name} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-2 py-1.5 font-medium">{r.name}</td>
                    <td className="px-2 py-1.5 font-mono">{r.host}</td>
                    <td className="px-2 py-1.5 font-mono">{r.port}</td>
                    <td className="px-2 py-1.5">{tlsLabel(r.tls)}</td>
                    <td className="px-2 py-1.5">{r.passNote}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 关键提醒 */}
          <ul className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400 list-disc pl-4 space-y-0.5">
            <li>{t("dataManager.smtp.guide.tipAuthCode")}</li>
            <li>{t("dataManager.smtp.guide.tipFromEqLogin")}</li>
            <li>{t("dataManager.smtp.guide.tipPortTls")}</li>
            <li>{t("dataManager.smtp.guide.tipAttachmentLimit")}</li>
          </ul>

          {/* 外链：完整教程（需外网访问 GitHub） */}
          <a
            href={docUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[11px] text-sky-700 dark:text-sky-300 hover:underline"
          >
            <ExternalLink size={12} />
            {t("dataManager.smtp.guide.fullDocLink")}
          </a>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SMTP 邮件通道配置区（管理员）
// ----------------------------------------------------------------------------
// 设计要点：
//   - 放在 BackupSection 内部，而不是另开一个 Tab 或独立页面 —— 它的存在仅服务于
//     "备份发送到邮箱"，逻辑上和备份同域；
//   - 默认折叠（由内部 expanded 控制），不干扰备份主流程；
//   - 密码字段走"占位符模式"：hasPassword=true 时 input 显示 "••••••••"，用户不填
//     就代表不修改，避免"编辑其它字段"意外清空密码的陷阱；
//   - 保存成功后允许直接点"发送测试邮件"验证，所有操作都要 sudoToken。
// ============================================================================
function SmtpConfigSection(props: {
  askPassword: () => Promise<string | null>;
  sudoTokenRef: React.MutableRefObject<string | null>;
}) {
  const { t } = useTranslation();
  const { askPassword, sudoTokenRef } = props;

  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 服务端回的"只读视图"：永远不含明文密码，只有 hasPassword 标记
  const [hasPassword, setHasPassword] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // 表单字段（password 为空串意味着"不改动密码"）
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(465);
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState(""); // 空串 = 不动旧密码；用户主动输入才覆盖
  const [showPwd, setShowPwd] = useState(false);
  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 测试邮件
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await api.email.getSmtp();
      setEnabled(cfg.enabled);
      setHost(cfg.host);
      setPort(cfg.port);
      setSecure(cfg.secure);
      setUsername(cfg.username);
      setFromName(cfg.fromName);
      setFromEmail(cfg.fromEmail);
      setHasPassword(cfg.hasPassword);
      setUpdatedAt(cfg.updatedAt);
      setLoaded(true);
    } catch (err: any) {
      setSaveMsg({ type: "err", text: err?.message || "load failed" });
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次展开才拉取配置，避免没必要的 GET
  useEffect(() => {
    if (expanded && !loaded) loadConfig();
  }, [expanded, loaded, loadConfig]);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const out = await withSudo(
        (tk) =>
          api.email.putSmtp(
            {
              enabled,
              host: host.trim(),
              port: Number(port) || 465,
              secure,
              username: username.trim(),
              // 空串代表"不动旧密码"；非空才传新值
              password: password ? password : undefined,
              fromName: fromName.trim(),
              fromEmail: fromEmail.trim(),
            },
            tk,
          ),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setSaving(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      const cfg = out.result;
      setHasPassword(cfg.hasPassword);
      setUpdatedAt(cfg.updatedAt);
      setPassword(""); // 保存后清空本地密码输入框，避免残留
      setSaveMsg({ type: "ok", text: t("dataManager.smtp.saveSuccess") });
    } catch (err: any) {
      setSaveMsg({
        type: "err",
        text: t("dataManager.smtp.saveFailed", { error: err?.message || "error" }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const to = testTo.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      setTestMsg({ type: "err", text: t("dataManager.backup.sendEmailInvalid") });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.email.testSmtp(to, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setTesting(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      if (out.result.success) {
        setTestMsg({
          type: "ok",
          text: t("dataManager.smtp.testSuccess", {
            to,
            resp: out.result.lastResponse || "",
          }),
        });
      } else {
        setTestMsg({
          type: "err",
          text: out.result.error || t("dataManager.smtp.testFailed", { error: "error" }),
        });
      }
    } catch (err: any) {
      setTestMsg({
        type: "err",
        text: t("dataManager.smtp.testFailed", { error: err?.message || "error" }),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/30 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-zinc-500" />
        ) : (
          <ChevronRight size={14} className="text-zinc-500" />
        )}
        <SettingsIcon size={14} className="text-sky-500" />
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {t("dataManager.smtp.title")}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {loaded && (
            <span
              className={`text-[11px] px-1.5 py-0.5 rounded ${enabled
                ? "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-zinc-200 dark:bg-zinc-700/50 text-zinc-600 dark:text-zinc-400"
                }`}
            >
              {enabled ? t("dataManager.smtp.enabled") : t("dataManager.smtp.disabled")}
            </span>
          )}
          {updatedAt && (
            <span className="text-[11px] text-zinc-400">
              {new Date(updatedAt).toLocaleString()}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 space-y-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t("dataManager.smtp.description")}
          </p>

          {/* 常见邮箱 SMTP 配置教程入口
              ——————————————————————————————————————————————
              离线/内网环境：展开就能看到 QQ/163/Gmail/Outlook 的速查表与授权码要点，
              无需联网也够用；有外网时还给一个指向 docs/backup-email-smtp.md 的
              "完整教程"外链。刻意放在 description 下方、启用开关之上，
              原则是"先教会，再让你配"，降低首次配置时的挫败感。 */}
          <SmtpProviderGuide />


          {loading && !loaded ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500 py-4 justify-center">
              <Loader2 size={14} className="animate-spin" />
              {t("common.loading") || "加载中…"}
            </div>
          ) : (
            <>
              {/* 启用开关 */}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="w-4 h-4 accent-sky-600"
                />
                <span className="text-zinc-700 dark:text-zinc-300">
                  {t("dataManager.smtp.enable")}
                </span>
              </label>

              {/* host / port / secure */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {t("dataManager.smtp.host")}
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="smtp.example.com"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {t("dataManager.smtp.port")}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || 465)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={secure}
                  onChange={(e) => setSecure(e.target.checked)}
                  className="w-3.5 h-3.5 accent-sky-600"
                />
                <span>{t("dataManager.smtp.secure")}</span>
              </label>

              {/* 账号 / 密码 */}
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  {t("dataManager.smtp.username")}
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  {t("dataManager.smtp.password")}
                  {hasPassword && (
                    <span className="ml-2 text-[11px] text-emerald-600 dark:text-emerald-400 font-normal">
                      {t("dataManager.smtp.passwordSet")}
                    </span>
                  )}
                </label>
                <div className="relative">
                  <input
                    type={showPwd ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={hasPassword ? "••••••••" : t("dataManager.smtp.passwordPlaceholder") || ""}
                    className="w-full px-3 py-2 pr-9 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                    tabIndex={-1}
                  >
                    {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  {t("dataManager.smtp.passwordHint")}
                </div>
              </div>

              {/* From */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {t("dataManager.smtp.fromName")}
                  </label>
                  <input
                    type="text"
                    value={fromName}
                    onChange={(e) => setFromName(e.target.value)}
                    placeholder="nowen-note"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {t("dataManager.smtp.fromEmail")}
                  </label>
                  <input
                    type="email"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    placeholder="no-reply@example.com"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                </div>
              </div>

              {/* Save 结果 */}
              {saveMsg && (
                <div
                  className={`flex items-start gap-2 p-2.5 rounded-lg text-xs leading-relaxed ${saveMsg.type === "ok"
                    ? "bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-700/40 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300"
                    }`}
                >
                  {saveMsg.type === "ok" ? (
                    <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  )}
                  <span className="break-all">{saveMsg.text}</span>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-3.5 py-1.5 text-xs rounded-lg bg-sky-600 hover:bg-sky-700 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
                >
                  {saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  {t("dataManager.smtp.save")}
                </button>
              </div>

              {/* ===== 发送测试邮件 ===== */}
              <div className="pt-3 mt-1 border-t border-dashed border-zinc-200 dark:border-zinc-800 space-y-2">
                <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {t("dataManager.smtp.testTitle")}
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder="test@example.com"
                    className="flex-1 px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing || !testTo}
                    className="px-3 py-2 text-xs rounded-lg border border-sky-300 dark:border-sky-700/50 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5 justify-center"
                  >
                    {testing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    {t("dataManager.smtp.testSend")}
                  </button>
                </div>
                {testMsg && (
                  <div
                    className={`flex items-start gap-2 p-2.5 rounded-lg text-xs leading-relaxed ${testMsg.type === "ok"
                      ? "bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-700/40 text-emerald-700 dark:text-emerald-300"
                      : "bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300"
                      }`}
                  >
                    {testMsg.type === "ok" ? (
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    )}
                    <span className="break-all">{testMsg.text}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
