import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from "lucide-react";

import { confirm as confirmDialog, prompt as promptDialog } from "@/components/ui/confirm";
import { getBaseUrl, withSudo } from "@/lib/api";
import { toast } from "@/lib/toast";

const HOST_ATTR = "data-nowen-backup-webdav-host";

type Notice = { type: "success" | "error" | "info"; text: string } | null;

type WebDavStatus = {
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastUploadAt: string | null;
  lastFilename: string | null;
  lastError: string | null;
};

type WebDavConfig = {
  enabled: boolean;
  configured: boolean;
  endpoint: string;
  username: string;
  passwordSet: boolean;
  remotePath: string;
  uploadOnAutoBackup: boolean;
  insecureHttp: boolean;
  remoteDirectory: string | null;
  status: WebDavStatus;
};

type BackupRow = {
  filename: string;
  size: number;
  type: "full" | "db-only";
  createdAt: string;
};

function authHeaders(sudoToken?: string): Record<string, string> {
  const token = localStorage.getItem("nowen-token");
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(sudoToken ? { "X-Sudo-Token": sudoToken } : {}),
  };
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  sudoToken?: string,
): Promise<T> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(sudoToken),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let payload: any = {};
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
  }
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  return payload as T;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(value: string | null, emptyLabel: string, locale: string): string {
  if (!value) return emptyLabel;
  try { return new Date(value).toLocaleString(locale); } catch { return value; }
}

function findBackupHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${HOST_ATTR}]`);
}

function useBackupHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let frame = 0;
    const scan = () => {
      frame = 0;
      setHost(findBackupHost());
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(scan);
    };

    scan();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return host;
}

function NoticeBox({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const style = notice.type === "success"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-300"
    : notice.type === "error"
      ? "border-red-200 bg-red-50 text-red-600 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-300"
      : "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-500/10 dark:text-blue-300";
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5 ${style}`}>
      {notice.type === "success"
        ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
        : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
      <span className="min-w-0 break-all">{notice.text}</span>
    </div>
  );
}

function BackupWebDavPanel() {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "upload" | "clear" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [config, setConfig] = useState<WebDavConfig | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remotePath, setRemotePath] = useState("nowen-note/backups");
  const [enabled, setEnabled] = useState(false);
  const [uploadOnAutoBackup, setUploadOnAutoBackup] = useState(false);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [selectedBackup, setSelectedBackup] = useState("");
  const sudoTokenRef = useRef<string | null>(null);

  const askPassword = useCallback(() => promptDialog({
    title: t("webdav.verifyAdmin"),
    description: t("webdav.credentialHint"),
    type: "password",
    placeholder: t("webdav.adminPassword"),
    confirmText: t("webdav.verify"),
    cancelText: t("webdav.cancel"),
    danger: true,
  }), [t]);

  const applyConfig = useCallback((next: WebDavConfig) => {
    setConfig(next);
    setEndpoint(next.endpoint || "");
    setUsername(next.username || "");
    setPassword("");
    setRemotePath(next.remotePath || "nowen-note/backups");
    setEnabled(next.enabled);
    setUploadOnAutoBackup(next.uploadOnAutoBackup);
    window.dispatchEvent(new Event("nowen-backup-webdav-config-changed"));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextConfig, rows] = await Promise.all([
        requestJson<WebDavConfig>("/backups/webdav"),
        requestJson<BackupRow[]>("/backups"),
      ]);
      applyConfig(nextConfig);
      setBackups(rows);
      setSelectedBackup((current) => {
        if (current && rows.some((row) => row.filename === current)) return current;
        return rows[0]?.filename || "";
      });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [applyConfig]);

  useEffect(() => { void reload(); }, [reload]);

  const draft = useCallback(() => ({
    enabled,
    endpoint: endpoint.trim(),
    username: username.trim(),
    ...(password ? { password } : {}),
    remotePath: remotePath.trim(),
    uploadOnAutoBackup,
  }), [enabled, endpoint, password, remotePath, uploadOnAutoBackup, username]);

  const validateDraft = useCallback((): string | null => {
    if (!endpoint.trim()) return t("webdav.endpointRequired");
    if (!/^https?:\/\//i.test(endpoint.trim())) return t("webdav.protocolRequired");
    if (username.trim() && !password && !config?.passwordSet) return t("webdav.usernameRequiresPassword");
    return null;
  }, [config?.passwordSet, endpoint, password, username, t]);

  const handleSave = useCallback(async () => {
    const invalid = validateDraft();
    if (invalid) { setNotice({ type: "error", text: invalid }); return; }
    setBusy("save");
    setNotice({ type: "info", text: t("webdav.savingConfig") });
    try {
      const out = await withSudo(
        (sudoToken) => requestJson<WebDavConfig>("/backups/webdav", {
          method: "PUT",
          body: JSON.stringify(draft()),
        }, sudoToken),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) { setNotice(null); return; }
      sudoTokenRef.current = out.sudoToken;
      applyConfig(out.result);
      setNotice({ type: "success", text: t("webdav.configSaved") });
    } catch (error) {
      setNotice({ type: "error", text: t("webdav.saveFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setBusy(null);
    }
  }, [applyConfig, askPassword, draft, validateDraft, t]);

  const handleTest = useCallback(async () => {
    const invalid = validateDraft();
    if (invalid) { setNotice({ type: "error", text: invalid }); return; }
    setBusy("test");
    setNotice({ type: "info", text: t("webdav.startingTest") });
    try {
      const out = await withSudo(
        (sudoToken) => requestJson<{ success: true; message: string }>("/backups/webdav/test", {
          method: "POST",
          body: JSON.stringify(draft()),
        }, sudoToken),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) { setNotice(null); return; }
      sudoTokenRef.current = out.sudoToken;
      setNotice({ type: "success", text: t("webdav.testSucceeded") });
      await reload();
    } catch (error) {
      setNotice({ type: "error", text: t("webdav.testFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setBusy(null);
    }
  }, [askPassword, draft, reload, validateDraft, t]);

  const handleUpload = useCallback(async () => {
    if (!selectedBackup) return;
    const row = backups.find((item) => item.filename === selectedBackup);
    const confirmed = await confirmDialog({
      title: t("webdav.uploadTitle"),
      description: row
        ? t("webdav.uploadDetails", { filename: row.filename, size: formatBytes(row.size) })
        : selectedBackup,
      confirmText: t("webdav.startUpload"),
      cancelText: t("webdav.cancel"),
    });
    if (!confirmed) return;

    setBusy("upload");
    setNotice({ type: "info", text: t("webdav.uploading", { filename: selectedBackup }) });
    try {
      const out = await withSudo(
        (sudoToken) => requestJson<{ message: string }>(
          `/backups/webdav/upload/${encodeURIComponent(selectedBackup)}`,
          { method: "POST", body: JSON.stringify({}) },
          sudoToken,
        ),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) { setNotice(null); return; }
      sudoTokenRef.current = out.sudoToken;
      setNotice({ type: "success", text: t("webdav.uploadSuccess") });
      toast.success(t("webdav.uploadSuccess"), 5000);
      await reload();
    } catch (error) {
      setNotice({ type: "error", text: t("webdav.uploadFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setBusy(null);
    }
  }, [askPassword, backups, reload, selectedBackup, t]);

  const handleClear = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("webdav.clearTitle"),
      description: t("webdav.clearDescription"),
      confirmText: t("webdav.clearConfig"),
      cancelText: t("webdav.cancel"),
      danger: true,
    });
    if (!confirmed) return;
    setBusy("clear");
    try {
      const out = await withSudo(
        (sudoToken) => requestJson<WebDavConfig>("/backups/webdav", { method: "DELETE" }, sudoToken),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) return;
      sudoTokenRef.current = out.sudoToken;
      applyConfig(out.result);
      setNotice({ type: "success", text: t("webdav.configCleared") });
    } catch (error) {
      setNotice({ type: "error", text: t("webdav.clearFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setBusy(null);
    }
  }, [applyConfig, askPassword, t]);

  const insecureHttp = endpoint.trim().toLowerCase().startsWith("http://");
  const disabled = busy !== null || loading;

  return (
    <div className="rounded-lg border border-sky-200 bg-white p-3 dark:border-sky-900/60 dark:bg-zinc-900/60">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown size={14} className="text-zinc-400" /> : <ChevronRight size={14} className="text-zinc-400" />}
        <Cloud size={15} className="text-sky-500" />
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("webdav.panelTitle")}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${config?.enabled
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
          {config?.enabled ? t("webdav.enabled") : t("webdav.disabled")}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
          <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] leading-5 text-blue-700 dark:border-blue-900/50 dark:bg-blue-500/10 dark:text-blue-300">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" />
            <span>{t("webdav.safetyHint")}</span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                className="h-4 w-4 accent-sky-600"
              />
              {t("webdav.enableChannel")}
            </label>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={disabled}
              className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-sky-600 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />{t("webdav.refreshStatus")}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="mb-1 block text-[11px] text-zinc-500">{t("webdav.address")}</span>
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://dav.example.com/remote.php/dav/files/user/"
                className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
              />
            </label>
            <label>
              <span className="mb-1 block text-[11px] text-zinc-500">{t("webdav.username")}</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={t("webdav.usernamePlaceholder")}
                autoComplete="username"
                className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
              />
            </label>
            <label>
              <span className="mb-1 block text-[11px] text-zinc-500">{t("webdav.passwordOrAppPassword")}</span>
              <span className="relative block">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={config?.passwordSet ? t("webdav.encryptedPasswordHint") : t("webdav.passwordPlaceholder")}
                  autoComplete="new-password"
                  className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-2 pr-9 text-xs text-zinc-800 outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                  aria-label={showPassword ? t("webdav.hidePassword") : t("webdav.showPassword")}
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
            </label>
            <label className="sm:col-span-2">
              <span className="mb-1 block text-[11px] text-zinc-500">{t("webdav.remoteDirectory")}</span>
              <input
                value={remotePath}
                onChange={(event) => setRemotePath(event.target.value)}
                placeholder="nowen-note/backups"
                className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs text-zinc-800 outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
              />
            </label>
          </div>

          {insecureHttp && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-700 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {t("webdav.httpWarning")}
            </div>
          )}

          <label className="flex items-start gap-2 rounded-md bg-zinc-50 px-2.5 py-2 text-xs text-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={uploadOnAutoBackup}
              onChange={(event) => setUploadOnAutoBackup(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-sky-600"
            />
            <span>
              <span className="block font-medium">{t("webdav.uploadAuto")}</span>
              <span className="mt-0.5 block text-[11px] text-zinc-500">{t("webdav.uploadAutoHint")}</span>
            </span>
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {t("webdav.saveConfig")}
            </button>
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-500/10"
            >
              {busy === "test" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {t("webdav.testConnection")}
            </button>
            {config?.configured && (
              <button
                type="button"
                onClick={() => void handleClear()}
                disabled={disabled}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-500/10"
              >
                {busy === "clear" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                {t("webdav.clearConfig")}
              </button>
            )}
          </div>

          {config?.configured && (
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-[11px] text-zinc-600 sm:grid-cols-2 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400">
              <div><span className="text-zinc-400">{t("webdav.remoteDirLabel")}</span><span className="break-all font-mono">{config.remoteDirectory || "-"}</span></div>
              <div><span className="text-zinc-400">{t("webdav.lastTest")}</span>{formatTime(config.status.lastTestAt, t("webdav.neverExecuted"), i18n.language)}{config.status.lastTestOk === true ? t("webdav.statusSuccess") : config.status.lastTestOk === false ? t("webdav.statusFailed") : ""}</div>
              <div><span className="text-zinc-400">{t("webdav.lastUpload")}</span>{formatTime(config.status.lastUploadAt, t("webdav.neverExecuted"), i18n.language)}</div>
              <div><span className="text-zinc-400">{t("webdav.lastFile")}</span><span className="break-all font-mono">{config.status.lastFilename || "-"}</span></div>
              {config.status.lastError && <div className="sm:col-span-2 text-red-500"><span className="text-red-400">{t("webdav.lastError")}</span>{config.status.lastError}</div>}
            </div>
          )}

          <div className="border-t border-zinc-200 pt-3 dark:border-zinc-700">
            <div className="mb-2 flex items-center gap-2">
              <UploadCloud size={14} className="text-sky-500" />
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{t("webdav.manualUpload")}</span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                value={selectedBackup}
                onChange={(event) => setSelectedBackup(event.target.value)}
                disabled={disabled || backups.length === 0}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
              >
                {backups.length === 0 && <option value="">{t("webdav.noLocalBackups")}</option>}
                {backups.map((row) => (
                  <option key={row.filename} value={row.filename}>
                    {row.filename} · {formatBytes(row.size)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleUpload()}
                disabled={disabled || !config?.enabled || !selectedBackup}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                title={!config?.enabled ? t("webdav.enableFirst") : undefined}
              >
                {busy === "upload" ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
                {t("webdav.uploadToWebdav")}
              </button>
            </div>
          </div>

          <NoticeBox notice={notice} />
        </div>
      )}
    </div>
  );
}

export default function BackupWebDavBridge() {
  const host = useBackupHost();
  return host ? createPortal(<BackupWebDavPanel />, host) : null;
}
