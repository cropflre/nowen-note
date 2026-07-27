import React, { useCallback, useEffect, useState } from "react";
import { Loader2, LogIn, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type AccountLoginHistoryItem,
  CURRENT_ACCOUNT_HISTORY_ID_KEY,
  isAccountLoginHistorySupported,
  listAccountLoginHistory,
  removeAccountLoginHistory,
} from "@/lib/accountLoginHistory";
import { switchAccountLogin } from "@/lib/accountLoginSwitch";
import { getServerUrl } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

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

export function AccountLoginHistoryList({
  className,
  onBeforeSwitch,
  title,
}: {
  className?: string;
  onBeforeSwitch?: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AccountLoginHistoryItem[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
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

  if (!supported || items.length === 0) return null;

  const currentServer = getServerUrl().replace(/\/+$/, "").toLowerCase();
  const hasActiveToken = !!localStorage.getItem("nowen-token");
  const currentHistoryId = localStorage.getItem(CURRENT_ACCOUNT_HISTORY_ID_KEY) || "";
  let currentMarked = false;

  const handleSwitch = async (item: AccountLoginHistoryItem) => {
    if (loadingId) return;
    setLoadingId(item.id);
    onBeforeSwitch?.();
    const result = await switchAccountLogin(item);
    if (result.status === "switched" || result.status === "requires_reauth") {
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

  return (
    <div className={cn("space-y-2", className)} data-account-login-history>
      {title && <p className="px-0.5 text-xs font-medium text-tx-secondary">{title}</p>}
      {items.map((item) => {
        const sameServer = item.serverUrl.replace(/\/+$/, "").toLowerCase() === currentServer;
        const isCurrent = hasActiveToken && (
          currentHistoryId ? item.id === currentHistoryId : sameServer && !currentMarked
        );
        if (isCurrent) currentMarked = true;
        return (
          <div
            key={item.id}
            className="group flex w-full items-center gap-1 rounded-xl border border-app-border bg-app-surface p-1.5 text-left hover:bg-app-hover transition-colors"
          >
            <button
              type="button"
              onClick={() => void handleSwitch(item)}
              disabled={!!loadingId || isCurrent}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1.5 py-1 text-left disabled:cursor-default disabled:opacity-70"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-primary/12 text-sm font-semibold text-accent-primary">
                {item.avatarUrl ? <img src={item.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" /> : initials(item)}
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
              disabled={isCurrent}
              title={t("auth.loginHistory.remove")}
              aria-label={t("auth.loginHistory.remove")}
              onClick={(event) => void handleRemove(event, item)}
              className="-mr-1 rounded-md p-1 text-tx-tertiary hover:bg-accent-danger/10 hover:text-accent-danger disabled:pointer-events-none disabled:opacity-30"
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function AccountLoginHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  if (!open) return null;

  const handleAddAccount = () => {
    try {
      localStorage.removeItem("nowen-token");
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
