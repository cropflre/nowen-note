import { useTranslation } from "react-i18next";
import NoteAppearanceStyleCard from "@/components/NoteAppearanceStyleCard";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { NOTE_THEMES, resolveDocumentThemeMode } from "@/lib/noteTheme";

/**
 * Account-level note appearance style.
 *
 * This is not a second theme system: it selects the default style inherited by notes that do not
 * have a per-note appearance override. The cards consume the same registry as the editor bridge.
 */
export default function NoteThemePicker() {
  const { i18n } = useTranslation();
  const { prefs, setPref } = useUserPreferences();
  const language = i18n.language.startsWith("zh") ? "zh" : "en";
  const mode = resolveDocumentThemeMode();
  const copy = language === "zh"
    ? {
        title: "笔记外观风格",
        description: "为笔记选择阅读与写作时的视觉风格，也可在单篇笔记中独立调整。",
      }
    : {
        title: "Note appearance style",
        description: "Choose a reading and writing style for notes. Individual notes can still override it.",
      };

  return (
    <section
      data-note-appearance-style-settings
      className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/30"
    >
      <div>
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{copy.title}</span>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {copy.description}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {NOTE_THEMES.map((theme) => (
          <NoteAppearanceStyleCard
            key={theme.id}
            theme={theme}
            mode={mode}
            language={language}
            selected={prefs.noteTheme === theme.id}
            onSelect={() => setPref("noteTheme", theme.id)}
          />
        ))}
      </div>
    </section>
  );
}
