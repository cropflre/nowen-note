import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, Loader2, RefreshCw, Search, WandSparkles, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUserRole } from "@/hooks/useCurrentUserRole";
import { pushAppPathState } from "@/lib/appPathNavigation";
import {
  EXTENSION_CATEGORIES, filterExtensionListings, pickFeaturedListings,
  type ExtensionCategory, type ExtensionListing,
} from "@/lib/extensionCatalog";
import { cn } from "@/lib/utils";
import { ExtensionCard } from "./ExtensionCard";
import { ExtensionDetailDrawer } from "./ExtensionDetailDrawer";
import { useExtensionActionRunner } from "./useExtensionActionRunner";
import { useExtensionCatalog } from "./useExtensionCatalog";

function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return online;
}

export function Notice({ tone, icon: Icon, children, action }: { tone: "info" | "warning" | "danger"; icon: React.ComponentType<{ size?: number; className?: string }>; children: React.ReactNode; action?: React.ReactNode }) {
  const toneClass = tone === "danger" ? "border-red-500/30 bg-red-500/5 text-red-800 dark:text-red-200"
    : tone === "warning" ? "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200"
      : "border-app-border bg-app-hover/60 text-tx-secondary";
  return <div role={tone === "info" ? "note" : "alert"} className={cn("flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2.5 text-sm", toneClass)}>
    <Icon size={16} className="shrink-0" /><span className="min-w-0 flex-1">{children}</span>{action}
  </div>;
}

export function CardSkeletons({ count = 6 }: { count?: number }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
    {Array.from({ length: count }, (_, index) => <div key={index} className="h-44 rounded-2xl border border-app-border bg-app-surface p-4">
      <div className="flex gap-3"><div className="h-10 w-10 rounded-xl bg-app-hover motion-safe:animate-pulse" /><div className="flex-1 space-y-2"><div className="h-3 w-2/3 rounded bg-app-hover motion-safe:animate-pulse" /><div className="h-3 w-1/3 rounded bg-app-hover motion-safe:animate-pulse" /></div></div>
      <div className="mt-5 h-3 w-full rounded bg-app-hover motion-safe:animate-pulse" /><div className="mt-2 h-3 w-4/5 rounded bg-app-hover motion-safe:animate-pulse" />
    </div>)}
  </div>;
}

/** Plugins first (official before others), then built-in feature cards. */
function sortForDiscovery(listings: ExtensionListing[]): ExtensionListing[] {
  return [...listings].sort((a, b) => Number(a.kind === "builtin") - Number(b.kind === "builtin")
    || Number(b.official) - Number(a.official)
    || a.name.localeCompare(b.name));
}

export default function ExtensionDiscover({ dashboardAvailable, appPagesAvailable }: { dashboardAvailable: boolean; appPagesAvailable: boolean }) {
  const { t } = useTranslation();
  const { role, retry } = useCurrentUserRole();
  const isAdmin = role.status === "ready" && role.isAdmin;
  const { state, reload } = useExtensionCatalog({ enabled: role.status === "ready", isAdmin, dashboardAvailable });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ExtensionCategory | "all">("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const runner = useExtensionActionRunner(useCallback((listing: ExtensionListing) => setSelectedKey(listing.key), []));
  const online = useOnline();
  const categoryLabel = useCallback((value: ExtensionCategory) => t(`extensionCenter.category.${value}`), [t]);
  const visible = useMemo(() => sortForDiscovery(filterExtensionListings(state.listings, { query, category }, categoryLabel)), [state.listings, query, category, categoryLabel]);
  const featured = useMemo(() => (!query.trim() && category === "all" ? pickFeaturedListings(state.listings) : []), [state.listings, query, category]);
  // Re-derive from the latest server state so the drawer never shows a stale install status.
  const selected = selectedKey ? state.listings.find((listing) => listing.key === selectedKey) || null : null;
  useEffect(() => { if (selectedKey && state.status === "ready" && !selected) setSelectedKey(null); }, [selected, selectedKey, state.status]);

  if (role.status === "failed") {
    return <Notice tone="danger" icon={AlertTriangle} action={<Button size="sm" variant="outline" onClick={retry}>{t("extensionCenter.discover.retry")}</Button>}>{t("extensionCenter.error.identity")}</Notice>;
  }
  const loading = role.status === "loading" || state.status === "loading" || state.status === "idle";
  const pill = (active: boolean) => cn(
    "inline-flex min-h-11 shrink-0 items-center rounded-full border px-3.5 text-sm transition-interactive duration-fast ease-standard md:min-h-9",
    active ? "border-accent-primary bg-accent-primary/10 font-medium text-accent-primary" : "border-app-border text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
  );

  return <div className="space-y-5">
    <section aria-labelledby="extension-discover-heading" className="rounded-2xl border border-app-border bg-gradient-to-br from-accent-primary/10 via-app-surface to-app-surface p-5 sm:p-6">
      <h2 id="extension-discover-heading" className="text-lg font-semibold text-tx-primary">{t("extensionCenter.discover.heading")}</h2>
      <p className="mt-1 max-w-2xl text-sm text-tx-secondary">{t("extensionCenter.discover.description")}</p>
      <label className="mt-4 flex max-w-2xl items-center gap-2 rounded-xl border border-app-border bg-app-bg px-3 focus-within:ring-1 focus-within:ring-accent-primary">
        <Search size={16} className="shrink-0 text-tx-tertiary" aria-hidden />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("extensionCenter.discover.searchLabel")}
          placeholder={t("extensionCenter.discover.searchPlaceholder")} className="h-11 min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary" />
      </label>
    </section>

    <div role="group" aria-label={t("extensionCenter.discover.categories")} className="flex min-w-0 gap-1.5 overflow-x-auto pb-1">
      {(["all", ...EXTENSION_CATEGORIES] as const).map((value) => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)} className={pill(category === value)}>
        {t(`extensionCenter.category.${value}`)}
      </button>)}
    </div>

    {!online && <Notice tone="warning" icon={WifiOff}>{t("extensionCenter.discover.offline")}</Notice>}
    {state.sourceErrors.map((item) => <Notice key={item.source.id} tone="danger" icon={AlertTriangle}
      action={<Button size="sm" variant="outline" onClick={reload} className="min-h-11 md:min-h-8"><RefreshCw size={13} className="mr-1" />{t("extensionCenter.discover.retry")}</Button>}>
      {t("extensionCenter.discover.sourceFailed", { name: item.source.name, message: item.message })}
    </Notice>)}
    {state.status === "ready" && state.sourceCount === 0 && <Notice tone="info" icon={Info}>{t("extensionCenter.discover.noSources")}</Notice>}
    {state.status === "ready" && state.catalogPending && <p role="status" className="flex items-center gap-2 text-sm text-tx-tertiary"><Loader2 size={14} className="animate-spin" aria-hidden />{t("extensionCenter.discover.loading")}</p>}

    {loading ? <div role="status" aria-label={t("extensionCenter.discover.loading")}><CardSkeletons /></div>
      : state.status === "error" ? <Notice tone="danger" icon={AlertTriangle} action={<Button size="sm" variant="outline" onClick={reload}>{t("extensionCenter.discover.retry")}</Button>}>{state.error}</Notice>
        : <>
          {!!featured.length && <section aria-labelledby="extension-featured-heading" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="extension-featured-heading" className="text-base font-semibold text-tx-primary">{t("extensionCenter.discover.featured")}</h2>
              <span className="text-xs text-tx-tertiary">{t("extensionCenter.discover.featuredNote")}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {featured.map(({ listing, reasonKey }) => <div key={listing.key} className="flex min-w-0 flex-col gap-1.5">
                <p className="px-1 text-xs text-tx-tertiary">{t(reasonKey)}</p>
                <ExtensionCard listing={listing} compact busy={runner.busyKey === listing.key} onAction={runner.run} />
              </div>)}
            </div>
          </section>}

          <section aria-labelledby="extension-results-heading" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="extension-results-heading" className="text-base font-semibold text-tx-primary">{t(`extensionCenter.category.${category}`)}</h2>
              <span aria-live="polite" className="text-xs text-tx-tertiary">{t("extensionCenter.discover.results", { count: visible.length })}</span>
            </div>
            {visible.length
              ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{visible.map((listing) => <ExtensionCard key={listing.key} listing={listing} busy={runner.busyKey === listing.key} onAction={runner.run} />)}</div>
              : <div className="rounded-2xl border border-dashed border-app-border px-4 py-12 text-center">
                <p className="text-sm font-medium text-tx-primary">{t("extensionCenter.discover.empty")}</p>
                <p className="mt-1 text-sm text-tx-secondary">{t("extensionCenter.discover.emptyHint")}</p>
                <Button size="sm" variant="outline" className="mt-4 min-h-11 md:min-h-9" onClick={() => { setQuery(""); setCategory("all"); }}>{t("extensionCenter.discover.clearFilters")}</Button>
              </div>}
          </section>

          <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-app-border bg-app-surface p-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-tx-primary">{t("extensionCenter.discover.createTitle")}</p>
              <p className="mt-0.5 text-sm text-tx-secondary">{t("extensionCenter.discover.createBody")}</p>
            </div>
            <Button size="sm" variant="outline" className="min-h-11 md:min-h-9" onClick={() => pushAppPathState("/apps/studio")}><WandSparkles size={14} className="mr-1.5" />{t("extensionCenter.discover.createAction")}</Button>
          </section>
        </>}

    <AnimatePresence>
      {selected && <ExtensionDetailDrawer key={selected.key} listing={selected} isAdmin={isAdmin} appPagesAvailable={appPagesAvailable}
        busy={runner.busyKey === selected.key} onClose={() => setSelectedKey(null)} onAction={runner.run} />}
    </AnimatePresence>
  </div>;
}
