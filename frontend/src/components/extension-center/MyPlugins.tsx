import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, LayoutGrid, MoreHorizontal } from "lucide-react";
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

const STATE_ORDER: Record<ExtensionInstallState, number> = { pending: 0, error: 1, incompatible: 2, enabled: 3, disabled: 4, "not-installed": 5, builtin: 6 };

interface MenuItem { key: string; label: string; danger?: boolean; onSelect: () => void }

/** "···" on a card: secondary actions only, so each card keeps one primary button. */
function CardMenu({ label, items, placement = "above" }: { label: string; items: MenuItem[]; placement?: "above" | "below" }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div ref={wrapper} className="relative" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
    <Button type="button" size="icon" variant="ghost" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      className="h-11 w-11 md:h-9 md:w-9" onClick={() => setOpen((value) => !value)}>
      <MoreHorizontal size={16} aria-hidden />
    </Button>
    {open && <div id={menuId} role="menu" className={cn("absolute right-0 z-20 min-w-44 rounded-xl border border-app-border bg-app-surface p-1 shadow-lg", placement === "above" ? "bottom-full mb-1" : "top-full mt-1")}>
      {items.map((item) => <button key={item.key} type="button" role="menuitem" onClick={() => { setOpen(false); item.onSelect(); }}
        className={cn("flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-app-hover md:min-h-9", item.danger ? "text-red-600 dark:text-red-300" : "text-tx-primary")}>
        {item.label}
      </button>)}
    </div>}
  </div>;
}

/**
 * "Mine": everything the user can open or manage in one list — apps they created and installed
 * extensions. Administrator tooling (sources, runtime policy, debugging) lives in Settings.
 */
export default function MyPlugins({ dashboardAvailable, appPagesAvailable, pages = [], pinned = () => false, unavailableApp }: {
  dashboardAvailable: boolean; appPagesAvailable: boolean;
  pages?: PluginAppPage[]; pinned?: (page: PluginAppPage) => boolean; unavailableApp?: boolean;
}) {
  const { t } = useTranslation();
  const { role, retry } = useCurrentUserRole();
  const isAdmin = role.status === "ready" && role.isAdmin;
  const { state, reload } = useExtensionCatalog({ enabled: role.status === "ready", isAdmin, dashboardAvailable });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const runner = useExtensionActionRunner(useCallback((listing: ExtensionListing) => setSelectedKey(listing.key), []));
  // undefined: loading, null: failed. Apps are private to the signed-in account.
  const [studioApps, setStudioApps] = useState<StudioApp[] | null | undefined>(undefined);
  const [studioAttempt, setStudioAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () => {
      setStudioApps(undefined);
      void pluginApi.personalApps().then((items) => { if (active) setStudioApps(items); }).catch(() => { if (active) setStudioApps(null); });
    };
    load();
    window.addEventListener("nowen:token-changed", load);
    return () => { active = false; window.removeEventListener("nowen:token-changed", load); };
  }, [studioAttempt]);

  const installed = useMemo(() => state.listings
    .filter((listing) => listing.kind === "plugin" && listing.installed)
    .sort((a, b) => STATE_ORDER[a.installState] - STATE_ORDER[b.installState] || a.name.localeCompare(b.name)), [state.listings]);
  const selected = selectedKey ? state.listings.find((listing) => listing.key === selectedKey && listing.installed) || null : null;
  useEffect(() => { if (selectedKey && state.status === "ready" && !selected) setSelectedKey(null); }, [selected, selectedKey, state.status]);

  if (role.status === "failed") {
    return <ExtensionCenterLayout section="mine" dashboardEnabled={dashboardAvailable}>
      <Notice tone="danger" icon={AlertTriangle} action={<Button size="sm" variant="outline" onClick={retry}>{t("extensionCenter.discover.retry")}</Button>}>{t("extensionCenter.error.identity")}</Notice>
    </ExtensionCenterLayout>;
  }
  const loading = role.status === "loading" || state.status === "loading" || state.status === "idle" || studioApps === undefined;

  const pluginMenu = (listing: ExtensionListing): MenuItem[] => {
    const act = (action: DrawerAction | "details") => () => runner.run(listing, action);
    const items: MenuItem[] = [{ key: "details", label: t("extensionCenter.mine.detailsConfig"), onSelect: act("details") }];
    const page = appPagesAvailable ? pages.find((item) => item.pluginId === listing.id) : undefined;
    if (page) items.push({
      key: "pin", label: t(pinned(page) ? "pluginApps.unpin" : "pluginApps.pin"),
      onSelect: () => { const pins = loadPluginAppPins(); savePluginAppPins(pinned(page) ? pins.filter((id) => id !== page.runtimeId) : [...pins, page.runtimeId]); },
    });
    if (!isAdmin) return items;
    if (listing.installState === "enabled") {
      if (listing.updateVersion && listing.sources.length) items.push({ key: "update", label: t("extensionCenter.action.update"), onSelect: act("update") });
      items.push({ key: "disable", label: t("extensionCenter.action.disable"), onSelect: act("disable") });
    }
    if (listing.installed?.apiVersion === 3) {
      items.push({ key: "retain", label: t("extensionCenter.action.uninstallRetain"), danger: true, onSelect: act("uninstall-retain") });
      items.push({ key: "delete", label: t("extensionCenter.action.uninstallDelete"), danger: true, onSelect: act("uninstall-delete") });
    } else items.push({ key: "uninstall", label: t("extensionCenter.action.uninstall"), danger: true, onSelect: act("uninstall-plain") });
    return items;
  };
  const moreLabel = (name: string) => t("extensionCenter.mine.more", { name });
  const empty = !loading && state.status === "ready" && !installed.length && studioApps !== null && !studioApps?.length;

  const content = <div className="space-y-4">
    {unavailableApp && <p role="alert" className="text-sm text-tx-secondary">{t("pluginApps.unavailable")}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 text-sm text-tx-secondary">{t("extensionCenter.mine.description")}</p>
      {isAdmin && <CardMenu label={t("extensionCenter.mine.adminMenu")} placement="below" items={[
        { key: "advanced", label: t("extensionCenter.mine.advanced"), onSelect: () => window.dispatchEvent(new CustomEvent("nowen:open-settings", { detail: { tab: "extensions" } })) },
      ]} />}
    </div>
    {role.status === "ready" && !isAdmin && <Notice tone="info" icon={Info}>{t("extensionCenter.mine.memberHint")}</Notice>}
    {state.status === "error" && <Notice tone="danger" icon={AlertTriangle} action={<Button size="sm" variant="outline" onClick={reload}>{t("extensionCenter.discover.retry")}</Button>}>{t("extensionCenter.mine.failed", { message: state.error })}</Notice>}
    {studioApps === null && <Notice tone="danger" icon={AlertTriangle} action={<Button size="sm" variant="outline" onClick={() => setStudioAttempt((value) => value + 1)}>{t("extensionCenter.discover.retry")}</Button>}>{t("extensionCenter.mine.appsFailed")}</Notice>}

    {loading ? <div role="status" aria-label={t("extensionCenter.mine.loading")}><CardSkeletons count={3} /></div>
      : empty ? <div className="rounded-2xl border border-dashed border-app-border px-4 py-12 text-center">
        <p className="mx-auto max-w-md text-sm text-tx-secondary">{t("extensionCenter.mine.empty")}</p>
        <Button size="sm" className="mt-4 min-h-11 md:min-h-9" onClick={() => pushAppPathState("/apps/discover")}>{t("extensionCenter.mine.browse")}</Button>
      </div>
        : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(studioApps || []).map((app) => <article key={app.id} data-studio-app={app.id} className="flex min-w-0 flex-col rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm transition-interactive duration-fast ease-standard hover:border-accent-primary/40 hover:shadow-md">
            <div className="flex items-start gap-3">
              <span aria-hidden className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary"><LayoutGrid size={18} /></span>
              <h3 className="min-w-0 flex-1 truncate pt-2 text-sm font-semibold text-tx-primary">{app.spec.name}</h3>
              <Chip tone="muted">{t("extensionCenter.mine.personalBadge")}</Chip>
            </div>
            <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-sm text-tx-secondary">{app.spec.description}</p>
            <div className="mt-auto flex items-center justify-between gap-2 pt-4">
              <Button type="button" size="sm" className="min-h-11 md:min-h-9" aria-label={`${t("extensionCenter.action.open")} · ${app.spec.name}`} onClick={() => pushAppPathState("/apps/personal/" + app.id)}>{t("extensionCenter.action.open")}</Button>
              <CardMenu label={moreLabel(app.spec.name)} items={[{ key: "edit", label: t("extensionCenter.mine.editApp"), onSelect: () => pushAppPathState("/apps/studio/" + app.id) }]} />
            </div>
          </article>)}
          {installed.map((listing) => <ExtensionCard key={listing.key} listing={listing} busy={runner.busyKey === listing.key} appPagesAvailable={appPagesAvailable}
            onAction={runner.run} menu={<CardMenu label={moreLabel(listing.name)} items={pluginMenu(listing)} />} />)}
        </div>}

    <AnimatePresence>
      {selected && <ExtensionDetailDrawer key={selected.key} listing={selected} isAdmin={isAdmin} appPagesAvailable={appPagesAvailable}
        busy={runner.busyKey === selected.key} onClose={() => setSelectedKey(null)} onAction={runner.run} />}
    </AnimatePresence>
  </div>;
  return <ExtensionCenterLayout section="mine" dashboardEnabled={dashboardAvailable}
    packageUpload={isAdmin ? { busy: runner.busyKey !== null, install: runner.installPackage } : undefined}>
    {content}
  </ExtensionCenterLayout>;
}
