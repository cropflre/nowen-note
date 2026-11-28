import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft } from "lucide-react";
import { AccountLoginHistoryDialog } from "@/components/AccountLoginHistory";
import { broadcastLogout } from "@/lib/api";
import { isMobileLocalMode, requestMobileAccountLogin } from "@/lib/mobileLocalMode";

export default function MobileAccountSettings({ accountLabel }: { accountLabel?: string }) {
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const localOnly = isMobileLocalMode();

  return <section className="space-y-3.5 rounded-2xl border border-app-border/80 bg-app-surface/85 p-5 shadow-sm backdrop-blur-md">
    <h3 className="text-sm font-semibold tracking-tight">{t("mobileAccount.title")}</h3>
    <p className="text-sm font-medium text-tx-secondary">
      {localOnly ? t("mobileAccount.notSignedIn") : accountLabel || t("mobileAccount.currentLogin")}
    </p>
    {localOnly ? <>
      <p className="text-xs leading-relaxed text-tx-tertiary">{t("mobileAccount.localOnlyHint")}</p>
      <button type="button" className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-indigo-500/25 transition-all hover:brightness-105 active:scale-[0.98]" onClick={() => {
        requestMobileAccountLogin();
        window.location.reload();
      }}>{t("mobileAccount.signInAndSync")}</button>
    </> : <div className="flex flex-wrap gap-2.5">
      <button type="button" className="flex min-h-11 items-center gap-2 rounded-xl border border-app-border/90 bg-app-bg/75 px-3.5 py-2 text-sm font-medium shadow-xs transition-all hover:border-indigo-400/50 hover:bg-indigo-500/[0.06] active:scale-[0.98]" onClick={() => setHistoryOpen(true)}><ArrowRightLeft size={16} />{t("mobileAccount.switchAccount")}</button>
      <button type="button" className="rounded-xl border border-red-300/60 bg-red-500/[0.06] px-3.5 py-2 text-sm font-medium text-accent-danger transition-all hover:bg-red-500/12 active:scale-[0.98]" onClick={async () => {
        if (!window.confirm(t("mobileAccount.signOutConfirm"))) return;
        await broadcastLogout("user_logout");
        window.location.reload();
      }}>{t("mobileAccount.signOut")}</button>
    </div>}
    <AccountLoginHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
  </section>;
}
