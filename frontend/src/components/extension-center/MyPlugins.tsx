import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, Loader2, PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUserRole } from "@/hooks/useCurrentUserRole";
import { pushAppPathState } from "@/lib/appPathNavigation";
import type { ExtensionInstallState, ExtensionListing } from "@/lib/extensionCatalog";
import { cn } from "@/lib/utils";
import { ExtensionCard } from "./ExtensionCard";
import { ExtensionDetailDrawer } from "./ExtensionDetailDrawer";
import { CardSkeletons, Notice } from "./ExtensionDiscover";
import { useExtensionActionRunner } from "./useExtensionActionRunner";
import { useExtensionCatalog } from "./useExtensionCatalog";

const PluginManagementPanel = lazy(() => import("../PluginManagementPanel"));

const STATE_ORDER: Record<ExtensionInstallState, number> = { pending: 0, error: 1, incompatible: 2, enabled: 3, disabled: 4, "not-installed": 5, builtin: 6 };

export default function MyPlugins({ dashboardAvailable, appPagesAvailable }: { dashboardAvailable: boolean; appPagesAvailable: boolean }) {
  const { t } = useTranslation();
  const { role, retry } = useCurrentUserRole();
  const isAdmin = role.status === "ready" && role.isAdmin;
  const [view, setView] = useState<"installed" | "advanced">("installed");
  const { state, reload } = useExtensionCatalog({ enabled: role.status === "ready" && view === "installed", isAdmin, dashboardAvailable });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const runner = useExtensionActionRunner(useCallback((listing: ExtensionListing) => setSelectedKey(listing.key), []));
  const fileInput = useRef<HTMLInputElement>(null);
  const installed = useMemo(() => state.listings
    .filter((listing) => listing.kind === "plugin" && listing.installed)
    .sort((a, b) => STATE_ORDER[a.installState] - STATE_ORDER[b.installState] || a.name.localeCompare(b.name)), [state.listings]);
  const selected = selectedKey ? state.listings.find((listing) => listing.key === selectedKey && listing.installed) || null : null;
  useEffect(() => { if (selectedKey && state.status === "ready" && !selected) setSelectedKey(null); }, [selected, selectedKey, state.status]);
  useEffect(() => { if (!isAdmin) setView("installed"); }, [isAdmin]);

  if (role.status === "failed") {
    return <Notice tone="danger" icon={AlertTriangle} action={<Button size="sm" variant="outline" onClick={retry}>{t("extensionCenter.discover.retry")}</Button>}>{t("extensionCenter.error.identity")}</Notice>;
  }
  const loading = role.status === "loading" || state.status === "loading" || state.status === "idle";
  const tab = (value: "installed" | "advanced") => cn(
    "inline-flex min-h-11 items-center rounded-md px-3 text-sm md:min-h-9",
    view === value ? "bg-app-surface font-medium text-tx-primary shadow-sm" : "text-tx-secondary hover:text-tx-primary",
  );

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-tx-primary">{t("extensionCenter.myPlugins.heading")}</h2>
        <p className="mt-1 text-sm text-tx-secondary">{view === "advanced" ? t("extensionCenter.myPlugins.advancedHint") : t("extensionCenter.myPlugins.description")}</p>
      </div>
      {isAdmin && view === "installed" && <>
        <input ref={fileInput} type="file" accept=".nowen-plugin" className="hidden" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void runner.installPackage(file);
        }} />
        <Button size="sm" className="min-h-11 shrink-0 md:min-h-9" disabled={runner.busyKey === "package"} onClick={() => fileInput.current?.click()}>
          {runner.busyKey === "package" ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <PackagePlus size={14} className="mr-1.5" />}{t("pluginApps.install")}
        </Button>
      </>}
    </div>

    {isAdmin && <div role="group" aria-label={t("extensionCenter.myPlugins.heading")} className="inline-flex gap-1 rounded-lg bg-app-hover p-1">
      <button type="button" aria-pressed={view === "installed"} onClick={() => setView("installed")} className={tab("installed")}>{t("extensionCenter.myPlugins.installed")}</button>
      <button type="button" aria-pressed={view === "advanced"} onClick={() => setView("advanced")} className={tab("advanced")}>{t("extensionCenter.myPlugins.advanced")}</button>
    </div>}
    {role.status === "ready" && !isAdmin && <Notice tone="info" icon={Info}>{t("extensionCenter.myPlugins.memberHint")}</Notice>}

    {view === "advanced"
      ? <Suspense fallback={<p role="status" className="text-sm text-tx-tertiary">{t("extensionCenter.myPlugins.loading")}</p>}><PluginManagementPanel /></Suspense>
      : loading ? <div role="status" aria-label={t("extensionCenter.myPlugins.loading")}><CardSkeletons count={3} /></div>
        : state.status === "error" ? <Notice tone="danger" icon={AlertTriangle} action={<Button size="sm" variant="outline" onClick={reload}>{t("extensionCenter.discover.retry")}</Button>}>{t("extensionCenter.myPlugins.failed", { message: state.error })}</Notice>
          : installed.length
            ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{installed.map((listing) => <ExtensionCard key={listing.key} listing={listing} busy={runner.busyKey === listing.key} onAction={runner.run} />)}</div>
            : <div className="rounded-2xl border border-dashed border-app-border px-4 py-12 text-center">
              <p className="text-sm text-tx-secondary">{t("extensionCenter.myPlugins.empty")}</p>
              <Button size="sm" variant="outline" className="mt-4 min-h-11 md:min-h-9" onClick={() => pushAppPathState("/apps/discover")}>{t("extensionCenter.myPlugins.browse")}</Button>
            </div>}

    <AnimatePresence>
      {selected && <ExtensionDetailDrawer key={selected.key} listing={selected} isAdmin={isAdmin} appPagesAvailable={appPagesAvailable}
        busy={runner.busyKey === selected.key} onClose={() => setSelectedKey(null)} onAction={runner.run} />}
    </AnimatePresence>
  </div>;
}
