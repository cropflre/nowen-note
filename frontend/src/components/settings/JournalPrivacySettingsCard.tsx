import React, { useCallback, useEffect, useState } from "react";
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
      <section className="space-y-4" data-settings-section="journal-privacy">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-indigo-500" />
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{t("settings.journalPrivacyTitle")}</h3>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          {t("settings.journalPrivacyDesc")}
        </p>

        <div className="max-w-2xl space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-700 dark:bg-zinc-800/40">
          <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              {loading ? (
                <><Loader2 size={14} className="animate-spin text-zinc-400" /><span className="text-zinc-500">…</span></>
              ) : (
                <>
                  <span className={protectedNow ? "font-medium text-emerald-600 dark:text-emerald-400" : "font-medium text-zinc-600 dark:text-zinc-300"}>
                    {protectedNow ? t("settings.journalPrivacyProtected") : t("settings.journalPrivacyUnprotected")}
                  </span>
                  {protectedNow && status?.unlocked && <span className="text-xs text-zinc-400">· 当前会话已解锁</span>}
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => void managePassword()}
              disabled={loading || preparing}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 hover:border-accent-primary/40 hover:text-accent-primary disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              {preparing ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
              {preparing
                ? t("settings.journalPrivacyPreparing")
                : protectedNow
                  ? t("settings.journalPrivacyManage")
                  : t("settings.journalPrivacySetPassword")}
            </button>
          </div>

          <label className={`flex items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-white px-3 py-3 dark:border-zinc-700 dark:bg-zinc-900 ${protectedNow ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {t("settings.journalLockOnEntry")}
              </span>
              <span className="mt-1 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {t("settings.journalLockOnEntryDesc")}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={prefs.journalLockOnEntry}
              disabled={!protectedNow}
              onChange={(event) => setPref("journalLockOnEntry", event.target.checked)}
              className="accent-indigo-600"
            />
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
