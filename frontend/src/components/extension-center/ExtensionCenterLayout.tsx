import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Blocks, BookOpen, Compass, Copy, ExternalLink, LayoutDashboard, Plus, Sparkles, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { AI_FOOLPROOF_GUIDE_URL, buildPluginAiPrompt } from "@/lib/pluginAiPromptTemplate";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const OFFICIAL_TUTORIAL_URL = "https://nowen.cn/#/note/tutorials";
const PLUGIN_AUTHOR_GUIDE_URL =
  "https://github.com/cropflre/nowen-note/blob/main/docs/plugin-platform/plugin-author-guide-v16.md";
const QUICKSTART_COMMANDS = `npm create nowen-plugin
cd my-plugin && npm install
npx nowen-plugin validate && npx nowen-plugin build && npx nowen-plugin pack`;

export type ExtensionCenterSection = "discover" | "mine" | "dashboard" | "create";

interface PackageUpload {
  busy: boolean;
  install: (file: File) => Promise<boolean>;
}

/** Shared header for the Extension Center pages; every entry is an in-app route, not a full reload. */
export function ExtensionCenterLayout({ section, dashboardEnabled, packageUpload, children }: {
  section: ExtensionCenterSection; dashboardEnabled: boolean; packageUpload?: PackageUpload; children: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [aiRequirement, setAiRequirement] = useState("");

  const copyCommands = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(QUICKSTART_COMMANDS).then(() => {
        toast.success(t("extensionCenter.devGuide.copied"));
      }).catch(() => {});
    }
  };

  const copyAiPrompt = () => {
    const lang = (i18n?.resolvedLanguage || i18n?.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const promptText = buildPluginAiPrompt(aiRequirement, lang);
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(promptText).then(() => {
        toast.success(t("extensionCenter.devGuide.aiPromptCopied"));
      }).catch(() => {});
    }
  };
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
              <Button
                type="button"
                size="sm"
                variant={guideOpen ? "secondary" : "ghost"}
                aria-expanded={guideOpen}
                aria-controls="extension-center-dev-guide"
                className="min-h-11 md:min-h-9"
                onClick={() => setGuideOpen((prev) => !prev)}
              >
                <BookOpen size={15} className="mr-1" aria-hidden />
                {t("extensionCenter.devGuide.button")}
              </Button>
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
          {packageUpload && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tx-secondary">
              <span>{t("extensionCenter.upload.hint")}</span>
              <button
                type="button"
                onClick={() => setGuideOpen((prev) => !prev)}
                className="font-medium text-accent-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent-primary"
              >
                {t("extensionCenter.devGuide.howToLink")}
              </button>
            </div>
          )}
          {guideOpen && (
            <section
              id="extension-center-dev-guide"
              aria-label={t("extensionCenter.devGuide.title")}
              className="mt-3 rounded-2xl border border-app-border bg-app-surface p-4 text-sm shadow-sm space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold text-tx-primary">{t("extensionCenter.devGuide.title")}</h2>
                  <p className="mt-0.5 text-xs text-tx-secondary">{t("extensionCenter.devGuide.subtitle")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setGuideOpen(false)}
                  aria-label={t("extensionCenter.devGuide.close")}
                  className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary focus-visible:outline-2 focus-visible:outline-accent-primary"
                >
                  <X size={15} aria-hidden />
                </button>
              </div>

              <div className="rounded-xl border border-accent-primary/25 bg-accent-primary/[0.05] p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-tx-primary">
                  <Sparkles size={14} className="text-accent-primary shrink-0" aria-hidden />
                  {t("extensionCenter.devGuide.aiPromptTitle")}
                </div>
                <textarea
                  value={aiRequirement}
                  onChange={(event) => setAiRequirement(event.target.value)}
                  aria-label={t("extensionCenter.devGuide.aiInputLabel")}
                  placeholder={t("extensionCenter.devGuide.aiInputPlaceholder")}
                  rows={2}
                  className="w-full rounded-lg border border-app-border bg-app-bg px-2.5 py-2 text-xs text-tx-primary placeholder:text-tx-tertiary outline-none focus:border-accent-primary focus:ring-1 focus:ring-accent-primary resize-y"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" className="min-h-10 md:min-h-8" onClick={copyAiPrompt}>
                    <Copy size={13} className="mr-1" aria-hidden />
                    {t("extensionCenter.devGuide.copyAiPrompt")}
                  </Button>
                  <a
                    href={AI_FOOLPROOF_GUIDE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-10 items-center gap-1 rounded-md border border-app-border bg-app-bg px-3 text-xs font-medium text-tx-primary hover:bg-app-hover focus-visible:outline-2 focus-visible:outline-accent-primary md:min-h-8"
                  >
                    {t("extensionCenter.devGuide.aiGuideDoc")}
                    <ExternalLink size={13} aria-hidden />
                  </a>
                </div>
              </div>

              <div className="grid gap-2.5 md:grid-cols-3">
                <div className="rounded-xl border border-app-border bg-app-bg p-3">
                  <div className="text-xs font-semibold text-tx-primary">{t("extensionCenter.devGuide.step1Title")}</div>
                  <p className="mt-1.5 text-xs leading-relaxed text-tx-secondary">{t("extensionCenter.devGuide.step1Note")}</p>
                </div>
                <div className="rounded-xl border border-app-border bg-app-bg p-3">
                  <div className="text-xs font-semibold text-tx-primary">{t("extensionCenter.devGuide.step2Title")}</div>
                  <code className="mt-1.5 block rounded bg-app-hover px-2 py-1 font-mono text-[11px] text-tx-primary">
                    npx nowen-plugin build &amp;&amp; npx nowen-plugin pack
                  </code>
                  <p className="mt-1 text-[11px] text-tx-tertiary">{t("extensionCenter.devGuide.step2Note")}</p>
                </div>
                <div className="rounded-xl border border-app-border bg-app-bg p-3">
                  <div className="text-xs font-semibold text-tx-primary">{t("extensionCenter.devGuide.step3Title")}</div>
                  <p className="mt-1.5 text-xs leading-relaxed text-tx-secondary">{t("extensionCenter.devGuide.step3Note")}</p>
                </div>
              </div>

              <p className="text-xs text-tx-secondary">{t("extensionCenter.devGuide.capabilities")}</p>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button type="button" size="sm" variant="outline" className="min-h-10 md:min-h-8" onClick={copyCommands}>
                  <Copy size={13} className="mr-1" aria-hidden />
                  {t("extensionCenter.devGuide.copyCmd")}
                </Button>
                <a
                  href={OFFICIAL_TUTORIAL_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-10 items-center gap-1 rounded-md border border-app-border bg-app-bg px-3 text-xs font-medium text-tx-primary hover:bg-app-hover focus-visible:outline-2 focus-visible:outline-accent-primary md:min-h-8"
                >
                  {t("extensionCenter.devGuide.officialTutorial")}
                  <ExternalLink size={13} aria-hidden />
                </a>
                <a
                  href={PLUGIN_AUTHOR_GUIDE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-10 items-center gap-1 rounded-md border border-app-border bg-app-bg px-3 text-xs font-medium text-tx-primary hover:bg-app-hover focus-visible:outline-2 focus-visible:outline-accent-primary md:min-h-8"
                >
                  {t("extensionCenter.devGuide.authorDocs")}
                  <ExternalLink size={13} aria-hidden />
                </a>
              </div>
            </section>
          )}
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
