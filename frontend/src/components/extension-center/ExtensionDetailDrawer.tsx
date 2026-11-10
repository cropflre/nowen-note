import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { overlayMotion, MOTION_SPRING } from "@/lib/motion";
import { pluginApi, type InstalledPlugin, type PluginExecution } from "@/lib/pluginApi";
import type { ExtensionListing } from "@/lib/extensionCatalog";
import { toast } from "@/lib/toast";
import { Chip, describeExtensionError, ExtensionIcon, PermissionList, runtimeLabel, statusChips, trustBadge, unavailableText } from "./extensionCenterUi";

export type DrawerAction =
  | "open" | "open-app" | "install" | "review-enable" | "disable" | "update" | "grant"
  | "uninstall-plain" | "uninstall-retain" | "uninstall-delete";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-tx-tertiary">{title}</h3>
    {children}
  </section>;
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-3 text-sm"><dt className="w-24 shrink-0 text-tx-tertiary">{label}</dt><dd className="min-w-0 flex-1 break-words text-tx-primary">{children}</dd></div>;
}

function PluginSettingsForm({ plugin }: { plugin: InstalledPlugin }) {
  const { t } = useTranslation();
  const settings = plugin.contributes?.settings || [];
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void pluginApi.settings(plugin.id).then((next) => { if (active) setValues(next); }).catch(() => { if (active) setValues({}); });
    return () => { active = false; };
  }, [plugin.id]);
  if (!values) return <p className="text-sm text-tx-tertiary">{t("extensionCenter.detail.loading")}</p>;
  const save = async () => {
    setSaving(true);
    try { setValues(await pluginApi.setSettings(plugin.id, draft)); setDraft({}); toast.success(t("extensionCenter.detail.settingsSaved")); }
    catch (error) { toast.error(describeExtensionError(error, t)); }
    finally { setSaving(false); }
  };
  const field = "mt-1 block w-full rounded-md border border-app-border bg-app-bg px-2.5 py-2 text-sm text-tx-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary";
  return <div className="space-y-3">
    {settings.map((setting) => {
      const id = `${plugin.id}-${setting.key}`;
      const current = draft[setting.key] ?? (setting.secret ? "" : values[setting.key] ?? setting.default ?? "");
      return <div key={setting.key} className="text-sm">
        <label htmlFor={id} className="font-medium text-tx-primary">{setting.title}</label>
        {setting.description && <p className="text-xs text-tx-tertiary">{setting.description}</p>}
        {setting.type === "boolean"
          ? <input id={id} type="checkbox" className="ml-2 align-middle" checked={Boolean(draft[setting.key] ?? values[setting.key] ?? setting.default)} onChange={(event) => setDraft((previous) => ({ ...previous, [setting.key]: event.target.checked }))} />
          : setting.type === "select"
            ? <select id={id} className={field} value={String(current)} onChange={(event) => setDraft((previous) => ({ ...previous, [setting.key]: event.target.value }))}>{(setting.options || []).map((option) => <option key={String(option)} value={String(option)}>{option}</option>)}</select>
            : <input id={id} className={field} type={setting.secret ? "password" : setting.type === "number" ? "number" : "text"} autoComplete="off" value={String(current)}
                placeholder={setting.secret && values[setting.key] ? t("extensionCenter.detail.secretSaved") : undefined}
                onChange={(event) => setDraft((previous) => ({ ...previous, [setting.key]: setting.type === "number" ? Number(event.target.value) : event.target.value }))} />}
        {setting.secret && <p className="mt-1 text-xs text-tx-tertiary">{t("extensionCenter.detail.secretHint")}</p>}
      </div>;
    })}
    <Button type="button" size="sm" disabled={saving || !Object.keys(draft).length} onClick={() => void save()} className="min-h-11 md:min-h-9">{t("extensionCenter.action.saveSettings")}</Button>
  </div>;
}

function RecentRuns({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<PluginExecution[] | null>(null);
  useEffect(() => {
    let active = true;
    void pluginApi.executions(pluginId).then((rows) => { if (active) setRuns(rows.slice(0, 5)); }).catch(() => { if (active) setRuns([]); });
    return () => { active = false; };
  }, [pluginId]);
  if (!runs) return <p className="text-sm text-tx-tertiary">{t("extensionCenter.detail.loading")}</p>;
  if (!runs.length) return <p className="text-sm text-tx-tertiary">{t("extensionCenter.detail.noRuns")}</p>;
  return <ul className="space-y-1.5">{runs.map((run) => <li key={run.id} className="rounded-lg bg-app-hover px-2.5 py-1.5 text-xs text-tx-secondary">
    <span className="font-mono text-tx-primary">{run.actionId}</span> · {run.status}{typeof run.durationMs === "number" ? ` · ${run.durationMs}ms` : ""}
    {run.errorMessage && <p className="mt-0.5 break-words text-red-600 dark:text-red-300">{run.errorMessage}</p>}
  </li>)}</ul>;
}

export function ExtensionDetailDrawer({ listing, isAdmin, busy, appPagesAvailable, onClose, onAction }: {
  listing: ExtensionListing; isAdmin: boolean; busy: boolean; appPagesAvailable: boolean;
  onClose: () => void; onAction: (listing: ExtensionListing, action: DrawerAction) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [returnFocus] = useState<HTMLElement | null>(() => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    return () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); };
  }, [returnFocus]);

  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => item.offsetParent !== null || item === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const plugin = listing.installed;
  const appPage = plugin?.apiVersion === 3 ? plugin.contributes?.appPages?.[0] : undefined;
  const granted = plugin ? new Set(plugin.permissions.filter((row) => row.granted).map((row) => row.permission)) : undefined;
  const reason = unavailableText(listing, t);
  const act = (action: DrawerAction) => onAction(listing, action);
  const touch = "min-h-11 md:min-h-9";
  const actions: React.ReactNode[] = [];
  if (listing.kind === "builtin") actions.push(<Button key="open" size="sm" className={touch} onClick={() => act("open")}>{t("extensionCenter.action.open")}</Button>);
  if (listing.primaryAction === "install") actions.push(<Button key="install" size="sm" className={touch} disabled={busy} onClick={() => act("install")}>{t("extensionCenter.action.install")}</Button>);
  if (plugin && isAdmin && ["pending", "disabled", "error"].includes(listing.installState) && listing.unavailableReason !== "SERVER_POLICY") {
    actions.push(<Button key="enable" size="sm" className={touch} disabled={busy} onClick={() => act("review-enable")}>{t("extensionCenter.action.reviewEnable")}</Button>);
  }
  if (plugin && listing.installState === "enabled") {
    if (appPage && appPagesAvailable) actions.push(<Button key="app" size="sm" className={touch} onClick={() => act("open-app")}>{t("extensionCenter.action.openApp")}</Button>);
    if (isAdmin && listing.updateVersion && listing.sources.length) actions.push(<Button key="update" size="sm" className={touch} disabled={busy} onClick={() => act("update")}>{t("extensionCenter.action.update")}</Button>);
    if (isAdmin && listing.ungrantedPermissions.length) actions.push(<Button key="grant" size="sm" variant="outline" className={touch} disabled={busy} onClick={() => act("grant")}>{t("extensionCenter.action.grantNew")}</Button>);
    if (isAdmin) actions.push(<Button key="disable" size="sm" variant="outline" className={touch} disabled={busy} onClick={() => act("disable")}>{t("extensionCenter.action.disable")}</Button>);
  }

  // Portal to <body>: an animated (transformed) ancestor would otherwise trap position:fixed.
  return createPortal(<>
    <motion.div {...overlayMotion} className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
    <motion.div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={MOTION_SPRING.panel}
      onKeyDown={keyDown}
      className="fixed bottom-0 right-0 top-0 z-50 flex w-full flex-col border-l border-app-border bg-app-surface shadow-2xl sm:w-[480px]"
    >
      <div className="flex items-start gap-3 border-b border-app-border px-4 py-3" style={{ paddingTop: "calc(var(--safe-area-top, 0px) + 12px)" }}>
        <ExtensionIcon listing={listing} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-base font-semibold text-tx-primary">{listing.name}</h2>
          {listing.kind === "plugin" && <p className="truncate font-mono text-[11px] text-tx-tertiary">{listing.id}</p>}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Chip tone={listing.kind === "builtin" || listing.official ? "info" : "muted"}>{trustBadge(listing, t)}</Chip>
            <Chip tone="muted">{runtimeLabel(listing, t)}</Chip>
          </div>
        </div>
        <button ref={closeButton} type="button" onClick={onClose} aria-label={t("extensionCenter.action.close")} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary md:h-8 md:w-8">
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4" style={{ paddingBottom: "calc(var(--safe-area-bottom, 0px) + 24px)" }}>
        {listing.description && <p className="text-sm leading-relaxed text-tx-secondary">{listing.description}</p>}

        <Section title={t("extensionCenter.detail.status")}>
          <div className="flex flex-wrap gap-1.5">{statusChips(listing, t).map((chip) => <Chip key={chip.key} tone={chip.tone}>{chip.label}</Chip>)}</div>
          {reason && <p className="text-sm text-amber-700 dark:text-amber-300">{reason}</p>}
          {!isAdmin && listing.kind === "plugin" && listing.primaryAction === "needs-admin" && <p role="note" className="rounded-lg bg-app-hover p-3 text-sm text-tx-secondary">{t("extensionCenter.needsAdmin")}</p>}
          {!!actions.length && <div className="flex flex-wrap items-center gap-2">{actions}{busy && <Loader2 size={14} className="animate-spin text-tx-tertiary" aria-hidden />}</div>}
        </Section>

        {listing.kind === "plugin" && <Section title={t("extensionCenter.detail.permissions")}>
          <PermissionList permissions={listing.permissions} granted={granted} highlight={new Set(listing.ungrantedPermissions)} t={t} />
          {!!listing.externalHosts.length && <p className="text-xs text-tx-secondary">{t("extensionCenter.detail.hosts", { hosts: listing.externalHosts.join(", ") })}</p>}
          <p className="text-xs text-tx-tertiary">{t("extensionCenter.detail.dataScope")}</p>
        </Section>}

        {listing.kind === "plugin" && <Section title={t("extensionCenter.detail.info")}>
          <dl className="space-y-1.5">
            {plugin && <InfoRow label={t("extensionCenter.detail.version")}>v{plugin.version}</InfoRow>}
            {listing.latestVersion && <InfoRow label={t("extensionCenter.detail.latest")}>v{listing.latestVersion}</InfoRow>}
            {listing.publisher && <InfoRow label={t("extensionCenter.detail.publisher")}>{listing.publisher}</InfoRow>}
            <InfoRow label={t("extensionCenter.detail.sources")}>{listing.sources.length ? listing.sources.map((source) => source.sourceName).join(", ") : t("extensionCenter.badge.package")}</InfoRow>
            <InfoRow label={t("extensionCenter.detail.runtime")}>{runtimeLabel(listing, t)}</InfoRow>
            <InfoRow label={t("extensionCenter.detail.nowenRange")}>{listing.requiredNowen || t("extensionCenter.detail.unknown")}</InfoRow>
            <InfoRow label={t("extensionCenter.detail.uiPlatforms")}>{listing.uiPlatforms?.length ? listing.uiPlatforms.join(", ") : t("extensionCenter.detail.unknown")}</InfoRow>
            {listing.license && <InfoRow label={t("extensionCenter.detail.license")}>{listing.license}</InfoRow>}
            {listing.publishedAt && <InfoRow label={t("extensionCenter.detail.published")}>{new Date(listing.publishedAt).toLocaleDateString()}</InfoRow>}
            {listing.repository && /^https:\/\//.test(listing.repository) && <InfoRow label={t("extensionCenter.detail.repository")}>
              <a href={listing.repository} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-primary hover:underline">{listing.repository.replace(/^https:\/\//, "")}<ExternalLink size={12} /></a>
            </InfoRow>}
          </dl>
        </Section>}

        {plugin?.status === "enabled" && !!plugin.contributes?.settings?.length && <Section title={t("extensionCenter.detail.settings")}><PluginSettingsForm plugin={plugin} /></Section>}

        {plugin && plugin.apiVersion !== 3 && plugin.runtime !== "declarative" && <Section title={t("extensionCenter.detail.runs")}><RecentRuns pluginId={plugin.id} /></Section>}

        {plugin && isAdmin && <Section title={t("extensionCenter.detail.danger")}>
          <p className="text-sm text-tx-secondary">{appPage || plugin.apiVersion === 3 ? t("extensionCenter.detail.uninstallAppHint") : t("extensionCenter.detail.uninstallHint")}</p>
          <div className="flex flex-wrap gap-2">
            {plugin.apiVersion === 3
              ? <>
                <Button size="sm" variant="outline" className={touch} disabled={busy} onClick={() => act("uninstall-retain")}>{t("extensionCenter.action.uninstallRetain")}</Button>
                <Button size="sm" variant="destructive" className={touch} disabled={busy} onClick={() => act("uninstall-delete")}>{t("extensionCenter.action.uninstallDelete")}</Button>
              </>
              : <Button size="sm" variant="destructive" className={touch} disabled={busy} onClick={() => act("uninstall-plain")}>{t("extensionCenter.action.uninstall")}</Button>}
          </div>
        </Section>}
      </div>
    </motion.div>
  </>, document.body);
}
