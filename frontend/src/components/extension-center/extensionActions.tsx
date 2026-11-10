import React from "react";
import type { TFunction } from "i18next";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { confirm } from "@/components/ui/confirm";
import { pluginApi } from "@/lib/pluginApi";
import { sortPermissionsByRisk, type ExtensionListing } from "@/lib/extensionCatalog";
import { toast } from "@/lib/toast";
import { describeExtensionError, PermissionList } from "./extensionCenterUi";

type RuntimeInfo = { runtime?: string | null; apiVersion?: number };

function RuntimeNotice({ info, t }: { info: RuntimeInfo; t: TFunction }) {
  const node = info.runtime === "node-action";
  const text = info.apiVersion === 3 ? t("extensionCenter.confirm.appNote")
    : info.runtime === "declarative" ? t("extensionCenter.confirm.declarativeNote")
      : node ? t("extensionCenter.confirm.nodeWarning")
        : t("extensionCenter.confirm.sandboxNote");
  return <p className={node
    ? "flex gap-2 rounded-lg bg-amber-500/10 p-2.5 text-amber-800 dark:text-amber-200"
    : "flex gap-2 rounded-lg bg-app-hover p-2.5 text-tx-secondary"}>
    {node ? <AlertTriangle size={15} className="mt-0.5 shrink-0" /> : <ShieldCheck size={15} className="mt-0.5 shrink-0" />}
    <span>{text}</span>
  </p>;
}

function ConfirmBody({ info, intro, permissions, hosts, granted, highlight, t }: {
  info: RuntimeInfo; intro: string; permissions: readonly string[]; hosts?: readonly string[];
  granted?: ReadonlySet<string>; highlight?: ReadonlySet<string>; t: TFunction;
}) {
  return <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1 text-sm">
    <RuntimeNotice info={info} t={t} />
    <p className="text-tx-secondary">{intro}</p>
    <PermissionList permissions={sortPermissionsByRisk(permissions)} granted={granted} highlight={highlight} t={t} />
    {!!hosts?.length && <p className="text-xs text-tx-secondary">{t("extensionCenter.detail.hosts", { hosts: hosts.join(", ") })}</p>}
    <p className="text-xs text-tx-tertiary">{t("extensionCenter.detail.dataScope")}</p>
  </div>;
}

/** Runs a server mutation and reports failures without pretending success. */
export async function runExtensionAction(action: () => Promise<boolean>, t: TFunction): Promise<boolean> {
  try { return await action(); }
  catch (error) { toast.error(describeExtensionError(error, t)); return false; }
}

export async function installFromRegistry(listing: ExtensionListing, t: TFunction): Promise<boolean> {
  const sourceId = listing.sources[0]?.sourceId;
  const version = listing.candidate?.version;
  if (!sourceId || !version) return false;
  const node = listing.runtime === "node-action";
  const accepted = await confirm({
    title: t("extensionCenter.confirm.installTitle", { name: listing.name }),
    description: <ConfirmBody t={t} info={{ runtime: listing.runtime, apiVersion: listing.candidate?.apiVersion }}
      intro={t("extensionCenter.confirm.installBody")} permissions={listing.candidate?.permissions || []}
      hosts={listing.candidate?.permissionConfig?.externalFetchHosts} />,
    confirmText: node ? t("extensionCenter.confirm.nodeConfirm") : t("extensionCenter.confirm.installConfirm"),
    cancelText: t("extensionCenter.confirm.cancel"),
    danger: node,
  });
  if (!accepted) return false;
  await pluginApi.installFromRegistry(sourceId, listing.id, version);
  toast.success(t("extensionCenter.toast.installed", { name: listing.name }));
  return true;
}

/** Grants exactly the declared permissions shown in the dialog, then enables (same server flow as the legacy manager). */
export async function reviewAndEnable(listing: ExtensionListing, t: TFunction): Promise<boolean> {
  const plugin = listing.installed;
  if (!plugin) return false;
  const declared = plugin.permissions.map((row) => row.permission);
  const granted = new Set(plugin.permissions.filter((row) => row.granted).map((row) => row.permission));
  const accepted = await confirm({
    title: t("extensionCenter.confirm.enableTitle", { name: listing.name }),
    description: <ConfirmBody t={t} info={plugin} intro={t("extensionCenter.confirm.enableBody")} permissions={declared}
      hosts={listing.externalHosts} granted={granted} highlight={new Set(listing.ungrantedPermissions)} />,
    confirmText: t("extensionCenter.confirm.enableConfirm"),
    cancelText: t("extensionCenter.confirm.cancel"),
  });
  if (!accepted) return false;
  const declarative = plugin.apiVersion !== 3 && plugin.runtime === "declarative";
  if (!declarative) await pluginApi.grant(plugin.id, declared);
  await pluginApi.enable(plugin.id);
  toast.success(t("extensionCenter.toast.enabled", { name: listing.name }));
  return true;
}

export async function grantPendingPermissions(listing: ExtensionListing, t: TFunction): Promise<boolean> {
  const plugin = listing.installed;
  if (!plugin) return false;
  const declared = plugin.permissions.map((row) => row.permission);
  const accepted = await confirm({
    title: t("extensionCenter.confirm.grantTitle", { name: listing.name }),
    description: <ConfirmBody t={t} info={plugin} intro={t("extensionCenter.confirm.enableBody")} permissions={declared}
      granted={new Set(plugin.permissions.filter((row) => row.granted).map((row) => row.permission))}
      highlight={new Set(listing.ungrantedPermissions)} />,
    confirmText: t("extensionCenter.confirm.grantConfirm"),
    cancelText: t("extensionCenter.confirm.cancel"),
  });
  if (!accepted) return false;
  await pluginApi.grant(plugin.id, declared);
  toast.success(t("extensionCenter.toast.granted", { name: listing.name }));
  return true;
}

export async function disableExtension(listing: ExtensionListing, t: TFunction): Promise<boolean> {
  if (!listing.installed) return false;
  const accepted = await confirm({
    title: t("extensionCenter.confirm.disableTitle", { name: listing.name }),
    description: t("extensionCenter.confirm.disableBody"),
    confirmText: t("extensionCenter.action.disable"),
    cancelText: t("extensionCenter.confirm.cancel"),
  });
  if (!accepted) return false;
  await pluginApi.disable(listing.installed.id);
  toast.success(t("extensionCenter.toast.disabled", { name: listing.name }));
  return true;
}

/** Reads the authoritative permission diff from the server before asking for confirmation. */
export async function updateExtension(listing: ExtensionListing, t: TFunction): Promise<boolean> {
  const sourceId = listing.sources[0]?.sourceId;
  if (!sourceId || !listing.installed) return false;
  const update = (await pluginApi.checkUpdates(sourceId)).find((item) => item.pluginId === listing.id);
  if (!update) { toast.info(t("extensionCenter.toast.noUpdate")); return false; }
  const added = update.permissionDiff.added || [];
  const hosts = update.permissionDiff.addedHosts || [];
  const accepted = await confirm({
    title: t("extensionCenter.confirm.updateTitle", { name: listing.name, version: update.availableVersion }),
    description: <div className="space-y-3 text-sm">
      <p className="text-tx-secondary">{update.confirmationRequired ? t("extensionCenter.confirm.updateWidened") : t("extensionCenter.confirm.updatePlain")}</p>
      {!!added.length && <div><h4 className="mb-1.5 text-xs font-semibold text-tx-primary">{t("extensionCenter.confirm.addedPermissions")}</h4>
        <PermissionList permissions={sortPermissionsByRisk(added)} highlight={new Set(added)} t={t} /></div>}
      {!!hosts.length && <p className="text-xs text-tx-secondary">{t("extensionCenter.confirm.addedHosts", { hosts: hosts.join(", ") })}</p>}
    </div>,
    confirmText: t("extensionCenter.confirm.updateConfirm"),
    cancelText: t("extensionCenter.confirm.cancel"),
  });
  if (!accepted) return false;
  await pluginApi.applyUpdate(sourceId, listing.id, update.availableVersion, update.confirmationRequired);
  toast.success(t("extensionCenter.toast.updated", { name: listing.name }));
  return true;
}

export type UninstallMode = "plain" | "retain" | "delete";
export async function uninstallExtension(listing: ExtensionListing, mode: UninstallMode, t: TFunction): Promise<boolean> {
  if (!listing.installed) return false;
  const copy = {
    plain: { title: "extensionCenter.confirm.uninstallTitle", body: "extensionCenter.detail.uninstallHint", action: "extensionCenter.action.uninstall" },
    retain: { title: "extensionCenter.confirm.uninstallRetainTitle", body: "extensionCenter.confirm.uninstallRetainBody", action: "extensionCenter.action.uninstallRetain" },
    delete: { title: "extensionCenter.confirm.uninstallDeleteTitle", body: "extensionCenter.confirm.uninstallDeleteBody", action: "extensionCenter.action.uninstallDelete" },
  }[mode];
  const accepted = await confirm({
    title: t(copy.title, { name: listing.name }),
    description: t(copy.body),
    confirmText: t(copy.action),
    cancelText: t("extensionCenter.confirm.cancel"),
    danger: true,
  });
  if (!accepted) return false;
  await pluginApi.uninstall(listing.installed.id, mode === "delete", mode === "retain");
  toast.success(t("extensionCenter.toast.uninstalled", { name: listing.name }));
  return true;
}

interface PackageManifestPreview { id?: string; name?: string; version?: string; apiVersion?: number; runtime?: string; permissions?: string[]; permissionConfig?: { externalFetchHosts?: string[] } }

/** Administrator package upload: preview the bundled manifest, then let the server validate and quarantine it. */
export async function installPackageFile(file: File, t: TFunction): Promise<boolean> {
  let manifest: PackageManifestPreview;
  try {
    const { default: JSZip } = await import("jszip");
    const entry = (await JSZip.loadAsync(file)).file("manifest.json");
    if (!entry) throw new Error("manifest.json");
    manifest = JSON.parse(await entry.async("string")) as PackageManifestPreview;
  } catch (error) {
    toast.error(t("extensionCenter.error.packageInvalid", { message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
  const name = manifest.name || manifest.id || file.name;
  const accepted = await confirm({
    title: t("extensionCenter.confirm.installTitle", { name }),
    description: <ConfirmBody t={t} info={manifest} intro={t("extensionCenter.confirm.installBody")}
      permissions={Array.isArray(manifest.permissions) ? manifest.permissions : []} hosts={manifest.permissionConfig?.externalFetchHosts} />,
    confirmText: t("extensionCenter.confirm.installConfirm"),
    cancelText: t("extensionCenter.confirm.cancel"),
  });
  if (!accepted) return false;
  try {
    await pluginApi.install(file, false);
  } catch (error) {
    const coded = error as { code?: string; confirmNodeRuntimeAllowed?: boolean };
    if (coded.code !== "PLUGIN_NODE_RUNTIME_CONFIRMATION_REQUIRED" || !coded.confirmNodeRuntimeAllowed) throw error;
    const confirmed = await confirm({
      title: t("extensionCenter.confirm.installTitle", { name }),
      description: t("extensionCenter.confirm.nodeWarning"),
      confirmText: t("extensionCenter.confirm.nodeConfirm"),
      cancelText: t("extensionCenter.confirm.cancel"),
      danger: true,
    });
    if (!confirmed) return false;
    await pluginApi.install(file, true);
  }
  toast.success(t("extensionCenter.toast.installed", { name }));
  return true;
}
