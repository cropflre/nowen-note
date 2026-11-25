import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowUpRight,
  Blocks,
  Compass,
  Info,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  MoreHorizontal,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUserRole } from "@/hooks/useCurrentUserRole";
import { pushAppPathState } from "@/lib/appPathNavigation";
import type { ExtensionInstallState, ExtensionListing } from "@/lib/extensionCatalog";
import type { StudioApp } from "@/lib/personalApps";
import { pluginApi, type PluginAppPage } from "@/lib/pluginApi";
import { loadPluginAppPins, savePluginAppPins } from "@/lib/pluginApps";
import { cn } from "@/lib/utils";
import { ExtensionCard } from "./ExtensionCard";
import { ExtensionCenterLayout } from "./ExtensionCenterLayout";
import { ExtensionDetailDrawer, type DrawerAction } from "./ExtensionDetailDrawer";
import { CardSkeletons, Notice } from "./ExtensionDiscover";
import { Chip } from "./extensionCenterUi";
import { useExtensionActionRunner } from "./useExtensionActionRunner";
import { useExtensionCatalog } from "./useExtensionCatalog";

const STATE_ORDER: Record<ExtensionInstallState, number> = {
  pending: 0,
  error: 1,
  incompatible: 2,
  enabled: 3,
  disabled: 4,
  "not-installed": 5,
  builtin: 6,
};

type MineFilter = "all" | "apps" | "plugins";

interface MenuItem {
  key: string;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** "···" on a card: secondary actions only, so each card keeps one primary button. */
function CardMenu({
  label,
  items,
  placement = "below",
  compact = false,
}: {
  label: string;
  items: MenuItem[];
  placement?: "above" | "below";
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      ref={wrapper}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={cn(
          "rounded-lg text-tx-secondary hover:text-tx-primary",
          compact ? "h-9 w-9 md:h-7 md:w-7" : "h-10 w-10 md:h-8 md:w-8",
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={15} aria-hidden />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className={cn(
            "absolute right-0 z-30 min-w-44 rounded-xl border border-app-border bg-app-surface p-1 shadow-lg",
            placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "flex min-h-10 w-full items-center rounded-lg px-3 text-left text-sm transition-colors hover:bg-app-hover md:min-h-8 md:text-xs",
                item.danger ? "text-red-600 dark:text-red-300" : "text-tx-primary",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Mine": everything the user can open or manage in one list — apps they created and installed
 * extensions. Administrator tooling (sources, runtime policy, debugging) lives in Settings.
 */
export default function MyPlugins({
  dashboardAvailable,
  appPagesAvailable,
  pages = [],
  pinned = () => false,
  unavailableApp,
}: {
  dashboardAvailable: boolean;
  appPagesAvailable: boolean;
  pages?: PluginAppPage[];
  pinned?: (page: PluginAppPage) => boolean;
  unavailableApp?: boolean;
}) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const { role, retry } = useCurrentUserRole();
  const isAdmin = role.status === "ready" && role.isAdmin;
  const { state, reload } = useExtensionCatalog({ enabled: role.status === "ready", isAdmin, dashboardAvailable });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<MineFilter>("all");
  const runner = useExtensionActionRunner(useCallback((listing: ExtensionListing) => setSelectedKey(listing.key), []));
  // undefined: loading, null: failed. Apps are private to the signed-in account.
  const [studioApps, setStudioApps] = useState<StudioApp[] | null | undefined>(undefined);
  const [studioAttempt, setStudioAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () => {
      setStudioApps(undefined);
      void pluginApi
        .personalApps()
        .then((items) => {
          if (active) setStudioApps(items);
        })
        .catch(() => {
          if (active) setStudioApps(null);
        });
    };
    load();
    window.addEventListener("nowen:token-changed", load);
    return () => {
      active = false;
      window.removeEventListener("nowen:token-changed", load);
    };
  }, [studioAttempt]);

  const installed = useMemo(
    () =>
      state.listings
        .filter((listing) => listing.kind === "plugin" && listing.installed)
        .sort((a, b) => STATE_ORDER[a.installState] - STATE_ORDER[b.installState] || a.name.localeCompare(b.name)),
    [state.listings],
  );
  const selected = selectedKey
    ? state.listings.find((listing) => listing.key === selectedKey && listing.installed) || null
    : null;
  useEffect(() => {
    if (selectedKey && state.status === "ready" && !selected) setSelectedKey(null);
  }, [selected, selectedKey, state.status]);

  if (role.status === "failed") {
    return (
      <ExtensionCenterLayout section="mine" dashboardEnabled={dashboardAvailable}>
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

  const loading = role.status === "loading" || state.status === "loading" || state.status === "idle" || studioApps === undefined;
  const appsList = studioApps || [];
  const pendingCount = installed.filter((item) => item.installState === "pending").length;
  const totalCount = appsList.length + installed.length;
  const visibleApps = filter === "plugins" ? [] : appsList;
  const visiblePlugins = filter === "apps" ? [] : installed;

  const pluginMenu = (listing: ExtensionListing): MenuItem[] => {
    const act = (action: DrawerAction | "details") => () => runner.run(listing, action);
    const items: MenuItem[] = [{ key: "details", label: t("extensionCenter.mine.detailsConfig"), onSelect: act("details") }];
    const page = appPagesAvailable ? pages.find((item) => item.pluginId === listing.id) : undefined;
    if (page) {
      items.push({
        key: "pin",
        label: t(pinned(page) ? "pluginApps.unpin" : "pluginApps.pin"),
        onSelect: () => {
          const pins = loadPluginAppPins();
          savePluginAppPins(pinned(page) ? pins.filter((id) => id !== page.runtimeId) : [...pins, page.runtimeId]);
        },
      });
    }
    if (!isAdmin) return items;
    if (listing.installState === "enabled") {
      if (listing.updateVersion && listing.sources.length) {
        items.push({ key: "update", label: t("extensionCenter.action.update"), onSelect: act("update") });
      }
      items.push({ key: "disable", label: t("extensionCenter.action.disable"), onSelect: act("disable") });
    }
    if (listing.installed?.apiVersion === 3) {
      items.push({ key: "retain", label: t("extensionCenter.action.uninstallRetain"), danger: true, onSelect: act("uninstall-retain") });
      items.push({ key: "delete", label: t("extensionCenter.action.uninstallDelete"), danger: true, onSelect: act("uninstall-delete") });
    } else {
      items.push({ key: "uninstall", label: t("extensionCenter.action.uninstall"), danger: true, onSelect: act("uninstall-plain") });
    }
    return items;
  };

  const moreLabel = (name: string) => t("extensionCenter.mine.more", { name });
  const empty = !loading && state.status === "ready" && !installed.length && studioApps !== null && !studioApps?.length;
  const filterPill = (active: boolean) =>
    cn(
      "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40",
      active
        ? "bg-accent-primary text-white shadow-sm"
        : "bg-app-surface/90 text-tx-secondary ring-1 ring-app-border/80 hover:bg-app-hover hover:text-tx-primary",
    );

  const quickShortcuts = [
    {
      key: "create",
      title: t("extensionCenter.mine.quickCreateTitle"),
      desc: t("extensionCenter.mine.quickCreateDesc"),
      Icon: WandSparkles,
      iconBg: "bg-gradient-to-br from-fuchsia-400/20 to-violet-500/15 text-fuchsia-600 dark:text-fuchsia-300 ring-fuchsia-500/20",
      cardTint: "hover:border-fuchsia-400/45 hover:bg-fuchsia-500/[0.03]",
      onClick: () => pushAppPathState("/apps/studio"),
    },
    {
      key: "discover",
      title: t("extensionCenter.mine.quickDiscoverTitle"),
      desc: t("extensionCenter.mine.quickDiscoverDesc"),
      Icon: Compass,
      iconBg: "bg-gradient-to-br from-sky-400/20 to-teal-500/15 text-sky-600 dark:text-sky-300 ring-sky-500/20",
      cardTint: "hover:border-sky-400/45 hover:bg-sky-500/[0.03]",
      onClick: () => pushAppPathState("/apps/discover"),
    },
    ...(dashboardAvailable
      ? [
          {
            key: "dashboard",
            title: t("extensionCenter.mine.quickDashboardTitle"),
            desc: t("extensionCenter.mine.quickDashboardDesc"),
            Icon: LayoutDashboard,
            iconBg: "bg-gradient-to-br from-amber-400/20 to-orange-500/15 text-amber-600 dark:text-amber-300 ring-amber-500/20",
            cardTint: "hover:border-amber-400/45 hover:bg-amber-500/[0.03]",
            onClick: () => pushAppPathState("/apps/dashboard"),
          },
        ]
      : []),
  ];

  const content = (
    <div className="space-y-4">
      {unavailableApp && (
        <p role="alert" className="text-sm text-tx-secondary">
          {t("pluginApps.unavailable")}
        </p>
      )}

      {/* 灵动概览与筛选栏 */}
      <section className="relative rounded-2xl border border-app-border/80 bg-gradient-to-r from-indigo-500/[0.06] via-app-surface to-sky-500/[0.06] px-4 py-3.5 shadow-sm">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-indigo-400/15 to-cyan-400/10 blur-2xl" />
        </div>
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/15 to-sky-500/15 text-indigo-600 ring-1 ring-inset ring-indigo-500/20 dark:text-indigo-300"
            >
              <Blocks size={17} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-tx-primary">{t("extensionCenter.mine.description")}</p>
              {!loading && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:text-indigo-300 tabular-nums">
                    {t("extensionCenter.mine.summaryApps", { count: appsList.length })}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300 tabular-nums">
                    {t("extensionCenter.mine.summaryPlugins", { count: installed.length })}
                  </span>
                  {pendingCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 tabular-nums">
                      {t("extensionCenter.mine.summaryPending", { count: pendingCount })}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!loading && totalCount > 0 && (
              <div role="group" aria-label={t("extensionCenter.mine.filterLabel")} className="flex items-center gap-1">
                <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")} className={filterPill(filter === "all")}>
                  {t("extensionCenter.mine.filterAll")}
                </button>
                <button type="button" aria-pressed={filter === "apps"} onClick={() => setFilter("apps")} className={filterPill(filter === "apps")}>
                  {t("extensionCenter.mine.filterApps")}
                </button>
                <button type="button" aria-pressed={filter === "plugins"} onClick={() => setFilter("plugins")} className={filterPill(filter === "plugins")}>
                  {t("extensionCenter.mine.filterPlugins")}
                </button>
              </div>
            )}
            {isAdmin && (
              <CardMenu
                label={t("extensionCenter.mine.adminMenu")}
                placement="below"
                items={[
                  {
                    key: "advanced",
                    label: t("extensionCenter.mine.advanced"),
                    onSelect: () => window.dispatchEvent(new CustomEvent("nowen:open-settings", { detail: { tab: "extensions" } })),
                  },
                ]}
              />
            )}
          </div>
        </div>
      </section>

      {role.status === "ready" && !isAdmin && <Notice tone="info" icon={Info}>{t("extensionCenter.mine.memberHint")}</Notice>}
      {state.status === "error" && (
        <Notice
          tone="danger"
          icon={AlertTriangle}
          action={
            <Button size="sm" variant="outline" onClick={reload}>
              {t("extensionCenter.discover.retry")}
            </Button>
          }
        >
          {t("extensionCenter.mine.failed", { message: state.error })}
        </Notice>
      )}
      {studioApps === null && (
        <Notice
          tone="danger"
          icon={AlertTriangle}
          action={
            <Button size="sm" variant="outline" onClick={() => setStudioAttempt((value) => value + 1)}>
              {t("extensionCenter.discover.retry")}
            </Button>
          }
        >
          {t("extensionCenter.mine.appsFailed")}
        </Notice>
      )}

      {loading ? (
        <div role="status" aria-label={t("extensionCenter.mine.loading")}>
          <CardSkeletons count={3} />
        </div>
      ) : empty ? (
        <div className="relative overflow-hidden rounded-2xl border border-dashed border-app-border/90 bg-gradient-to-br from-indigo-500/[0.04] via-app-surface to-sky-500/[0.04] px-5 py-10 text-center">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/15 to-fuchsia-500/15 text-indigo-600 ring-1 ring-inset ring-indigo-500/20 dark:text-indigo-300">
            <Sparkles size={22} aria-hidden />
          </div>
          <p className="mx-auto mt-3 max-w-md text-sm text-tx-secondary">{t("extensionCenter.mine.empty")}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" className="min-h-10 rounded-xl md:min-h-9" onClick={() => pushAppPathState("/apps/discover")}>
              <Compass size={14} className="mr-1.5" aria-hidden />
              {t("extensionCenter.mine.browse")}
            </Button>
            <Button size="sm" variant="outline" className="min-h-10 rounded-xl md:min-h-9" onClick={() => pushAppPathState("/apps/studio")}>
              <WandSparkles size={14} className="mr-1.5" aria-hidden />
              {t("extensionCenter.mine.createFirst")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleApps.length + visiblePlugins.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleApps.map((app, index) => {
                const isBoard = app.spec.layout === "board";
                const AppIcon = isBoard ? LayoutGrid : ListTodo;
                const recordCount = app.spec.items?.length ?? 0;
                const layoutLabel = t(`extensionCenter.create.layout.${isBoard ? "board" : "list"}`);
                return (
                  <motion.article
                    key={app.id}
                    data-studio-app={app.id}
                    initial={reducedMotion ? false : { opacity: 0, y: 10, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 28, delay: Math.min(index * 0.04, 0.24) }}
                    className={cn(
                      "group/studio relative flex min-w-0 flex-col rounded-2xl border border-app-border/85 p-3.5 shadow-sm transition-all duration-200 hover:shadow-md motion-safe:hover:-translate-y-0.5",
                      isBoard
                        ? "bg-gradient-to-br from-cyan-500/[0.05] via-app-surface to-indigo-500/[0.03] hover:border-cyan-400/45"
                        : "bg-gradient-to-br from-indigo-500/[0.05] via-app-surface to-violet-500/[0.03] hover:border-indigo-400/45",
                    )}
                  >
                    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
                      <div
                        className={cn(
                          "absolute -right-6 -top-6 h-20 w-20 rounded-full blur-2xl opacity-65 transition-opacity duration-300 group-hover/studio:opacity-100",
                          isBoard ? "bg-cyan-400/15" : "bg-indigo-400/15",
                        )}
                      />
                    </div>
                    <div className="relative flex items-start gap-2.5">
                      <span
                        aria-hidden
                        className={cn(
                          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset transition-transform duration-200 motion-safe:group-hover/studio:scale-110 motion-safe:group-hover/studio:-rotate-6",
                          isBoard
                            ? "bg-gradient-to-br from-cyan-400/20 to-indigo-500/15 text-cyan-700 ring-cyan-500/20 dark:text-cyan-300"
                            : "bg-gradient-to-br from-indigo-400/20 to-violet-500/15 text-indigo-700 ring-indigo-500/20 dark:text-indigo-300",
                        )}
                      >
                        <AppIcon size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <h3 className="min-w-0 truncate text-[13px] font-semibold leading-snug text-tx-primary">
                            {app.spec.name}
                          </h3>
                          <Chip tone="info">{t("extensionCenter.mine.personalBadge")}</Chip>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-tx-tertiary tabular-nums">
                          {layoutLabel} · {t("extensionCenter.workbench.studio.records", { count: recordCount })}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 rounded-lg px-2.5 text-xs"
                          aria-label={`${t("extensionCenter.action.open")} · ${app.spec.name}`}
                          onClick={() => pushAppPathState("/apps/personal/" + app.id)}
                        >
                          {t("extensionCenter.action.open")}
                        </Button>
                        <CardMenu
                          compact
                          label={moreLabel(app.spec.name)}
                          items={[
                            {
                              key: "edit",
                              label: t("extensionCenter.mine.editApp"),
                              onSelect: () => pushAppPathState("/apps/studio/" + app.id),
                            },
                          ]}
                        />
                      </div>
                    </div>
                    {app.spec.description && (
                      <p className="relative mt-2 line-clamp-2 text-xs leading-relaxed text-tx-secondary">
                        {app.spec.description}
                      </p>
                    )}
                  </motion.article>
                );
              })}

              {visiblePlugins.map((listing) => (
                <ExtensionCard
                  key={listing.key}
                  listing={listing}
                  busy={runner.busyKey === listing.key}
                  appPagesAvailable={appPagesAvailable}
                  onAction={runner.run}
                  menu={<CardMenu compact label={moreLabel(listing.name)} items={pluginMenu(listing)} />}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-app-border/80 bg-app-hover/25 px-4 py-8 text-center">
              <p className="text-xs text-tx-secondary">{t("extensionCenter.mine.filterEmpty")}</p>
            </div>
          )}

          {/* 快捷灵动探索条：减少少量应用时的空旷感，提供直观下一步入口 */}
          <div className={cn("grid gap-2.5 pt-1", quickShortcuts.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
            {quickShortcuts.map(({ key, title, desc, Icon, iconBg, cardTint, onClick }) => (
              <button
                key={key}
                type="button"
                onClick={onClick}
                className={cn(
                  "group/quick flex min-w-0 items-center gap-3 rounded-2xl border border-dashed border-app-border/85 bg-app-surface/70 px-3.5 py-3 text-left transition-all duration-200 motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40",
                  cardTint,
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset transition-transform duration-200 motion-safe:group-hover/quick:scale-110 motion-safe:group-hover/quick:-rotate-6",
                    iconBg,
                  )}
                >
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-xs font-semibold text-tx-primary">
                    <span className="truncate">{title}</span>
                    <ArrowUpRight
                      size={13}
                      aria-hidden
                      className="shrink-0 text-tx-tertiary transition-transform duration-200 motion-safe:group-hover/quick:translate-x-0.5 motion-safe:group-hover/quick:-translate-y-0.5"
                    />
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-tx-tertiary">{desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
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
      section="mine"
      dashboardEnabled={dashboardAvailable}
      packageUpload={isAdmin ? { busy: runner.busyKey !== null, install: runner.installPackage } : undefined}
    >
      {content}
    </ExtensionCenterLayout>
  );
}
