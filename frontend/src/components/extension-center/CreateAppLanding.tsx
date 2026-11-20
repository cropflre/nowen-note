import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, BookOpen, CalendarCheck, LayoutGrid, ListChecks, Plane, Users, type LucideIcon } from "lucide-react";
import { PersonalStudioAI } from "@/components/PersonalStudioAI";
import { useAIConnectionAvailable } from "@/lib/aiConnection";
import { matchStudioTemplates, newStudioSpec, STUDIO_TEMPLATES, type StudioSpec, type StudioTemplate } from "@/lib/personalApps";

const TEMPLATE_ICON: Record<StudioTemplate, LucideIcon> = {
  tracker: LayoutGrid, reading: BookOpen, habits: CalendarCheck, meeting: Users, travel: Plane, checklist: ListChecks, records: Archive,
};

/**
 * "Create app" in the Extension Center: describe the app to AI, or start from a template. Both paths only
 * open an unsaved draft in the existing Personal Studio editor; nothing is stored until the user saves it.
 */
export function CreateAppLanding({ onPick }: { onPick: (spec: StudioSpec) => void }) {
  const { t } = useTranslation();
  const aiAvailable = useAIConnectionAvailable();
  const [request, setRequest] = useState("");
  useEffect(() => {
    if (!aiAvailable) setRequest("");
  }, [aiAvailable]);
  // A template that already matches the description is offered before (or instead of) asking AI.
  const suggested = useMemo(() => matchStudioTemplates(request), [request]);
  const pick = (template: StudioTemplate) => onPick(newStudioSpec(template, t));
  const title = (template: StudioTemplate) => t(`extensionCenter.create.templates.${template}.title`);

  return <div className="space-y-6">
    <header className="min-w-0">
      <h2 className="text-lg font-semibold text-tx-primary">{t("extensionCenter.create.heading")}</h2>
      {aiAvailable && <p className="mt-1 text-sm text-tx-secondary">{t("extensionCenter.create.subtitle")}</p>}
    </header>
    {aiAvailable && <PersonalStudioAI spec={null} onAccept={onPick} onPromptChange={setRequest} />}
    {aiAvailable && suggested.length > 0 && <div role="note" className="flex flex-wrap items-center gap-2 rounded-xl border border-app-border bg-app-hover/40 px-3 py-2 text-sm">
      <span className="text-tx-secondary">{t("extensionCenter.create.suggestion")}</span>
      {suggested.map((template) => <button key={template} type="button" onClick={() => pick(template)}
        className="inline-flex min-h-11 items-center rounded-full border border-accent-primary/40 px-3 text-accent-primary hover:bg-accent-primary/10 md:min-h-8">
        {title(template)}
      </button>)}
    </div>}
    <section aria-labelledby="create-templates-heading" className="space-y-3">
      <div>
        <h3 id="create-templates-heading" className="text-base font-semibold text-tx-primary">{t("extensionCenter.create.templatesHeading")}</h3>
        <p className="mt-1 text-xs text-tx-secondary">{t("extensionCenter.create.templatesHint")}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{STUDIO_TEMPLATES.map((template) => {
        const Icon = TEMPLATE_ICON[template.id];
        const key = `extensionCenter.create.templates.${template.id}`;
        return <li key={template.id} className="min-w-0">
          <button type="button" aria-label={title(template.id)} aria-describedby={`create-template-${template.id}`} onClick={() => pick(template.id)}
            className="flex h-full w-full flex-col gap-3 rounded-2xl border border-app-border bg-app-surface p-4 text-left transition-interactive duration-fast ease-standard hover:border-accent-primary hover:bg-app-hover">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary"><Icon size={18} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-tx-primary">{title(template.id)}</span>
                <span className="block text-xs text-tx-tertiary">{t(`extensionCenter.create.layout.${template.layout}`)}</span>
              </span>
            </span>
            <span id={`create-template-${template.id}`} className="text-sm text-tx-secondary">{t(`${key}.description`)}</span>
            <span aria-hidden className="flex flex-wrap gap-1.5">{template.fields.map((field) => <span key={field.id} className="rounded-full border border-app-border px-2 py-0.5 text-[11px] text-tx-secondary">{t(`${key}.fields.${field.id}`)}</span>)}</span>
          </button>
        </li>;
      })}</ul>
    </section>
    <p className="text-xs text-tx-tertiary">{t("extensionCenter.create.scope")}</p>
  </div>;
}
