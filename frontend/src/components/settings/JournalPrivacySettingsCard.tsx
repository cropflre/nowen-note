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
    } catch (error: any) {
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
    } catch (error: any) {
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
      <section className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-800/30" data-settings-section="journal-privacy">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              <ShieldCheck size={15} className="text-accent-primary" />
              {t("settings.journalPrivacyTitle")}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
              {t("settings.journalPrivacyDesc")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void managePassword()}
            disabled={loading || preparing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-accent-primary/40 hover:text-accent-primary disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {preparing ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
            {preparing
              ? t("settings.journalPrivacyPreparing")
              : protectedNow
                ? t("settings.journalPrivacyManage")
                : t("settings.journalPrivacySetPassword")}
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs dark:bg-zinc-900/40">
          {loading ? (
            <><Loader2 size={12} className="animate-spin text-zinc-400" /><span className="text-zinc-500">…</span></>
          ) : (
            <>
              <span className={protectedNow ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"}>
                {protectedNow ? t("settings.journalPrivacyProtected") : t("settings.journalPrivacyUnprotected")}
              </span>
              {protectedNow && status?.unlocked && <span className="text-[10px] text-zinc-400">· 当前会话已解锁</span>}
            </>
          )}
        </div>

        <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1">
          <input
            type="checkbox"
            checked={prefs.journalLockOnEntry}
            disabled={!protectedNow}
            onChange={(event) => setPref("journalLockOnEntry", event.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
              {t("settings.journalLockOnEntry")}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
              {t("settings.journalLockOnEntryDesc")}
            </p>
          </div>
        </label>
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
