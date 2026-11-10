import React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExtensionListing } from "@/lib/extensionCatalog";
import { Chip, ExtensionIcon, runtimeLabel, statusChips, trustBadge } from "./extensionCenterUi";

export type CardAction = "open" | "install" | "review-enable" | "details";

/** Map the server-derived primary action onto the card button. Anything that needs explanation opens the details drawer. */
export function cardActionFor(listing: ExtensionListing): { action: CardAction; labelKey: string; emphasis: boolean } {
  switch (listing.primaryAction) {
    case "open": return { action: "open", labelKey: "extensionCenter.action.open", emphasis: false };
    case "install": return { action: "install", labelKey: "extensionCenter.action.install", emphasis: true };
    case "review-enable": return { action: "review-enable", labelKey: "extensionCenter.action.reviewEnable", emphasis: true };
    case "needs-admin": return { action: "details", labelKey: "extensionCenter.action.needsAdmin", emphasis: false };
    case "unavailable": return { action: "details", labelKey: "extensionCenter.action.unavailable", emphasis: false };
    default: return { action: "details", labelKey: "extensionCenter.action.manage", emphasis: false };
  }
}

export function ExtensionCard({ listing, busy, onAction, compact = false }: {
  listing: ExtensionListing; busy: boolean; compact?: boolean;
  onAction: (listing: ExtensionListing, action: CardAction) => void;
}) {
  const { t } = useTranslation();
  const primary = cardActionFor(listing);
  const meta = [listing.publisher, t(`extensionCenter.category.${listing.category}`)].filter(Boolean).join(" · ");
  return <article data-extension-card={listing.key} className="flex min-w-0 flex-col rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm transition-interactive duration-fast ease-standard hover:border-accent-primary/40 hover:shadow-md">
    <div className="flex items-start gap-3">
      <ExtensionIcon listing={listing} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-tx-primary">
          <button type="button" onClick={() => onAction(listing, "details")} className="max-w-full truncate rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary">{listing.name}</button>
        </h3>
        <p className="truncate text-xs text-tx-tertiary">{meta}</p>
      </div>
      <Chip tone={listing.kind === "builtin" || listing.official ? "info" : "muted"}>{trustBadge(listing, t)}</Chip>
    </div>
    <p className={compact ? "mt-2 line-clamp-2 text-sm text-tx-secondary" : "mt-3 line-clamp-2 min-h-[2.5rem] text-sm text-tx-secondary"}>{listing.description}</p>
    <div className="mt-3 flex flex-wrap gap-1.5">
      <Chip tone="muted">{runtimeLabel(listing, t)}</Chip>
      {statusChips(listing, t).map((chip) => <Chip key={chip.key} tone={chip.tone}>{chip.label}</Chip>)}
    </div>
    <div className="mt-auto flex items-center justify-between gap-2 pt-4">
      <Button type="button" size="sm" variant={primary.emphasis ? "default" : "outline"} disabled={busy} onClick={() => onAction(listing, primary.action)} className="min-h-11 md:min-h-9">
        {busy && <Loader2 size={13} className="mr-1.5 animate-spin" />}{t(primary.labelKey)}
      </Button>
      {primary.action !== "details" && <Button type="button" size="sm" variant="ghost" onClick={() => onAction(listing, "details")} aria-label={`${t("extensionCenter.action.details")} · ${listing.name}`} className="min-h-11 md:min-h-9">
        {t("extensionCenter.action.details")}
      </Button>}
    </div>
  </article>;
}
