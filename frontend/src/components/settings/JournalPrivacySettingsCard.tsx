import React, { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import FolderPasswordDialog from "@/components/FolderPasswordDialog";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

type PrivacyStatus = Awaited<ReturnType<typeof api.journals.getPrivacyStatus>>;
type PrivacyNode = {
  id: string;
  title: string;
  isPasswordProtected: number;
};

export default function JournalPrivacySettingsCard() {
  const { t } = useTranslation();
  const { prefs, setPref } = useUserPreferences();
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [passwordNode, setPasswordNode] = useState<PrivacyNode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.journals.getPrivacyStatus());
    } catch (caughtError: unknown) {
      const error = caughtError as Error & { code?: string };
      console.error("[JournalPrivacySettings] load failed", error);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const managePassword = async () => {
    if (preparing) return;
    setPreparing(true);
    try {
      let next = status;
      if (!next?.isPasswordProtected) {
        // Before protecting the root, normalize all legacy personal journals under
        // the stable Personal Journal archive so none are left outside the lock.
        await api.journals.organizeArchive();
      }
      next = await api.journals.ensurePrivacyRoot();
      setStatus(next);
      if (!next.rootNodeId) throw new Error("无法创建个人日记根目录");
      setPasswordNode({
        id: next.rootNodeId,
        title: next.title || "个人日记",
        isPasswordProtected: next.isPasswordProtected ? 1 : 0,
      });
    } catch (caughtError: unknown) {
      const error = caughtError as Error & { code?: string };
      toast.error(error?.message || "准备日记隐私设置失败");
    } finally {
      setPreparing(false);
    }
  };

  const handlePasswordChanged = async (_nodeId: string, protectedNow: boolean) => {
    setPasswordNode(null);
    if (!protectedNow && prefs.journalLockOnEntry) {
      setPref("journalLockOnEntry", false);
    }
    await load();
    toast.success(protectedNow ? "日记隐私锁已启用" : "日记隐私锁已关闭");
  };

  const protectedNow = status?.isPasswordProtected === true;

  return (
    <>
      <section
        id="security-journal-privacy"
        className="max-w-2xl rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm transition-shadow hover:shadow-md"
        data-settings-section="journal-privacy"
      >
        <div className="mb-4 flex items-start gap-3">
          <motion.span
            whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
            transition={{ duration: 0.4 }}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/20 via-teal-400/18 to-sky-500/18 text-emerald-600 ring-1 ring-emerald-500/25 dark:text-emerald-300"
          >
            <ShieldCheck className="h-5 w-5" />
          </motion.span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold tracking-tight text-tx-primary">{t("settings.journalPrivacyTitle")}</h3>
              {!loading && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                    protectedNow
                      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                      : "bg-app-hover text-tx-tertiary"
                  }`}
                >
                  {protectedNow && (
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    </span>
                  )}
                  {protectedNow ? t("settings.journalPrivacyProtected") : t("settings.journalPrivacyUnprotected")}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-tx-secondary">
              {t("settings.journalPrivacyDesc")}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-col gap-3 rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              {loading ? (
                <><Loader2 size={14} className="animate-spin text-tx-tertiary" /><span className="text-tx-tertiary">…</span></>
              ) : (
                <>
                  <span className={protectedNow ? "font-semibold text-emerald-600 dark:text-emerald-400" : "font-medium text-tx-secondary"}>
                    {protectedNow ? t("settings.journalPrivacyProtected") : t("settings.journalPrivacyUnprotected")}
                  </span>
                  {protectedNow && status?.unlocked && (
                    <span className="rounded-full bg-app-hover px-2 py-0.5 text-[11px] text-tx-tertiary">当前会话已解锁</span>
                  )}
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => void managePassword()}
              disabled={loading || preparing}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs font-semibold text-emerald-700 transition-all hover:bg-emerald-500/18 active:scale-95 disabled:opacity-50 dark:text-emerald-300"
            >
              {preparing ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
              {preparing
                ? t("settings.journalPrivacyPreparing")
                : protectedNow
                  ? t("settings.journalPrivacyManage")
                  : t("settings.journalPrivacySetPassword")}
            </button>
          </div>

          <label
            className={`flex items-center justify-between gap-4 rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5 transition-colors ${
              protectedNow ? "cursor-pointer hover:border-emerald-400/35" : "cursor-not-allowed opacity-60"
            }`}
          >
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-tx-primary">
                {t("settings.journalLockOnEntry")}
              </span>
              <span className="mt-1 block text-[11px] leading-5 text-tx-tertiary">
                {t("settings.journalLockOnEntryDesc")}
              </span>
            </span>
            <span className="relative inline-flex shrink-0 items-center">
              <input
                type="checkbox"
                role="switch"
                checked={prefs.journalLockOnEntry}
                disabled={!protectedNow}
                onChange={(event) => setPref("journalLockOnEntry", event.target.checked)}
                className="peer sr-only"
              />
              <span className="h-6 w-11 rounded-full bg-app-border transition-colors peer-checked:bg-gradient-to-r peer-checked:from-emerald-500 peer-checked:to-teal-500 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-primary" />
              <span className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
            </span>
          </label>
        </div>
      </section>

      {passwordNode && (
        <FolderPasswordDialog
          node={passwordNode}
          mode="manage"
          onClose={() => setPasswordNode(null)}
          onChanged={(nodeId, protectedValue) => void handlePasswordChanged(nodeId, protectedValue)}
          onUnlocked={() => {}}
        />
      )}
    </>
  );
}
