import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Download,
  HardDrive,
  Minus,
  RefreshCw,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  checkForUpdates,
  getAppInfo,
  isDesktop,
  isPortableDesktop,
  onUpdaterStatus,
  quitAndInstall,
} from "@/lib/desktopBridge";
import {
  UPDATE_AUTO_CHECK_KEY,
  UPDATE_INSTALL_ON_QUIT_KEY,
  UPDATE_LAST_CHECK_KEY,
  clampUpdatePercent,
  compactReleaseNotes,
  formatUpdateBytes,
  readBooleanPreference,
  resolveUpdatePhase,
  shouldShowAvailablePrompt,
  type DesktopUpdateSnapshot,
  updateStatusText,
  writeBooleanPreference,
} from "@/lib/updateExperience";

const FALLBACK_RELEASE_NOTES = "本次更新包含功能优化和问题修复。";

type ModalKind = "available" | "downloaded" | "error" | "installing" | null;

function readLastCheck(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(UPDATE_LAST_CHECK_KEY) || "";
}

function saveLastCheck(value: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(UPDATE_LAST_CHECK_KEY, value);
}

function formatCheckTime(value: string): string {
  if (!value) return "尚未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未检查";
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function runEditorSafetyFlush(): void {
  window.dispatchEvent(new CustomEvent("nowen:before-desktop-update", {
    detail: { reason: "desktop-update-install" },
  }));

  const eventInit: KeyboardEventInit = {
    key: "s",
    code: "KeyS",
    bubbles: true,
    cancelable: true,
    ctrlKey: !navigator.platform.toLowerCase().includes("mac"),
    metaKey: navigator.platform.toLowerCase().includes("mac"),
  };
  const targets = new Set<EventTarget>();
  if (document.activeElement) targets.add(document.activeElement);
  document.querySelectorAll<HTMLElement>(
    '.ProseMirror[contenteditable="true"], .cm-content[contenteditable="true"]',
  ).forEach((element) => targets.add(element));
  targets.forEach((target) => target.dispatchEvent(new KeyboardEvent("keydown", eventInit)));
  (document.activeElement as HTMLElement | null)?.blur?.();
}

function SwitchRow({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span className="min-w-0">
        <span className="block text-xs font-medium text-zinc-800 dark:text-zinc-200">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          {description}
        </span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent-primary"
      />
    </label>
  );
}

function UpdateSettingsAddon({
  autoCheck,
  installOnQuit,
  lastCheck,
  snapshot,
  onAutoCheckChange,
  onInstallOnQuitChange,
}: {
  autoCheck: boolean;
  installOnQuit: boolean;
  lastCheck: string;
  snapshot: DesktopUpdateSnapshot | null;
  onAutoCheckChange: (next: boolean) => void;
  onInstallOnQuitChange: (next: boolean) => void;
}) {
  return (
    <div
      data-nowen-update-settings="true"
      className="mt-3 border-t border-zinc-200/60 pt-3 dark:border-zinc-800/60"
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
        <Settings size={13} />
        自动更新偏好
      </div>
      <SwitchRow
        checked={autoCheck}
        onChange={onAutoCheckChange}
        title="启动后自动检查更新"
        description="后台静默检查稳定版；无更新或网络异常时不打扰使用。"
      />
      <SwitchRow
        checked={installOnQuit}
        onChange={onInstallOnQuitChange}
        title="下载完成后退出时安装"
        description="更新下载完成后，可继续使用当前版本，正常退出应用时再安装。"
      />
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-zinc-400 dark:text-zinc-500">
        <span>最近检查</span>
        <span className="text-right">{formatCheckTime(lastCheck)}</span>
        <span>当前状态</span>
        <span className="truncate text-right" title={updateStatusText(snapshot)}>
          {updateStatusText(snapshot)}
        </span>
      </div>
    </div>
  );
}

function ModalShell({
  children,
  dismissible,
  onClose,
}: {
  children: React.ReactNode;
  dismissible?: boolean;
  onClose?: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Nowen Note 应用更新"
        className="relative w-full max-w-[520px] overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl"
      >
        {dismissible && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 z-10 rounded-lg p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        )}
        {children}
      </section>
    </div>,
    document.body,
  );
}

export default function DesktopUpdateCenter() {
  const desktop = isDesktop();
  const portable = isPortableDesktop();
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot | null>(null);
  const snapshotRef = useRef<DesktopUpdateSnapshot | null>(null);
  const [currentVersion, setCurrentVersion] = useState("");
  const [modal, setModal] = useState<ModalKind>(null);
  const [progressMinimized, setProgressMinimized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastCheck, setLastCheck] = useState(readLastCheck);
  const [autoCheck, setAutoCheck] = useState(() => readBooleanPreference(UPDATE_AUTO_CHECK_KEY, true));
  const [installOnQuit, setInstallOnQuit] = useState(() =>
    readBooleanPreference(UPDATE_INSTALL_ON_QUIT_KEY, false),
  );
  const [settingsHost, setSettingsHost] = useState<HTMLElement | null>(null);
  const dismissedVersionsRef = useRef(new Set<string>());
  const userActionRef = useRef(false);
  const installFlushRef = useRef(false);
  const autoArmRef = useRef(false);

  const updateSnapshot = useCallback((next: DesktopUpdateSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    const phase = resolveUpdatePhase(next);

    if (phase === "checking" || phase === "up-to-date" || phase === "update-available" || phase === "error") {
      const checkedAt = next.checkedAt || new Date().toISOString();
      saveLastCheck(checkedAt);
      setLastCheck(checkedAt);
    }

    if (shouldShowAvailablePrompt(next, dismissedVersionsRef.current)) {
      setProgressMinimized(false);
      setModal("available");
    } else if (phase === "downloading") {
      setModal((current) => current === "error" ? current : null);
    } else if (phase === "downloaded") {
      setProgressMinimized(false);
      setModal("downloaded");
      if (installOnQuit && !next.installOnQuit && !autoArmRef.current) {
        autoArmRef.current = true;
        void checkForUpdates().finally(() => {
          autoArmRef.current = false;
        });
      }
    } else if (phase === "installing") {
      if (!installFlushRef.current) {
        installFlushRef.current = true;
        runEditorSafetyFlush();
      }
      setModal("installing");
    } else if (phase === "error") {
      const userVisible = next.errorStage === "download" || next.errorStage === "install" || userActionRef.current;
      if (userVisible) setModal("error");
    } else if (phase === "up-to-date") {
      setModal((current) => current === "available" ? null : current);
    }

    if (phase !== "checking") {
      userActionRef.current = false;
      setBusy(false);
    }
  }, [installOnQuit]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void getAppInfo().then((info) => {
      if (!cancelled && info?.version) setCurrentVersion(info.version);
    });
    const off = onUpdaterStatus((payload) => updateSnapshot(payload as DesktopUpdateSnapshot));
    return () => {
      cancelled = true;
      off();
    };
  }, [desktop, updateSnapshot]);

  useEffect(() => {
    if (!desktop || portable || !autoCheck) return;
    const timer = window.setTimeout(() => {
      void checkForUpdates().then((result) => {
        const returnedState = (result as unknown as { state?: DesktopUpdateSnapshot }).state;
        if (returnedState) updateSnapshot(returnedState);
      });
    }, 5500);
    return () => window.clearTimeout(timer);
  }, [desktop, portable, autoCheck, updateSnapshot]);

  // 复用现有“设置 → 关于”版本卡，不修改大体量 SettingsModal：在该卡片尾部挂载偏好项。
  useEffect(() => {
    if (!desktop || portable) return;
    let frame = 0;
    const findHost = () => {
      frame = 0;
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((candidate) =>
        candidate.textContent?.includes("检查桌面端更新"),
      );
      const host = button?.closest<HTMLElement>("div.pt-2") || button?.parentElement?.parentElement || null;
      setSettingsHost((current) => current === host ? current : host);
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(findHost);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [desktop, portable]);

  const changeAutoCheck = useCallback((next: boolean) => {
    writeBooleanPreference(UPDATE_AUTO_CHECK_KEY, next);
    setAutoCheck(next);
  }, []);

  const changeInstallOnQuit = useCallback((next: boolean) => {
    writeBooleanPreference(UPDATE_INSTALL_ON_QUIT_KEY, next);
    setInstallOnQuit(next);
    if (next && resolveUpdatePhase(snapshotRef.current) === "downloaded" && !snapshotRef.current?.installOnQuit) {
      void checkForUpdates();
    }
  }, []);

  const invokeStateAction = useCallback(async () => {
    userActionRef.current = true;
    setBusy(true);
    try {
      const result = await checkForUpdates();
      const returnedState = (result as unknown as { state?: DesktopUpdateSnapshot }).state;
      if (returnedState) updateSnapshot(returnedState);
      if (!result.ok && !returnedState) {
        updateSnapshot({ phase: "error", status: "error", message: result.reason, errorStage: "check" });
      }
    } catch (error) {
      updateSnapshot({
        phase: "error",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        errorStage: "check",
      });
    }
  }, [updateSnapshot]);

  const dismissAvailable = useCallback(() => {
    const version = snapshotRef.current?.version;
    if (version) dismissedVersionsRef.current.add(version);
    setModal(null);
  }, []);

  const installImmediately = useCallback(async () => {
    installFlushRef.current = false;
    setBusy(true);
    try {
      await quitAndInstall();
    } catch (error) {
      updateSnapshot({
        ...snapshotRef.current,
        phase: "error",
        status: "error",
        errorStage: "install",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [updateSnapshot]);

  const armExitInstall = useCallback(async () => {
    setBusy(true);
    userActionRef.current = true;
    try {
      const result = await checkForUpdates();
      const returnedState = (result as unknown as { state?: DesktopUpdateSnapshot }).state;
      if (returnedState) updateSnapshot(returnedState);
      setModal(null);
    } finally {
      setBusy(false);
    }
  }, [updateSnapshot]);

  const phase = resolveUpdatePhase(snapshot);
  const percent = clampUpdatePercent(snapshot?.percent);
  const releaseNotes = compactReleaseNotes(snapshot?.releaseNotes) || FALLBACK_RELEASE_NOTES;
  const displayedCurrentVersion = snapshot?.currentVersion || currentVersion || "?";
  const latestVersion = snapshot?.version || "?";

  const settingsPortal = settingsHost ? createPortal(
    <UpdateSettingsAddon
      autoCheck={autoCheck}
      installOnQuit={installOnQuit}
      lastCheck={lastCheck}
      snapshot={snapshot}
      onAutoCheckChange={changeAutoCheck}
      onInstallOnQuitChange={changeInstallOnQuit}
    />,
    settingsHost,
  ) : null;

  if (!desktop || typeof document === "undefined") return null;

  let modalPortal: React.ReactNode = null;
  if (modal === "available") {
    modalPortal = (
      <ModalShell dismissible onClose={dismissAvailable}>
        <div className="p-6 sm:p-7">
          <div className="mb-5 flex items-start gap-3 pr-8">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-primary/12 text-accent-primary">
              <Download size={22} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-tx-primary">发现新版本 v{latestVersion}</h2>
              <p className="mt-1 text-xs text-tx-tertiary">
                当前 v{displayedCurrentVersion} · {snapshot?.platform || "desktop"}/{snapshot?.arch || "current"}
              </p>
            </div>
          </div>

          <div className="max-h-52 overflow-y-auto rounded-xl border border-app-border bg-app-surface p-4 text-sm leading-6 text-tx-secondary whitespace-pre-wrap">
            {releaseNotes}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-app-hover/55 px-4 py-3 text-xs text-tx-secondary">
            <span className="flex items-center gap-1.5"><HardDrive size={13} /> 安装包大小</span>
            <span className="text-right font-medium text-tx-primary">{formatUpdateBytes(snapshot?.fileSize || snapshot?.total)}</span>
            <span className="flex items-center gap-1.5"><ShieldCheck size={13} /> 安全校验</span>
            <span className="text-right font-medium text-emerald-600 dark:text-emerald-400">官方源 + SHA-512</span>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={dismissAvailable}
              className="h-10 rounded-xl border border-app-border px-5 text-sm text-tx-secondary hover:bg-app-hover"
            >
              稍后提醒
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void invokeStateAction()}
              className="flex h-10 items-center justify-center gap-2 rounded-xl bg-accent-primary px-5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <RefreshCw size={15} className="animate-spin" /> : <Download size={15} />}
              立即更新
            </button>
          </div>
        </div>
      </ModalShell>
    );
  } else if (modal === "downloaded") {
    modalPortal = (
      <ModalShell dismissible onClose={() => setModal(null)}>
        <div className="p-6 sm:p-7">
          <div className="flex items-start gap-3 pr-8">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
              <CheckCircle size={23} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-tx-primary">v{latestVersion} 已下载完成</h2>
              <p className="mt-1 text-sm leading-6 text-tx-secondary">
                可以立即安装并重启，也可以继续工作，在退出应用时安装。
              </p>
            </div>
          </div>
          <div className="mt-5 rounded-xl border border-app-border bg-app-surface px-4 py-3 text-xs leading-5 text-tx-tertiary">
            安装前会触发编辑器立即保存、等待同步队列落盘，并创建 SQLite 升级前快照。
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() => void armExitInstall()}
              className="flex h-10 items-center justify-center gap-2 rounded-xl border border-app-border px-5 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-60"
            >
              <Clock size={15} />
              退出时安装
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void installImmediately()}
              className="flex h-10 items-center justify-center gap-2 rounded-xl bg-accent-primary px-5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <RefreshCw size={15} className="animate-spin" /> : <CheckCircle size={15} />}
              立即安装并重启
            </button>
          </div>
        </div>
      </ModalShell>
    );
  } else if (modal === "error") {
    modalPortal = (
      <ModalShell dismissible onClose={() => setModal(null)}>
        <div className="p-6 sm:p-7">
          <div className="flex items-start gap-3 pr-8">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400">
              <AlertTriangle size={22} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-tx-primary">更新未完成</h2>
              <p className="mt-1 break-words text-sm leading-6 text-tx-secondary">
                {snapshot?.message || "网络连接、磁盘空间或安装包校验出现问题。当前版本仍可继续使用。"}
              </p>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setModal(null)}
              className="h-10 rounded-xl border border-app-border px-5 text-sm text-tx-secondary hover:bg-app-hover"
            >
              关闭
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void invokeStateAction()}
              className="flex h-10 items-center gap-2 rounded-xl bg-accent-primary px-5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
              重试
            </button>
          </div>
        </div>
      </ModalShell>
    );
  } else if (modal === "installing") {
    modalPortal = (
      <ModalShell>
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <RefreshCw size={30} className="animate-spin text-accent-primary" />
          <h2 className="mt-5 text-lg font-semibold text-tx-primary">正在准备安装</h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-tx-secondary">
            {snapshot?.message || "正在保存笔记、同步队列并准备安全重启，请稍候…"}
          </p>
        </div>
      </ModalShell>
    );
  }

  const progressPortal = phase === "downloading" ? createPortal(
    progressMinimized ? (
      <button
        type="button"
        onClick={() => setProgressMinimized(false)}
        className="fixed bottom-4 right-4 z-[125] flex items-center gap-2 rounded-full border border-app-border bg-app-elevated px-4 py-2.5 text-xs font-medium text-tx-primary shadow-xl"
      >
        <Download size={14} className="text-accent-primary" />
        更新下载中 {percent.toFixed(0)}%
      </button>
    ) : (
      <aside className="fixed bottom-4 right-4 z-[125] w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-app-border bg-app-elevated p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-tx-primary">正在下载 v{latestVersion}</div>
            <div className="mt-1 text-[11px] text-tx-tertiary">下载期间可以继续编辑笔记</div>
          </div>
          <button
            type="button"
            onClick={() => setProgressMinimized(true)}
            className="rounded-lg p-1.5 text-tx-tertiary hover:bg-app-hover"
            aria-label="最小化下载进度"
          >
            <Minus size={15} />
          </button>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-app-hover">
          <div
            className="h-full rounded-full bg-accent-primary transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-tx-tertiary">
          <span>{formatUpdateBytes(snapshot?.transferred)} / {formatUpdateBytes(snapshot?.total || snapshot?.fileSize)}</span>
          <span>{formatUpdateBytes(snapshot?.bytesPerSecond)}/s · {percent.toFixed(1)}%</span>
        </div>
      </aside>
    ),
    document.body,
  ) : null;

  return <>{settingsPortal}{modalPortal}{progressPortal}</>;
}
