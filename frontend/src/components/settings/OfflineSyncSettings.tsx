import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Database,
  FolderOpen,
  HardDrive,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Wifi,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  clearAllOfflineWorkspaceData,
  getOfflineSyncProgress,
  getOfflineSyncSettings,
  pauseOfflineWorkspaceSync,
  refreshOfflineStorageStats,
  resumeOfflineWorkspaceSync,
  setOfflineSyncSettings,
  stopOfflineWorkspaceSync,
  subscribeOfflineSyncProgress,
  syncOfflineWorkspace,
  type OfflineAttachmentMode,
  type OfflineSyncProgress,
  type OfflineSyncSettings,
} from "@/lib/offlineWorkspaceSync";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import {
  chooseOfflineStorageDir,
  getOfflineStorageInfo,
  openOfflineStorageDir,
} from "@/lib/desktopBridge";
import type { Workspace } from "@/types";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatTime(value: number | null): string {
  if (!value) return "尚未完成";
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

function stateLabel(progress: OfflineSyncProgress): string {
  if (progress.state === "planning") return "正在检查服务器变化";
  if (progress.state === "downloading-notes") return "正在下载完整笔记正文";
  if (progress.state === "downloading-attachments") return "正在下载离线附件";
  if (progress.state === "applying-changes") return "正在应用增量变化";
  if (progress.state === "paused") return "同步已暂停";
  if (progress.state === "error") return "同步遇到问题";
  if (progress.state === "ready") return "离线副本已是最新";
  return "等待同步";
}

function isBusy(progress: OfflineSyncProgress): boolean {
  return progress.state === "planning"
    || progress.state === "downloading-notes"
    || progress.state === "downloading-attachments"
    || progress.state === "applying-changes";
}

export default function OfflineSyncSettings() {
  const [settings, setSettings] = useState<OfflineSyncSettings>(() => getOfflineSyncSettings());
  const [progress, setProgress] = useState<OfflineSyncProgress>(() => getOfflineSyncProgress());
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [offlineStoragePath, setOfflineStoragePath] = useState<string | null>(null);
  const [openingStorage, setOpeningStorage] = useState(false);
  const [changingStorage, setChangingStorage] = useState(false);
  const busy = isBusy(progress);
  const isDesktopClient = typeof window !== "undefined" && Boolean((window as any).nowenDesktop?.isDesktop);
  const isNativeMobile = typeof window !== "undefined" && Boolean((window as any).Capacitor?.isNativePlatform?.());

  useEffect(() => subscribeOfflineSyncProgress(setProgress), []);
  useEffect(() => {
    let cancelled = false;
    api.getWorkspaces()
      .then((items) => { if (!cancelled) setWorkspaces(items); })
      .catch((error) => console.warn("[offline-sync-settings] workspaces failed", error))
      .finally(() => { if (!cancelled) setLoadingWorkspaces(false); });
    void refreshOfflineStorageStats();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isDesktopClient) return;
    let cancelled = false;
    void getOfflineStorageInfo().then((info) => {
      if (!cancelled && info?.ok) setOfflineStoragePath(info.path);
    });
    return () => { cancelled = true; };
  }, [isDesktopClient]);

  const notePercent = progress.totalNotes > 0
    ? Math.min(100, Math.round(progress.completedNotes / progress.totalNotes * 100))
    : progress.state === "ready" ? 100 : 0;
  const attachmentPercent = progress.totalAttachments > 0
    ? Math.min(100, Math.round(progress.completedAttachments / progress.totalAttachments * 100))
    : 0;
  const maxGb = settings.maxAttachmentBytes === 0
    ? 0
    : Math.max(0.1, settings.maxAttachmentBytes / 1024 / 1024 / 1024);
  const selectedWorkspaceSet = useMemo(() => new Set(settings.workspaceIds), [settings.workspaceIds]);

  useEffect(() => {
    if (!settings.enabled || settings.paused) return;
    const timer = window.setTimeout(() => {
      void syncOfflineWorkspace({ force: true, reason: "settings" });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    settings.attachmentMode,
    settings.maxAttachmentBytes,
    settings.wifiOnly,
    settings.workspaceIds,
    settings.workspaceMode,
    settings.enabled,
    settings.paused,
  ]);

  const update = (patch: Partial<OfflineSyncSettings>) => {
    const next = setOfflineSyncSettings(patch);
    setSettings(next);
    return next;
  };

  const toggleEnabled = (enabled: boolean) => {
    const next = update({ enabled, paused: enabled ? false : settings.paused });
    if (next.enabled) void syncOfflineWorkspace({ force: true, reason: "settings" });
    else stopOfflineWorkspaceSync();
  };

  const toggleWorkspace = (workspaceId: string) => {
    const next = selectedWorkspaceSet.has(workspaceId)
      ? settings.workspaceIds.filter((id) => id !== workspaceId)
      : [...settings.workspaceIds, workspaceId];
    update({ workspaceIds: next });
  };

  const handleClear = async () => {
    const ok = await confirmDialog({
      title: "清除本机离线副本？",
      description:
        "将删除本机已下载的笔记正文和附件，但不会删除服务器数据。尚未上传的离线修改会继续保留。",
      confirmText: "清除离线副本",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    setSettings(setOfflineSyncSettings({ enabled: false, paused: false }));
    await clearAllOfflineWorkspaceData();
  };

  const handleOpenStorage = async () => {
    setOpeningStorage(true);
    try {
      await openOfflineStorageDir();
    } finally {
      setOpeningStorage(false);
    }
  };

  const handleChangeStorage = async () => {
    setChangingStorage(true);
    try {
      const result = await chooseOfflineStorageDir();
      if (result.ok && result.path) setOfflineStoragePath(result.path);
    } finally {
      setChangingStorage(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <CloudDownload className="h-5 w-5 text-indigo-500" />
          <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">离线同步</h2>
        </div>
        <p className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          将服务器中的完整笔记和允许下载的附件保存到本机。断网后仍可查看、编辑，恢复连接后自动双向同步。
        </p>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">保存完整离线副本</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              开启后不需要逐个打开笔记，客户端会批量下载并持续跟踪服务器变化。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            onClick={() => toggleEnabled(!settings.enabled)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${settings.enabled ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700"}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${settings.enabled ? "translate-x-5" : "translate-x-0"}`} />
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <div className="min-w-0">
            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">客户端离线缓存位置</p>
            <p
              className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400"
              title={offlineStoragePath || undefined}
            >
              {isDesktopClient
                ? offlineStoragePath || "正在读取存储位置…"
                : isNativeMobile
                  ? "应用内部存储（由系统管理）"
                  : "浏览器站点存储（IndexedDB）"}
            </p>
            <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">缓存由客户端管理，请勿手动修改其中的文件。</p>
          </div>
          {isDesktopClient && offlineStoragePath && (
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void handleOpenStorage()}
                disabled={openingStorage || changingStorage}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {openingStorage ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                打开
              </button>
              <button
                type="button"
                onClick={() => void handleChangeStorage()}
                disabled={openingStorage || changingStorage}
                className="inline-flex h-8 items-center rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-60"
              >
                {changingStorage && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                更改位置
              </button>
            </div>
          )}
        </div>
      </section>

      <section className={`space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 ${settings.enabled ? "" : "pointer-events-none opacity-55"}`}>
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">同步范围</h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">个人空间始终包含；可同时保存全部或指定工作区。</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <input
              type="radio"
              name="offline-workspace-mode"
              checked={settings.workspaceMode === "all"}
              onChange={() => update({ workspaceMode: "all" })}
              className="mt-0.5 accent-indigo-600"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">个人空间 + 全部工作区</span>
              <span className="mt-0.5 block text-xs text-zinc-500">新加入的工作区也会自动纳入。</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <input
              type="radio"
              name="offline-workspace-mode"
              checked={settings.workspaceMode === "selected"}
              onChange={() => update({ workspaceMode: "selected" })}
              className="mt-0.5 accent-indigo-600"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">个人空间 + 指定工作区</span>
              <span className="mt-0.5 block text-xs text-zinc-500">适合本机存储空间有限的情况。</span>
            </span>
          </label>
        </div>

        {settings.workspaceMode === "selected" && (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            {loadingWorkspaces ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-500">
                <Loader2 size={13} className="animate-spin" /> 正在加载工作区
              </div>
            ) : workspaces.length === 0 ? (
              <p className="px-3 py-3 text-xs text-zinc-500">当前没有可用工作区。</p>
            ) : (
              workspaces.map((workspace, index) => (
                <label
                  key={workspace.id}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm ${index > 0 ? "border-t border-zinc-200 dark:border-zinc-800" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedWorkspaceSet.has(workspace.id)}
                    onChange={() => toggleWorkspace(workspace.id)}
                    className="accent-indigo-600"
                  />
                  <span className="truncate text-zinc-700 dark:text-zinc-300">{workspace.icon || "🏢"} {workspace.name}</span>
                </label>
              ))
            )}
          </div>
        )}
      </section>

      <section className={`space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 ${settings.enabled ? "" : "pointer-events-none opacity-55"}`}>
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">附件离线策略</h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">只下载当前账号有权限下载的附件；权限撤销后会从本机副本中移除。</p>
        </div>
        <select
          value={settings.attachmentMode}
          onChange={(event) => update({ attachmentMode: event.target.value as OfflineAttachmentMode })}
          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
        >
          <option value="all">保存全部图片和附件</option>
          <option value="images">只保存笔记中的图片</option>
          <option value="none">不保存附件，仅保存正文</option>
        </select>

        <label className="flex items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-2.5 dark:bg-zinc-900/60">
          <span className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <Wifi size={15} /> 仅在 Wi-Fi / 有线网络下载大附件
          </span>
          <input
            type="checkbox"
            checked={settings.wifiOnly}
            onChange={(event) => update({ wifiOnly: event.target.checked })}
            className="accent-indigo-600"
          />
        </label>

        <div className="grid gap-2 sm:grid-cols-[1fr_150px] sm:items-center">
          <div>
            <span className="text-sm text-zinc-700 dark:text-zinc-300">附件缓存上限</span>
            <p className="mt-0.5 text-xs text-zinc-500">达到上限时自动清理最久未使用的附件；笔记正文不会被清理。</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="0.5"
              value={Number(maxGb.toFixed(1))}
              onChange={(event) => {
                const gb = Math.max(0, Number(event.target.value) || 0);
                update({ maxAttachmentBytes: gb === 0 ? 0 : Math.round(gb * 1024 * 1024 * 1024) });
              }}
              className="w-24 rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-right text-sm outline-none focus:border-indigo-400 dark:border-zinc-800"
            />
            <span className="text-xs text-zinc-500">GB</span>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_150px] sm:items-center">
          <div>
            <span className="text-sm text-zinc-700 dark:text-zinc-300">自动检查间隔</span>
            <p className="mt-0.5 text-xs text-zinc-500">恢复网络、打开客户端和到达间隔时都会检查增量变化。</p>
          </div>
          <select
            value={settings.intervalMinutes}
            onChange={(event) => update({ intervalMinutes: Number(event.target.value) })}
            className="rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-indigo-400 dark:border-zinc-800"
          >
            <option value={1}>每 1 分钟</option>
            <option value={5}>每 5 分钟</option>
            <option value={15}>每 15 分钟</option>
            <option value={30}>每 30 分钟</option>
            <option value={60}>每 1 小时</option>
          </select>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-950 dark:bg-indigo-500/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {busy ? (
                <Loader2 size={16} className="animate-spin text-indigo-600" />
              ) : progress.state === "error" ? (
                <AlertTriangle size={16} className="text-amber-500" />
              ) : progress.state === "ready" ? (
                <CheckCircle2 size={16} className="text-emerald-500" />
              ) : (
                <Database size={16} className="text-indigo-600" />
              )}
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{stateLabel(progress)}</h3>
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {progress.scopeLabel ? `当前：${progress.scopeLabel} · ` : ""}上次完成：{formatTime(progress.lastSyncAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {settings.paused ? (
              <button
                type="button"
                disabled={!settings.enabled}
                onClick={() => {
                  const next = setOfflineSyncSettings({ paused: false });
                  setSettings(next);
                  void resumeOfflineWorkspaceSync();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                <Play size={13} /> 继续
              </button>
            ) : (
              <button
                type="button"
                disabled={!settings.enabled}
                onClick={() => {
                  const next = pauseOfflineWorkspaceSync();
                  setSettings(next);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                <Pause size={13} /> 暂停
              </button>
            )}
            <button
              type="button"
              disabled={!settings.enabled || settings.paused || busy}
              onClick={() => void syncOfflineWorkspace({ force: true, reason: "manual" })}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <RefreshCw size={13} /> 立即同步
            </button>
          </div>
        </div>

        {(busy || progress.totalNotes > 0) && (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                <span>笔记正文</span>
                <span>{progress.completedNotes} / {progress.totalNotes}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-indigo-500 transition-[width]" style={{ width: `${notePercent}%` }} />
              </div>
            </div>
            {progress.totalAttachments > 0 && (
              <div>
                <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                  <span>附件 · 已下载 {formatBytes(progress.downloadedBytes)}</span>
                  <span>{progress.completedAttachments} / {progress.totalAttachments}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div className="h-full rounded-full bg-sky-500 transition-[width]" style={{ width: `${attachmentPercent}%` }} />
                </div>
              </div>
            )}
          </div>
        )}

        {progress.lastError && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {progress.lastError}
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-950/50">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500"><Database size={13} /> 完整正文</div>
            <p className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{progress.storage?.cachedNotes ?? 0} 篇</p>
          </div>
          <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-950/50">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500"><HardDrive size={13} /> 附件占用</div>
            <p className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{formatBytes(progress.storage?.attachmentBytes ?? 0)}</p>
          </div>
          <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-950/50">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500"><CloudDownload size={13} /> 离线附件</div>
            <p className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{progress.storage?.attachmentCount ?? 0} 个</p>
          </div>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200/70 p-4 dark:border-red-950">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">清理本机副本</h3>
          <p className="mt-1 text-xs text-zinc-500">不会影响服务器，也不会丢弃尚未上传的本地修改。</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleClear()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          <Trash2 size={13} /> 清除离线数据
        </button>
      </section>
    </div>
  );
}
