import React, { useCallback } from "react";
import type { TFunction } from "i18next";
import {
  Blocks, BrainCircuit, CalendarDays, CheckSquare, FileInput, LayoutDashboard, ListChecks, Palette, PenLine, Sparkles, WandSparkles, Workflow,
} from "lucide-react";
import { useAppActions } from "@/store/AppContext";
import { pushAppPathState } from "@/lib/appPathNavigation";
import type { BuiltinNavigation, ExtensionCategory, ExtensionListing, PermissionRisk } from "@/lib/extensionCatalog";
import { permissionRisk } from "@/lib/extensionCatalog";
import { cn } from "@/lib/utils";
import type { ViewMode } from "@/types";

/** i18next treats ":" as a namespace separator, so permission IDs are keyed with underscores. */
export function permissionLabel(permission: string, t: TFunction): string {
  return t(`extensionCenter.permission.${permission.replace(/[:-]/g, "_")}`, { defaultValue: permission });
}

export function builtinTextKey(id: string): string {
  return id.replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase());
}

const CATEGORY_TONE: Record<ExtensionCategory, string> = {
  editor: "bg-gradient-to-br from-violet-400/20 to-purple-500/15 text-violet-700 ring-violet-500/20 dark:text-violet-300",
  workbench: "bg-gradient-to-br from-sky-400/20 to-cyan-500/15 text-sky-700 ring-sky-500/20 dark:text-sky-300",
  productivity: "bg-gradient-to-br from-emerald-400/20 to-teal-500/15 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
  ai: "bg-gradient-to-br from-fuchsia-400/20 to-pink-500/15 text-fuchsia-700 ring-fuchsia-500/20 dark:text-fuchsia-300",
  appearance: "bg-gradient-to-br from-amber-400/20 to-orange-500/15 text-amber-700 ring-amber-500/20 dark:text-amber-300",
  automation: "bg-gradient-to-br from-indigo-400/20 to-blue-500/15 text-indigo-700 ring-indigo-500/20 dark:text-indigo-300",
  import: "bg-gradient-to-br from-teal-400/20 to-emerald-500/15 text-teal-700 ring-teal-500/20 dark:text-teal-300",
  other: "bg-gradient-to-br from-slate-400/20 to-zinc-500/15 text-tx-secondary ring-app-border",
};

export interface CategoryVisualAccent {
  cardTint: string;
  spotlightTint: string;
  hoverBorder: string;
  orb: string;
}

export const CATEGORY_CARD_ACCENT: Record<ExtensionCategory, CategoryVisualAccent> = {
  editor: {
    cardTint: "from-violet-500/[0.04] via-app-surface to-app-surface",
    spotlightTint: "from-violet-500/[0.09] via-app-surface to-purple-500/[0.04]",
    hoverBorder: "hover:border-violet-400/45",
    orb: "bg-violet-400/20",
  },
  workbench: {
    cardTint: "from-sky-500/[0.04] via-app-surface to-app-surface",
    spotlightTint: "from-sky-500/[0.09] via-app-surface to-cyan-500/[0.04]",
    hoverBorder: "hover:border-sky-400/45",
    orb: "bg-sky-400/20",
  },
  productivity: {
    cardTint: "from-emerald-500/[0.04] via-app-surface to-app-surface",
    spotlightTint: "from-emerald-500/[0.09] via-app-surface to-teal-500/[0.04]",
    hoverBorder: "hover:border-emerald-400/45",
    orb: "bg-emerald-400/20",
  },
  ai: {
    cardTint: "from-fuchsia-500/[0.04] via-app-surface to-app-surface",
    spotlightTint: "from-fuchsia-500/[0.09] via-app-surface to-pink-500/[0.04]",
    hoverBorder: "hover:border-fuchsia-400/45",
    orb: "bg-fuchsia-400/20",
  },
  appearance: {
    cardTint: "from-amber-500/[0.04] via-app-surface to-app-surface",
    spotlightTint: "from-amber-500/[0.09] via-app-surface to-orange-500/[0.04]",
    hoverBorder: "hover:border-amber-400/45",
    orb: "bg-amber-400/20",
  },
  automation: {
    cardTint: "from-indigo-500/[0.04] via-app-surface to-app-surface",
    spotlightTint: "from-indigo-500/[0.09] via-app-surface to-blue-500/[0.04]",
    hoverBorder: "hover:border-indigo-400/45",
    orb: "bg-indigo-400/20",
  },
  import: {
    cardTint: "from-teal-500/[0.04] via-app-surface to-app-surface",
    spotlightTint: "from-teal-500/[0.09] via-app-surface to-emerald-500/[0.04]",
    hoverBorder: "hover:border-teal-400/45",
    orb: "bg-teal-400/20",
  },
  other: {
    cardTint: "from-slate-500/[0.03] via-app-surface to-app-surface",
    spotlightTint: "from-slate-500/[0.07] via-app-surface to-app-surface",
    hoverBorder: "hover:border-accent-primary/40",
    orb: "bg-slate-400/15",
  },
};

const CATEGORY_ICON: Record<ExtensionCategory, React.ComponentType<{ size?: number }>> = {
  editor: PenLine, workbench: LayoutDashboard, productivity: ListChecks, ai: Sparkles,
  appearance: Palette, automation: Workflow, import: FileInput, other: Blocks,
};
const BUILTIN_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  dashboard: LayoutDashboard, studio: WandSparkles, tasks: CheckSquare, diary: CalendarDays, mindmaps: BrainCircuit, "ai-chat": Sparkles,
};

export function ExtensionIcon({ listing, size = "md" }: { listing: Pick<ExtensionListing, "kind" | "id" | "category">; size?: "sm" | "md" | "lg" }) {
  const Icon = (listing.kind === "builtin" && BUILTIN_ICON[listing.id]) || CATEGORY_ICON[listing.category];
  return <span aria-hidden className={cn(
    "inline-flex shrink-0 items-center justify-center ring-1 ring-inset",
    size === "lg" ? "h-12 w-12 rounded-xl" : size === "sm" ? "h-9 w-9 rounded-xl" : "h-10 w-10 rounded-xl",
    CATEGORY_TONE[listing.category],
  )}>
    <Icon size={size === "lg" ? 22 : size === "sm" ? 16 : 18} />
  </span>;
}

export function runtimeLabel(listing: Pick<ExtensionListing, "kind" | "runtime" | "apiVersion">, t: TFunction): string {
  if (listing.kind === "builtin") return t("extensionCenter.runtime.builtin");
  if (listing.apiVersion === 3) return t("pluginApps.executionLabel");
  if (listing.runtime === "declarative") return t("extensionCenter.runtime.declarative");
  if (listing.runtime === "node-action") return t("extensionCenter.runtime.node");
  return t("extensionCenter.runtime.sandbox");
}

export function trustBadge(listing: ExtensionListing, t: TFunction): string {
  if (listing.kind === "builtin") return t("extensionCenter.badge.builtin");
  if (listing.official) return t("extensionCenter.badge.official");
  if (!listing.sources.length && listing.installed?.source === "package") return t("extensionCenter.badge.package");
  if (listing.trustLevel === "verified" && listing.sources.some((source) => source.official)) return t("extensionCenter.badge.verified");
  if (listing.trustLevel === "developer") return t("extensionCenter.badge.developer");
  return listing.sources.length && !listing.sources.some((source) => source.official) ? t("extensionCenter.badge.customSource") : t("extensionCenter.badge.community");
}

export type ChipTone = "success" | "warning" | "danger" | "info" | "muted";
const CHIP_TONE: Record<ChipTone, string> = {
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "bg-red-500/10 text-red-700 dark:text-red-300",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  muted: "bg-app-hover text-tx-secondary",
};
export function Chip({ tone, children }: { tone: ChipTone; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-5", CHIP_TONE[tone])}>{children}</span>;
}

export function statusChips(listing: ExtensionListing, t: TFunction): Array<{ key: string; tone: ChipTone; label: string }> {
  const chips: Array<{ key: string; tone: ChipTone; label: string }> = [];
  const state = listing.installState;
  if (state === "enabled") chips.push({ key: "state", tone: "success", label: t("extensionCenter.state.enabled") });
  if (state === "pending") chips.push({ key: "state", tone: "warning", label: t("extensionCenter.state.pending") });
  if (state === "disabled") chips.push({ key: "state", tone: "muted", label: t("extensionCenter.state.disabled") });
  if (state === "error") chips.push({ key: "state", tone: "danger", label: t("extensionCenter.state.error") });
  if (state === "incompatible") chips.push({ key: "state", tone: "danger", label: t("extensionCenter.state.incompatible") });
  if (listing.updateVersion) chips.push({ key: "update", tone: "info", label: t("extensionCenter.state.update", { version: listing.updateVersion }) });
  if (state === "enabled" && listing.ungrantedPermissions.length) chips.push({ key: "ungranted", tone: "warning", label: t("extensionCenter.state.ungranted", { count: listing.ungrantedPermissions.length }) });
  if (listing.uiPlatformSupported === false) chips.push({ key: "platform", tone: "muted", label: t("extensionCenter.state.platformUnsupported") });
  if (listing.hasAdvisory) chips.push({ key: "advisory", tone: "danger", label: t("extensionCenter.state.advisory") });
  return chips;
}

export function unavailableText(listing: ExtensionListing, t: TFunction): string | null {
  switch (listing.unavailableReason) {
    case "NOWEN_VERSION": return t("extensionCenter.reason.NOWEN_VERSION", { range: listing.requiredNowen || "" });
    case "RUNTIME_PLATFORM": return t("extensionCenter.reason.RUNTIME_PLATFORM");
    case "NO_VERSIONS": return t("extensionCenter.reason.NO_VERSIONS");
    case "NODE_POLICY": return t("extensionCenter.reason.NODE_POLICY");
    case "SERVER_POLICY": return t("extensionCenter.reason.SERVER_POLICY", { reason: listing.installed?.compatibility?.allowed === false ? listing.installed.compatibility.reason : "" });
    default: return null;
  }
}

const SIGNATURE_CODES = new Set(["REGISTRY_CHECKSUM_MISMATCH", "PLUGIN_SIGNATURE_INVALID", "REGISTRY_SIGNATURE_INVALID", "PUBLISHER_KEY_REVOKED", "REGISTRY_MANIFEST_MISMATCH"]);
const INCOMPATIBLE_CODES = new Set(["PLUGIN_INCOMPATIBLE", "PLUGIN_NOWEN_INCOMPATIBLE"]);
/**
 * Human-readable error without leaking anything the server did not already return.
 * `raw` keeps the server message as-is (used inside sentences that already say what failed).
 */
export function describeExtensionError(error: unknown, t: TFunction, options: { raw?: boolean } = {}): string {
  const coded = error as { code?: string; status?: number; message?: string } | null;
  if (error instanceof TypeError) return t("extensionCenter.error.network");
  if (coded?.status === 401) return t("extensionCenter.error.session");
  if (coded?.status === 403 || coded?.code === "RESOURCE_FORBIDDEN") return t("extensionCenter.error.forbidden");
  if (coded?.code && SIGNATURE_CODES.has(coded.code)) return t("extensionCenter.error.signature");
  if (coded?.code && INCOMPATIBLE_CODES.has(coded.code)) return t("extensionCenter.error.incompatible");
  const message = coded?.message || String(error);
  return options.raw ? message : t("extensionCenter.error.generic", { message });
}

export function useBuiltinNavigation(): (navigation: BuiltinNavigation) => void {
  const actions = useAppActions();
  return useCallback((navigation: BuiltinNavigation) => {
    if (navigation.type === "path") { pushAppPathState(navigation.path); return; }
    // Same transition the V3 navigation bridge uses: leave /apps, then switch the built-in view.
    pushAppPathState("/");
    actions.setViewMode(navigation.view as ViewMode);
    actions.setMobileView("list");
  }, [actions]);
}

const RISK_TONE: Record<PermissionRisk, ChipTone> = { secrets: "danger", network: "warning", write: "info", read: "muted" };

/** Permission list used by detail drawers and confirmation dialogs. */
export function PermissionList({ permissions, granted, highlight, t }: { permissions: readonly string[]; granted?: ReadonlySet<string>; highlight?: ReadonlySet<string>; t: TFunction }) {
  if (!permissions.length) return <p className="text-sm text-tx-secondary">{t("extensionCenter.detail.noPermissions")}</p>;
  return <ul className="space-y-1.5">
    {permissions.map((permission) => {
      const risk = permissionRisk(permission);
      return <li key={permission} className={cn("flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm", highlight?.has(permission) && "bg-amber-500/10")}>
        <Chip tone={RISK_TONE[risk]}>{t(`extensionCenter.risk.${risk}`)}</Chip>
        <span className="min-w-0 flex-1 text-tx-primary">{permissionLabel(permission, t)}</span>
        {granted && <span className={cn("shrink-0 text-[11px]", granted.has(permission) ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-300")}>
          {granted.has(permission) ? t("extensionCenter.detail.granted") : t("extensionCenter.detail.notGranted")}
        </span>}
      </li>;
    })}
  </ul>;
}
