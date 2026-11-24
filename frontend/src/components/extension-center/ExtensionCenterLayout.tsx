import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Blocks, Compass, LayoutDashboard, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type ExtensionCenterSection = "discover" | "mine" | "dashboard" | "create";

interface PackageUpload {
  busy: boolean;
  install: (file: File) => Promise<boolean>;
}

/** Shared header for the Extension Center pages; every entry is an in-app route, not a full reload. */
export function ExtensionCenterLayout({ section, dashboardEnabled, packageUpload, children }: {
  section: ExtensionCenterSection; dashboardEnabled: boolean; packageUpload?: PackageUpload; children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const selectPackage = (files: FileList | null) => {
    if (!packageUpload || packageUpload.busy || !files?.length) return;
    if (files.length !== 1 || !files[0].name.endsWith(".nowen-plugin")) {
      toast.error(t("extensionCenter.upload.singlePackage"));
      return;
    }
    void packageUpload.install(files[0]);
  };
  const items = [
    { id: "discover", route: "/apps/discover", label: t("extensionCenter.nav.discover"), Icon: Compass },
    { id: "mine", route: "/apps", label: t("extensionCenter.nav.mine"), Icon: Blocks },
    ...(dashboardEnabled ? [{ id: "dashboard", route: "/apps/dashboard", label: t("extensionCenter.nav.dashboard"), Icon: LayoutDashboard }] : []),
  ];
  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    onDragEnter={(event) => {
      if (!packageUpload || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      if (++dragDepth.current === 1) setDragging(true);
    }}
    onDragOver={(event) => {
      if (!packageUpload || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = packageUpload.busy ? "none" : "copy";
    }}
    onDragLeave={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    }}
    onDrop={(event) => {
      if (!packageUpload || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      selectPackage(event.dataTransfer.files);
    }}>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full min-w-0 max-w-6xl px-4 pb-12 pt-4 sm:px-6">
        <header className="mb-5 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="min-w-0 truncate text-xl font-semibold text-tx-primary">{t("extensionCenter.title")}</h1>
            <div className="flex flex-wrap items-center gap-2">
              {packageUpload && <>
                <input ref={fileInput} type="file" accept=".nowen-plugin" hidden onChange={(event) => {
                  selectPackage(event.currentTarget.files);
                  event.currentTarget.value = "";
                }} />
                <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-9" disabled={packageUpload.busy}
                  onClick={() => fileInput.current?.click()}>
                  <Upload size={15} className="mr-1" aria-hidden />{t("extensionCenter.upload.button")}
                </Button>
              </>}
              <Button type="button" size="sm" variant={section === "create" ? "outline" : "default"} aria-current={section === "create" ? "page" : undefined}
                className="min-h-11 shrink-0 md:min-h-9" onClick={() => pushAppPathState("/apps/studio")}>
                <Plus size={15} className="mr-1" aria-hidden />{t("extensionCenter.nav.create")}
              </Button>
            </div>
          </div>
          <nav aria-label={t("extensionCenter.navLabel")} className="mt-3 flex min-w-0 gap-1 overflow-x-auto border-b border-app-border">
            {items.map(({ id, route, label, Icon }) => {
              const active = id === section;
              return <button key={id} type="button" aria-current={active ? "page" : undefined} onClick={() => pushAppPathState(route)}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition-interactive duration-fast ease-standard md:min-h-10",
                  active ? "border-accent-primary font-medium text-accent-primary" : "border-transparent text-tx-secondary hover:text-tx-primary",
                )}>
                <Icon size={15} aria-hidden />{label}
              </button>;
            })}
          </nav>
          {packageUpload && <p className="mt-2 text-xs text-tx-secondary">{t("extensionCenter.upload.hint")}</p>}
        </header>
        {children}
      </div>
    </div>
    {packageUpload && !packageUpload.busy && dragging && <div role="status"
      className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-accent-primary bg-app-surface/95 p-4 text-center text-sm font-medium text-tx-primary">
      <Upload size={24} className="text-accent-primary" aria-hidden />
      {t("extensionCenter.upload.drop")}
    </div>}
  </div>;
}
