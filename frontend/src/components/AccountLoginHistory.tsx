import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, LogIn, Pencil, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type AccountLoginHistoryItem,
  CURRENT_ACCOUNT_HISTORY_ID_KEY,
  isAccountLoginHistorySupported,
  listAccountLoginHistory,
  removeAccountLoginHistory,
  updateAccountLoginHistoryServerUrl,
} from "@/lib/accountLoginHistory";
import { switchAccountLogin } from "@/lib/accountLoginSwitch";
import { getServerUrl, setServerUrl } from "@/lib/api";
import { normalizeServerBaseUrl } from "@/lib/serverUrl";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { User } from "@/types";
import { clearAuthTokens } from "@/lib/authSession";

function serverLabel(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return serverUrl;
  }
}

function initials(item: AccountLoginHistoryItem): string {
  return (item.displayName || item.username).trim().slice(0, 1).toUpperCase() || "?";
}

async function probeNowenServer(serverUrl: string): Promise<boolean> {
  const healthUrl = `${serverUrl}/api/health`;
  const desktopHttp = (window as any).nowenDesktop?.http?.requestJson;
  if (typeof desktopHttp === "function") {
    try {
      const result = await desktopHttp({ url: healthUrl, method: "GET", headers: {} });
      if (!result?.ok || !Number.isFinite(result.status) || result.status < 200 || result.status >= 300) {
        return false;
      }
      const body = typeof result.body === "string" ? JSON.parse(result.body || "{}") : result.body;
      return body?.status === "ok";
    } catch {
      return false;
    }
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await globalThis.fetch(healthUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.status === "ok";
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function AccountLoginHistoryList({
  className,
  onBeforeSwitch,
  onSwitched,
  onRequiresReauth,
  title,
}: {
  className?: string;
  onBeforeSwitch?: () => void;
  onSwitched?: (token: string, user: User) => void;
  onRequiresReauth?: (account: AccountLoginHistoryItem, message?: string) => void;
  title?: string;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AccountLoginHistoryItem[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ item: AccountLoginHistoryItem; isCurrent: boolean } | null>(null);
  const [serverDraft, setServerDraft] = useState("");
  const [savingServer, setSavingServer] = useState(false);
  const [serverError, setServerError] = useState("");
  const supported = isAccountLoginHistorySupported();

  const refresh = useCallback(() => {
    if (!supported) return;
    void listAccountLoginHistory().then(setItems).catch(() => setItems([]));
  }, [supported]);

  useEffect(() => {
    refresh();
    window.addEventListener("nowen:account-history-changed", refresh);
    return () => window.removeEventListener("nowen:account-history-changed", refresh);
  }, [refresh]);

  useEffect(() => {
    if (items.length <= 2) setExpanded(false);
  }, [items.length]);

  if (!supported || items.length === 0) return null;

  const currentServer = getServerUrl().replace(/\/+$/, "").toLowerCase();
  const hasActiveToken = !!localStorage.getItem("nowen-token");
  const currentHistoryId = localStorage.getItem(CURRENT_ACCOUNT_HISTORY_ID_KEY) || "";
  const isCollapsible = !!title && items.length > 2;
  const visibleItems = isCollapsible && !expanded ? items.slice(0, 2) : items;
  let currentMarked = false;

  const handleSwitch = async (item: AccountLoginHistoryItem) => {
    if (loadingId || savingServer) return;
    setLoadingId(item.id);
    onBeforeSwitch?.();
    const result = await switchAccountLogin(item);
    if (result.status === "switched") {
      if (onSwitched) {
        onSwitched(result.token, result.user);
        return;
      }
      // 工作台内切换账号需要重建所有用户级 store；登录页则通过 onSwitched
      // 直接建立认证态，避免整页白闪和启动阶段的重复鉴权。
      window.location.reload();
      return;
    }
    if (result.status === "requires_reauth") {
      if (onRequiresReauth) {
        onRequiresReauth(item, result.message);
        setLoadingId(null);
        refresh();
        return;
      }
      window.location.reload();
      return;
    }
    toast.error(result.status === "storage_error"
      ? t("auth.loginHistory.storageFailed")
      : result.message || t("auth.loginHistory.connectFailed"));
    setLoadingId(null);
  };

  const handleRemove = async (event: React.MouseEvent, item: AccountLoginHistoryItem) => {
    event.stopPropagation();
    if (!window.confirm(t("auth.loginHistory.removeConfirm", { username: item.username }))) return;
    const result = await removeAccountLoginHistory(item.id);
    if (!result.ok) toast.error(t("auth.loginHistory.removeFailed"));
  };

  const handleEdit = (event: React.MouseEvent, item: AccountLoginHistoryItem, isCurrent: boolean) => {
    event.stopPropagation();
    if (loadingId || savingServer) return;
    setEditing({ item, isCurrent });
    setServerDraft(item.serverUrl);
    setServerError("");
  };

  const closeEditor = () => {
    if (savingServer) return;
    setEditing(null);
    setServerDraft("");
    setServerError("");
  };

  const handleSaveServer = async () => {
    if (!editing || savingServer) return;
    const normalized = normalizeServerBaseUrl(serverDraft);
    if (!normalized) {
      setServerError(t("auth.serverRequired"));
      return;
    }
    if (normalized === normalizeServerBaseUrl(editing.item.serverUrl)) {
      closeEditor();
      return;
    }

    setSavingServer(true);
    setServerError("");
    const reachable = await probeNowenServer(normalized);
    if (!reachable) {
      setServerError(t("auth.loginHistory.connectFailed"));
      setSavingServer(false);
      return;
    }

    const result = await updateAccountLoginHistoryServerUrl(editing.item.id, normalized);
    if (!result.ok) {
      setServerError(result.error === "TOKEN_UNAVAILABLE"
        ? t("auth.loginHistory.sessionExpired")
        : t("auth.loginHistory.storageFailed"));
      setSavingServer(false);
      return;
    }

    if (editing.isCurrent) {
      // 当前账号只改连接端点，不清 Token / 不清本地数据。重载后所有 API、Realtime
      // 与同步 Runtime 都会基于新 serverUrl 重新建立连接。
      setServerUrl(normalized);
      if (result.id) {
        try { localStorage.setItem(CURRENT_ACCOUNT_HISTORY_ID_KEY, result.id); } catch { /* ignore */ }
      }
      setEditing(null);
      window.location.reload();
      return;
    }

    setSavingServer(false);
    setEditing(null);
    setServerDraft("");
    refresh();
  };

  return (
    <>
      <div className={cn("space-y-1.5", className)} data-account-login-history>
        {title && (
          <div className="flex min-h-6 items-center justify-between gap-3 px-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-xs font-medium text-tx-secondary">{title}</p>
              <span className="rounded-full bg-app-hover px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-tx-tertiary">
                {items.length}
              </span>
            </div>
            {isCollapsible && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
              >
                {t(expanded ? "auth.loginHistory.collapse" : "auth.loginHistory.showAll")}
                <ChevronDown size={13} className={cn("transition-transform", expanded && "rotate-180")} />
              </button>
            )}
          </div>
        )}
        <div className={cn("space-y-1.5", isCollapsible && expanded && "max-h-52 overflow-y-auto pr-1")}>
          {visibleItems.map((item) => {
            const sameServer = item.serverUrl.replace(/\/+$/, "").toLowerCase() === currentServer;
            const isCurrent = hasActiveToken && (
              currentHistoryId ? item.id === currentHistoryId : sameServer && !currentMarked
            );
            if (isCurrent) currentMarked = true;
            return (
              <div
                key={item.id}
                className="group flex w-full items-center gap-1 rounded-lg border border-app-border bg-app-surface p-1 text-left transition-colors hover:border-accent-primary/25 hover:bg-app-hover"
              >
                <button
                  type="button"
                  onClick={() => void handleSwitch(item)}
                  disabled={!!loadingId || savingServer || isCurrent}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-0.5 text-left disabled:cursor-default disabled:opacity-70"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-xs font-semibold text-accent-primary">
                    {item.avatarUrl ? <img src={item.avatarUrl} alt="" className="h-8 w-8 rounded-lg object-cover" /> : initials(item)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-tx-primary">{item.displayName || item.username}</span>
                      {isCurrent && <span className="shrink-0 rounded bg-accent-primary/10 px-1.5 py-0.5 text-[10px] text-accent-primary">{t("common.current")}</span>}
                      {item.requiresReauth && <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">{t("auth.loginHistory.reauth")}</span>}
                    </span>
                    <span className="block truncate text-xs text-tx-tertiary">@{item.username} · {serverLabel(item.serverUrl)}</span>
                  </span>
                  {loadingId === item.id ? (
                    <Loader2 size={16} className="shrink-0 animate-spin text-accent-primary" />
                  ) : isCurrent ? null : (
                    <LogIn size={16} className="shrink-0 text-tx-tertiary group-hover:text-accent-primary" />
                  )}
                </button>
                <button
                  type="button"
                  title={t("auth.serverAddress")}
                  aria-label={t("auth.serverAddress")}
                  onClick={(event) => handleEdit(event, item, isCurrent)}
                  disabled={!!loadingId || savingServer}
                  className="rounded-md p-1 text-tx-tertiary opacity-60 transition-colors hover:bg-accent-primary/10 hover:text-accent-primary hover:opacity-100 disabled:pointer-events-none disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-60 sm:focus-visible:opacity-100"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  disabled={isCurrent || savingServer}
                  title={t("auth.loginHistory.remove")}
                  aria-label={t("auth.loginHistory.remove")}
                  onClick={(event) => void handleRemove(event, item)}
                  className="rounded-md p-1 text-tx-tertiary opacity-60 transition-colors hover:bg-accent-danger/10 hover:text-accent-danger hover:opacity-100 disabled:pointer-events-none disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-60 sm:focus-visible:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {editing && (
        <div
          className="fixed inset-0 z-[240] flex items-end justify-center bg-black/35 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("auth.serverAddress")}
          onMouseDown={closeEditor}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl border border-app-border bg-app-elevated p-4 shadow-2xl sm:rounded-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-tx-primary">{t("auth.serverAddress")}</h3>
                <p className="mt-0.5 truncate text-xs text-tx-tertiary">
                  {editing.item.displayName || editing.item.username} · @{editing.item.username}
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                disabled={savingServer}
                className="rounded-lg p-1.5 text-tx-tertiary hover:bg-app-hover disabled:opacity-40"
                aria-label={t("common.close")}
              >
                <X size={16} />
              </button>
            </div>

            <label className="mb-1.5 block text-xs font-medium text-tx-secondary">{t("auth.serverAddress")}</label>
            <input
              data-account-server-input
              autoFocus
              value={serverDraft}
              onChange={(event) => {
                setServerDraft(event.target.value);
                if (serverError) setServerError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSaveServer();
                }
              }}
              placeholder={t("auth.serverPlaceholder")}
              className="w-full rounded-xl border border-app-border bg-app-bg px-3 py-2.5 text-sm text-tx-primary outline-none transition-colors placeholder:text-tx-tertiary focus:border-accent-primary"
            />
            <p className="mt-1.5 text-[11px] leading-4 text-tx-tertiary">{t("auth.serverHint")}</p>
            {serverError && (
              <p className="mt-2 rounded-lg bg-accent-danger/10 px-2.5 py-2 text-xs text-accent-danger">{serverError}</p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                data-account-server-cancel
                onClick={closeEditor}
                disabled={savingServer}
                className="flex-1 rounded-xl border border-app-border px-3 py-2 text-sm font-medium text-tx-secondary hover:bg-app-hover disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                data-account-server-save
                onClick={() => void handleSaveServer()}
                disabled={savingServer}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
              >
                {savingServer && <Loader2 size={14} className="animate-spin" />}
                {savingServer ? t("common.loading") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function AccountLoginHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  if (!open) return null;

  const handleAddAccount = () => {
    try {
      clearAuthTokens();
      localStorage.setItem("nowen-prefer-cloud", "1");
      window.dispatchEvent(new CustomEvent("nowen:token-changed"));
    } catch { /* ignore */ }
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-[220] flex items-end justify-center bg-black/35 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={t("auth.loginHistory.title")} onMouseDown={onClose}>
      <div className="max-h-[78dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-app-border bg-app-elevated p-4 shadow-2xl sm:rounded-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UsersRound size={18} className="text-accent-primary" />
            <h2 className="text-base font-semibold text-tx-primary">{t("auth.loginHistory.title")}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover" aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <AccountLoginHistoryList onBeforeSwitch={onClose} />
        <button type="button" onClick={handleAddAccount} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-app-border px-3 py-2.5 text-sm text-tx-secondary hover:border-accent-primary/50 hover:bg-app-hover hover:text-accent-primary">
          <UserPlus size={16} />
          {t("auth.loginHistory.addAccount")}
        </button>
      </div>
    </div>
  );
}
