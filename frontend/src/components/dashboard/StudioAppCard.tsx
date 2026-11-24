import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { pushAppPathState } from "@/lib/appPathNavigation";
import type { StudioApp } from "@/lib/personalApps";

export type StudioCardState = "loading" | "ready" | "missing" | "failed";

/**
 * Body of a Personal Studio shortcut card. The app comes from the owner-only Studio API; an app that was
 * deleted or belongs to another account shows nothing of its content.
 */
export function StudioAppCardBody({ app, state, onRetry }: { app?: StudioApp; state: StudioCardState; onRetry: () => void }) {
  const { t } = useTranslation();
  if (state === "loading") return <div role="status" aria-label={t("extensionCenter.workbench.loading")} className="space-y-2 py-1">
    {[0, 1].map((index) => <div key={index} className="h-3 rounded bg-app-hover motion-safe:animate-pulse" style={{ width: `${80 - index * 20}%` }} />)}
  </div>;
  if (state === "failed") return <div role="alert" className="space-y-2 text-sm text-red-700 dark:text-red-300">
    <span className="block">{t("extensionCenter.workbench.studio.loadFailed")}</span>
    <Button size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={onRetry}>{t("extensionCenter.discover.retry")}</Button>
  </div>;
  if (state === "missing" || !app) return <p className="text-sm text-tx-secondary">{t("extensionCenter.workbench.studio.missing")}</p>;

  const { spec } = app;
  const primary = spec.fields.find((field) => field.type === "text");
  const check = spec.fields.find((field) => field.type === "checkbox");
  const done = check ? spec.items.filter((item) => item.values[check.id] === true).length : 0;
  // Records are appended in the order they were added: show the newest three first.
  const latest = primary ? spec.items.map((item) => String(item.values[primary.id] ?? "").trim()).filter(Boolean).slice(-3).reverse() : [];
  return <div className="space-y-2 text-sm">
    {spec.description && <p className="line-clamp-2 text-xs text-tx-secondary">{spec.description}</p>}
    <p className="text-xs text-tx-tertiary">{check
      ? t("extensionCenter.workbench.studio.progress", { done, count: spec.items.length })
      : t("extensionCenter.workbench.studio.records", { count: spec.items.length })}</p>
    {latest.length > 0 && <ul className="space-y-0.5">{latest.map((text, index) => <li key={index} className="truncate text-tx-primary">{text}</li>)}</ul>}
    <Button size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => pushAppPathState(`/apps/personal/${app.id}`)}>{t("extensionCenter.workbench.studio.open")}</Button>
  </div>;
}
