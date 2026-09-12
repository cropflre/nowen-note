import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { NOTE_THEMES, resolveDocumentThemeMode } from "@/lib/noteTheme";
import { cn } from "@/lib/utils";

export default function NoteThemePicker() {
  const { i18n } = useTranslation();
  const { prefs, setPref } = useUserPreferences();
  const language = i18n.language.startsWith("zh") ? "zh" : "en";
  const mode = resolveDocumentThemeMode();
  const copy = language === "zh"
    ? {
        title: "笔记主题",
        description: "只改变编辑与阅读外观，不修改笔记正文；选择会同步到当前账号。",
        sampleTitle: "把想法写下来",
        sampleBody: "清晰的排版，让阅读和写作保持舒适。",
      }
    : {
        title: "Note theme",
        description: "Changes reading and editing appearance without modifying note content. Synced to this account.",
        sampleTitle: "Write your ideas down",
        sampleBody: "Clear typography keeps reading and writing comfortable.",
      };

  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/30">
      <div>
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{copy.title}</span>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {copy.description}
        </p>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {NOTE_THEMES.map((theme) => {
          const selected = prefs.noteTheme === theme.id;
          const tokens = theme.modes[mode];
          return (
            <button
              key={theme.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setPref("noteTheme", theme.id)}
              className={cn(
                "overflow-hidden rounded-lg border text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50",
                selected
                  ? "border-accent-primary ring-1 ring-accent-primary/30"
                  : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600",
              )}
            >
              <div className="h-20 px-4 py-3" style={{ background: tokens.surface, color: tokens.text }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-bold" style={{ color: tokens.heading }}>{copy.sampleTitle}</span>
                  {selected && <Check size={14} style={{ color: tokens.accent }} />}
                </div>
                <p className="mt-2 text-[10px]" style={{ lineHeight: tokens.lineHeight }}>
                  {copy.sampleBody}
                </p>
                <div className="mt-2 h-0.5 w-10 rounded-full" style={{ background: tokens.accent }} />
              </div>
              <div className="bg-white px-3 py-2 dark:bg-zinc-900">
                <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{theme.name[language]}</div>
                <div className="mt-0.5 text-[10px] leading-4 text-zinc-500">{theme.description[language]}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
