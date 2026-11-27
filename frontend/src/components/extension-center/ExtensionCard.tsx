import React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExtensionListing } from "@/lib/extensionCatalog";
import { cn } from "@/lib/utils";
import { CATEGORY_CARD_ACCENT, Chip, ExtensionIcon, statusChips, trustBadge } from "./extensionCenterUi";

export type CardAction = "open" | "open-app" | "install" | "review-enable" | "details";

/** Map the server-derived primary action onto the card button. Anything that needs explanation opens the details drawer. */
export function cardActionFor(listing: ExtensionListing, appPagesAvailable = false): { action: CardAction; labelKey: string; emphasis: boolean; muted?: boolean } {
  // An enabled app is opened directly; everything else about it lives in the details drawer.
  if (appPagesAvailable && listing.installState === "enabled" && listing.installed?.apiVersion === 3 && listing.installed.contributes?.appPages?.length) {
    return { action: "open-app", labelKey: "extensionCenter.action.open", emphasis: true };
  }
  switch (listing.primaryAction) {
    case "open": return { action: "open", labelKey: "extensionCenter.action.open", emphasis: false };
    case "install": return { action: "install", labelKey: "extensionCenter.action.install", emphasis: true };
    case "review-enable": return { action: "review-enable", labelKey: "extensionCenter.action.reviewEnable", emphasis: true };
    case "needs-admin": return { action: "details", labelKey: "extensionCenter.action.needsAdmin", emphasis: false, muted: true };
    case "unavailable": return { action: "details", labelKey: "extensionCenter.action.unavailable", emphasis: false, muted: true };
    default: return { action: "details", labelKey: "extensionCenter.action.manage", emphasis: false };
  }
}

export function ExtensionCard({
  listing,
  busy,
  onAction,
  compact = false,
  spotlight = false,
  tagline,
  appPagesAvailable = false,
  menu,
}: {
  listing: ExtensionListing;
  busy: boolean;
  compact?: boolean;
  /** Highlighted editorial pick card in Discover's top row. */
  spotlight?: boolean;
  tagline?: string;
  appPagesAvailable?: boolean;
  /** Secondary actions ("···"); the card itself keeps a single primary action. */
  menu?: React.ReactNode;
  onAction: (listing: ExtensionListing, action: CardAction) => void;
}) {
  const { t } = useTranslation();
  const primary = cardActionFor(listing, appPagesAvailable);
  const chips = statusChips(listing, t);
  const accent = CATEGORY_CARD_ACCENT[listing.category];
  const meta = [listing.publisher, t(`extensionCenter.category.${listing.category}`)].filter(Boolean).join(" · ");

  if (spotlight) {
    return (
      <article
        data-extension-card={listing.key}
        className={cn(
          "group/ext relative flex min-w-0 flex-col rounded-2xl border border-app-border/85 bg-gradient-to-br p-3.5 shadow-sm transition-all duration-200 ease-standard hover:shadow-md motion-safe:hover:-translate-y-0.5",
          accent.spotlightTint,
          accent.hoverBorder,
        )}
      >
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          <div className={cn("absolute -right-6 -top-6 h-20 w-20 rounded-full blur-2xl opacity-70 transition-opacity duration-300 group-hover/ext:opacity-100", accent.orb)} />
        </div>
        <div className="relative flex items-start justify-between gap-2">
          <div className="shrink-0 transition-transform duration-200 motion-safe:group-hover/ext:scale-110 motion-safe:group-hover/ext:-rotate-6">
            <ExtensionIcon listing={listing} size="md" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Chip tone={listing.kind === "builtin" || listing.official ? "info" : "muted"}>{trustBadge(listing, t)}</Chip>
            <Button
              type="button"
              size="sm"
              variant={primary.emphasis ? "default" : primary.muted ? "ghost" : "outline"}
              disabled={busy}
              onClick={() => onAction(listing, primary.action)}
              className={cn(
                "h-7 rounded-lg px-2.5 text-xs",
                primary.muted && "bg-app-hover/70 text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary",
              )}
            >
              {busy && <Loader2 size={12} className="mr-1 animate-spin" />}
              {t(primary.labelKey)}
            </Button>
          </div>
        </div>
        <div className="relative mt-2.5 min-w-0">
          <h3 className="truncate text-sm font-semibold text-tx-primary">
            <button
              type="button"
              onClick={() => onAction(listing, "details")}
              className="max-w-full truncate rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary"
            >
              {listing.name}
            </button>
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-tx-tertiary">{meta}</p>
        </div>
        {(tagline || listing.description) && (
          <p className="relative mt-2 line-clamp-2 text-xs leading-relaxed text-tx-secondary">
            {tagline || listing.description}
          </p>
        )}
        {!!chips.length && (
          <div className="relative mt-2.5 flex flex-wrap gap-1">
            {chips.map((chip) => (
              <Chip key={chip.key} tone={chip.tone}>
                {chip.label}
              </Chip>
            ))}
          </div>
        )}
      </article>
    );
  }

  return (
    <article
      data-extension-card={listing.key}
      className={cn(
        "group/ext relative flex min-w-0 flex-col rounded-2xl border border-app-border/85 bg-gradient-to-br p-3.5 shadow-sm transition-all duration-200 ease-standard hover:shadow-md motion-safe:hover:-translate-y-0.5",
        accent.cardTint,
        accent.hoverBorder,
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 transition-transform duration-200 motion-safe:group-hover/ext:scale-110 motion-safe:group-hover/ext:-rotate-6">
          <ExtensionIcon listing={listing} size="sm" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="min-w-0 truncate text-[13px] font-semibold leading-snug text-tx-primary">
              <button
                type="button"
                onClick={() => onAction(listing, "details")}
                className="max-w-full truncate rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary"
              >
                {listing.name}
              </button>
            </h3>
            <Chip tone={listing.kind === "builtin" || listing.official ? "info" : "muted"}>{trustBadge(listing, t)}</Chip>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-tx-tertiary">{meta}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={primary.emphasis ? "default" : primary.muted ? "ghost" : "outline"}
            disabled={busy}
            onClick={() => onAction(listing, primary.action)}
            className={cn(
              "h-7 rounded-lg px-2.5 text-xs",
              primary.muted && "bg-app-hover/70 text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary",
            )}
          >
            {busy && <Loader2 size={12} className="mr-1 animate-spin" />}
            {t(primary.labelKey)}
          </Button>
          {menu}
        </div>
      </div>
      {listing.description && (
        <p className={compact ? "mt-2 line-clamp-2 text-xs leading-relaxed text-tx-secondary" : "mt-2 line-clamp-2 text-xs leading-relaxed text-tx-secondary"}>
          {listing.description}
        </p>
      )}
      {!!chips.length && (
        <div className="mt-2 flex flex-wrap gap-1">
          {chips.map((chip) => (
            <Chip key={chip.key} tone={chip.tone}>
              {chip.label}
            </Chip>
          ))}
        </div>
      )}
    </article>
  );
}
