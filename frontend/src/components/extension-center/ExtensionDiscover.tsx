import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Compass, Info, Loader2, RefreshCw, Search, Sparkles, WifiOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUserRole } from "@/hooks/useCurrentUserRole";
import { useAIConnectionAvailable } from "@/lib/aiConnection";
import {
  EXTENSION_CATEGORIES,
  filterExtensionListings,
  pickFeaturedListings,
  type ExtensionCategory,
  type ExtensionListing,
} from "@/lib/extensionCatalog";
import { cn } from "@/lib/utils";
import { ExtensionCard } from "./ExtensionCard";
import { ExtensionCenterLayout } from "./ExtensionCenterLayout";
import { ExtensionDetailDrawer } from "./ExtensionDetailDrawer";
import { useExtensionActionRunner } from "./useExtensionActionRunner";
import { useExtensionCatalog } from "./useExtensionCatalog";

function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function Notice({
  tone,
  icon: Icon,
  children,
  action,
}: {
  tone: "info" | "warning" | "danger";
  icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const toneClass =
    tone === "danger"
      ? "border-red-500/30 bg-red-500/5 text-red-800 dark:text-red-200"
      : tone === "warning"
        ? "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200"
        : "border-app-border bg-app-hover/60 text-tx-secondary";
  return (
    <div role={tone === "info" ? "note" : "alert"} className={cn("flex flex-wrap items-center gap-2 rounded-2xl border px-3.5 py-2.5 text-sm", toneClass)}>
      <Icon size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export function CardSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="h-28 rounded-2xl border border-app-border/80 bg-app-surface p-3.5">
          <div className="flex gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-app-hover motion-safe:animate-pulse" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-2/3 rounded bg-app-hover motion-safe:animate-pulse" />
              <div className="h-2.5 w-1/3 rounded bg-app-hover motion-safe:animate-pulse" />
            </div>
          </div>
          <div className="mt-3 h-2.5 w-full rounded bg-app-hover motion-safe:animate-pulse" />
          <div className="mt-1.5 h-2.5 w-3/4 rounded bg-app-hover motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** Plugins first (official before others), then built-in feature cards. */
function sortForDiscovery(listings: ExtensionListing[]): ExtensionListing[] {
  return [...listings].sort(
    (a, b) => Number(a.kind === "builtin") - Number(b.kind === "builtin") || Number(b.official) - Number(a.official) || a.name.localeCompare(b.name),
  );
}

export default function ExtensionDiscover({
  dashboardAvailable,
  appPagesAvailable,
}: {
  dashboardAvailable: boolean;
  appPagesAvailable: boolean;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const { role, retry } = useCurrentUserRole();
  const aiAvailable = useAIConnectionAvailable();
  const isAdmin = role.status === "ready" && role.isAdmin;
  const { state, reload } = useExtensionCatalog({ enabled: role.status === "ready", isAdmin, dashboardAvailable });
  const [query, setQuery] = useState("");
  const [requestedCategory, setCategory] = useState<ExtensionCategory | "all">("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const runner = useExtensionActionRunner(useCallback((listing: ExtensionListing) => setSelectedKey(listing.key), []));
  const online = useOnline();
  const listings = useMemo(
    () => (aiAvailable ? state.listings : state.listings.filter((listing) => listing.kind !== "builtin" || listing.id !== "ai-chat")),
    [aiAvailable, state.listings],
  );
  const category =
    requestedCategory === "ai" && !aiAvailable && !listings.some((listing) => listing.category === "ai") ? "all" : requestedCategory;
  const categoryLabel = useCallback((value: ExtensionCategory) => t(`extensionCenter.category.${value}`), [t]);
  const visible = useMemo(
    () => sortForDiscovery(filterExtensionListings(listings, { query, category }, categoryLabel)),
    [listings, query, category, categoryLabel],
  );
  // Only categories that currently have something to show.
  const categories = useMemo(
    () => EXTENSION_CATEGORIES.filter((value) => value === category || listings.some((listing) => listing.category === value)),
    [listings, category],
  );
  const featured = useMemo(() => (!query.trim() && category === "all" ? pickFeaturedListings(listings) : []), [listings, query, category]);
  // Re-derive from the latest server state so the drawer never shows a stale install status.
  const selected = selectedKey ? listings.find((listing) => listing.key === selectedKey) || null : null;
  useEffect(() => {
    if (selectedKey && state.status === "ready" && !selected) setSelectedKey(null);
  }, [selected, selectedKey, state.status]);

  if (role.status === "failed") {
    return (
      <ExtensionCenterLayout section="discover" dashboardEnabled={dashboardAvailable}>
        <Notice
          tone="danger"
          icon={AlertTriangle}
          action={
            <Button size="sm" variant="outline" onClick={retry}>
              {t("extensionCenter.discover.retry")}
            </Button>
          }
        >
          {t("extensionCenter.error.identity")}
        </Notice>
      </ExtensionCenterLayout>
    );
  }

  const loading = role.status === "loading" || state.status === "loading" || state.status === "idle";
  const pill = (active: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center rounded-full px-3 text-xs font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40",
      active
        ? "bg-accent-primary text-white shadow-sm"
        : "bg-app-surface/90 text-tx-secondary ring-1 ring-app-border/80 hover:bg-app-hover hover:text-tx-primary",
    );

  const content = (
    <div className="space-y-5">
      {/* 极光探索横幅 + 融合分类胶囊 */}
      <section
        aria-labelledby="extension-discover-heading"
        className="relative overflow-hidden rounded-2xl border border-app-border/80 bg-gradient-to-br from-sky-500/[0.07] via-app-surface to-fuchsia-500/[0.06] px-4 py-4 shadow-sm"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full bg-gradient-to-br from-sky-400/20 to-indigo-400/15 blur-2xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-10 left-1/3 h-24 w-36 rounded-full bg-gradient-to-tr from-fuchsia-400/15 to-amber-300/10 blur-2xl"
        />

        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/20 to-indigo-500/15 text-sky-600 ring-1 ring-inset ring-sky-500/20 dark:text-sky-300"
            >
              <Compass size={19} />
            </span>
            <div className="min-w-0">
              <h2 id="extension-discover-heading" className="text-base font-bold tracking-tight text-tx-primary">
                {t("extensionCenter.discover.heading")}
              </h2>
              <p className="mt-0.5 text-xs text-tx-secondary">{t("extensionCenter.discover.description")}</p>
            </div>
          </div>

          <label className="flex w-full items-center gap-2 rounded-xl border border-app-border/85 bg-app-surface/90 px-3 shadow-xs transition-all focus-within:border-accent-primary/50 focus-within:ring-2 focus-within:ring-accent-primary/20 sm:w-80 sm:shrink-0">
            <Search size={15} className="shrink-0 text-tx-tertiary" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("extensionCenter.discover.searchLabel")}
              placeholder={t("extensionCenter.discover.searchPlaceholder")}
              className="h-9 min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("extensionCenter.discover.clearFilters")}
                className="rounded-md p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
              >
                <X size={13} aria-hidden />
              </button>
            )}
          </label>
        </div>

        <div
          role="group"
          aria-label={t("extensionCenter.discover.categories")}
          className="relative mt-3.5 flex min-w-0 gap-1.5 overflow-x-auto border-t border-app-border/50 pt-3 pb-0.5"
        >
          {(["all", ...categories] as const).map((value) => (
            <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)} className={pill(category === value)}>
              {t(`extensionCenter.category.${value}`)}
            </button>
          ))}
        </div>
      </section>

      {!online && <Notice tone="warning" icon={WifiOff}>{t("extensionCenter.discover.offline")}</Notice>}
      {state.sourceErrors.map((item) => (
        <Notice
          key={item.source.id}
          tone="danger"
          icon={AlertTriangle}
          action={
            <Button size="sm" variant="outline" onClick={reload} className="min-h-10 md:min-h-8">
              <RefreshCw size={13} className="mr-1" />
              {t("extensionCenter.discover.retry")}
            </Button>
          }
        >
          {t("extensionCenter.discover.sourceFailed", { name: item.source.name, message: item.message })}
        </Notice>
      ))}
      {state.status === "ready" && state.sourceCount === 0 && <Notice tone="info" icon={Info}>{t("extensionCenter.discover.noSources")}</Notice>}
      {state.status === "ready" && state.catalogPending && (
        <p role="status" className="flex items-center gap-2 text-sm text-tx-tertiary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("extensionCenter.discover.loading")}
        </p>
      )}

      {loading ? (
        <div role="status" aria-label={t("extensionCenter.discover.loading")}>
          <CardSkeletons />
        </div>
      ) : state.status === "error" ? (
        <Notice
          tone="danger"
          icon={AlertTriangle}
          action={
            <Button size="sm" variant="outline" onClick={reload}>
              {t("extensionCenter.discover.retry")}
            </Button>
          }
        >
          {state.error}
        </Notice>
      ) : (
        <>
          {!!featured.length && (
            <section aria-labelledby="extension-featured-heading" className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Sparkles size={15} className="text-amber-500" aria-hidden />
                  <h2 id="extension-featured-heading" className="text-sm font-semibold text-tx-primary">
                    {t("extensionCenter.discover.featured")}
                  </h2>
                </div>
                <span className="text-[11px] text-tx-tertiary">{t("extensionCenter.discover.featuredNote")}</span>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                {featured.map(({ listing, reasonKey }, index) => (
                  <motion.div
                    key={listing.key}
                    initial={reducedMotion ? false : { opacity: 0, y: 10, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 28, delay: index * 0.05 }}
                    className="min-w-0"
                  >
                    <ExtensionCard
                      listing={listing}
                      spotlight
                      tagline={t(reasonKey)}
                      appPagesAvailable={appPagesAvailable}
                      busy={runner.busyKey === listing.key}
                      onAction={runner.run}
                    />
                  </motion.div>
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="extension-results-heading" className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="extension-results-heading" className="text-sm font-semibold text-tx-primary">
                {t(`extensionCenter.category.${category}`)}
              </h2>
              <span
                aria-live="polite"
                className="rounded-full bg-app-hover/80 px-2.5 py-0.5 text-[11px] font-medium text-tx-tertiary tabular-nums"
              >
                {t("extensionCenter.discover.results", { count: visible.length })}
              </span>
            </div>
            {visible.length ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((listing) => (
                  <ExtensionCard
                    key={listing.key}
                    listing={listing}
                    appPagesAvailable={appPagesAvailable}
                    busy={runner.busyKey === listing.key}
                    onAction={runner.run}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-app-border/90 bg-gradient-to-br from-sky-500/[0.03] via-app-surface to-indigo-500/[0.03] px-4 py-12 text-center">
                <p className="text-sm font-medium text-tx-primary">{t("extensionCenter.discover.empty")}</p>
                <p className="mt-1 text-xs text-tx-secondary">{t("extensionCenter.discover.emptyHint")}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4 min-h-10 rounded-xl md:min-h-9"
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                  }}
                >
                  {t("extensionCenter.discover.clearFilters")}
                </Button>
              </div>
            )}
          </section>
        </>
      )}

      <AnimatePresence>
        {selected && (
          <ExtensionDetailDrawer
            key={selected.key}
            listing={selected}
            isAdmin={isAdmin}
            appPagesAvailable={appPagesAvailable}
            busy={runner.busyKey === selected.key}
            onClose={() => setSelectedKey(null)}
            onAction={runner.run}
          />
        )}
      </AnimatePresence>
    </div>
  );

  return (
    <ExtensionCenterLayout
      section="discover"
      dashboardEnabled={dashboardAvailable}
      packageUpload={isAdmin ? { busy: runner.busyKey !== null, install: runner.installPackage } : undefined}
    >
      {content}
    </ExtensionCenterLayout>
  );
}
