import React from "react";
import { useTranslation } from "react-i18next";
import { Blocks, Compass, LayoutDashboard, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { cn } from "@/lib/utils";

export type ExtensionCenterSection = "discover" | "mine" | "dashboard" | "create";

/** Shared header for the Extension Center pages; every entry is an in-app route, not a full reload. */
export function ExtensionCenterLayout({ section, dashboardEnabled, children }: { section: ExtensionCenterSection; dashboardEnabled: boolean; children: React.ReactNode }) {
  const { t } = useTranslation();
  const items = [
    { id: "discover", route: "/apps/discover", label: t("extensionCenter.nav.discover"), Icon: Compass },
    { id: "mine", route: "/apps", label: t("extensionCenter.nav.mine"), Icon: Blocks },
    ...(dashboardEnabled ? [{ id: "dashboard", route: "/apps/dashboard", label: t("extensionCenter.nav.dashboard"), Icon: LayoutDashboard }] : []),
  ];
  return <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full min-w-0 max-w-6xl px-4 pb-12 pt-4 sm:px-6">
      <header className="mb-5 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-xl font-semibold text-tx-primary">{t("extensionCenter.title")}</h1>
          <Button type="button" size="sm" variant={section === "create" ? "outline" : "default"} aria-current={section === "create" ? "page" : undefined}
            className="min-h-11 shrink-0 md:min-h-9" onClick={() => pushAppPathState("/apps/studio")}>
            <Plus size={15} className="mr-1" aria-hidden />{t("extensionCenter.nav.create")}
          </Button>
        </div>
        <nav aria-label={t("extensionCenter.navLabel")} className="mt-3 flex min-w-0 gap-1 overflow-x-auto border-b border-app-border">
          {items.map(({ id, route, label, Icon }) => {
            const active = id === section;
            return <button key={id} type="button" aria-current={active ? "page" : undefined} onClick={() => pushAppPathState(route)}
              className={cn(
                "-mb-px inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition-interactive duration-fast ease-standard md:min-h-10",
                active ? "border-accent-primary font-medium text-accent-primary" : "border-transparent text-tx-secondary hover:text-tx-primary",
              )}>
              <Icon size={15} aria-hidden />{label}
            </button>;
          })}
        </nav>
      </header>
      {children}
    </div>
  </div>;
}
