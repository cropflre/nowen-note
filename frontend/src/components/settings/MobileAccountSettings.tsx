import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AccountLoginHistoryDialog } from "@/components/AccountLoginHistory";
import { broadcastLogout } from "@/lib/api";
import { isMobileLocalMode, requestMobileAccountLogin } from "@/lib/mobileLocalMode";

export default function MobileAccountSettings({ accountLabel }: { accountLabel?: string }) {
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const localOnly = isMobileLocalMode();

  return <section className="space-y-3 rounded-lg border border-app-border p-4">
    <h3 className="text-sm font-medium">{t("mobileAccount.title")}</h3>
    <p className="text-sm text-tx-secondary">
      {localOnly ? t("mobileAccount.notSignedIn") : accountLabel || t("mobileAccount.currentLogin")}
    </p>
    {localOnly ? <>
      <p className="text-xs text-tx-tertiary">{t("mobileAccount.localOnlyHint")}</p>
      <button type="button" className="rounded-md border border-app-border px-3 py-2 text-sm" onClick={() => {
        requestMobileAccountLogin();
        window.location.reload();
      }}>{t("mobileAccount.signInAndSync")}</button>
    </> : <div className="flex flex-wrap gap-2">
      <button type="button" className="rounded-md border border-app-border px-3 py-2 text-sm" onClick={() => setHistoryOpen(true)}>{t("mobileAccount.loginHistory")}</button>
      <button type="button" className="rounded-md border border-app-border px-3 py-2 text-sm text-accent-danger" onClick={async () => {
        if (!window.confirm(t("mobileAccount.signOutConfirm"))) return;
        await broadcastLogout("user_logout");
        window.location.reload();
      }}>{t("mobileAccount.signOut")}</button>
    </div>}
    <AccountLoginHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
  </section>;
}
