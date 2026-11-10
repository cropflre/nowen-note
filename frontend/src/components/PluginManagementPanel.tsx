import React, { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCurrentUserRole } from "@/hooks/useCurrentUserRole";

const PluginSettingsTab = lazy(() => import("./settings/plugins/PluginSettingsTab"));

export default function PluginManagementPanel() {
  const { t } = useTranslation();
  const { role, retry } = useCurrentUserRole();
  if (role.status === "failed") return <div role="alert"><p>{t("pluginApps.managementFailed")}</p><button type="button" onClick={retry} className="mt-3 rounded border border-app-border px-3 py-2">{t("pluginApps.retry")}</button></div>;
  const loading = <div role="status" className="flex items-center gap-2 p-4"><Loader2 size={16} className="animate-spin" />{t("pluginApps.loading")}</div>;
  if (role.status !== "ready") return loading;
  return <Suspense fallback={loading}><PluginSettingsTab isAdmin={role.isAdmin} /></Suspense>;
}
