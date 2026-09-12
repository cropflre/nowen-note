import { useEffect, useMemo, useState } from "react";
import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getNoteAppearance, setNoteAppearance } from "@/lib/noteAppearance";
import {
  listAvailableNoteThemes,
  subscribePluginNoteThemes,
} from "@/lib/pluginNoteThemeRegistry";

export default function NoteThemeMenuSelect({ noteId, disabled = false }: { noteId: string; disabled?: boolean }) {
  const { i18n } = useTranslation();
  const [themeId, setThemeId] = useState<string | null>(null);
  const [registryRevision, setRegistryRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const isZh = i18n.language.startsWith("zh");
  const label = isZh ? "笔记主题" : "Note theme";
  const themes = useMemo(
    () => listAvailableNoteThemes(i18n.language),
    [i18n.language, registryRevision],
  );

  useEffect(() => subscribePluginNoteThemes(() => setRegistryRevision((value) => value + 1)), []);
  useEffect(() => {
    let active = true;
    void getNoteAppearance(noteId).then((appearance) => {
      if (active) setThemeId(appearance.themeId);
    }).catch(() => {
      if (active) setThemeId(null);
    });
    return () => { active = false; };
  }, [noteId]);

  const selectedAvailable = themeId === null || themes.some((theme) => theme.id === themeId);
  return (
    <label className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary">
      <Palette size={15} className="shrink-0 text-accent-primary" />
      <span className="shrink-0">{label}</span>
      <select
        aria-label={label}
        className="min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-2 py-1 text-xs text-tx-primary"
        value={themeId ?? ""}
        disabled={disabled || saving}
        onChange={async (event) => {
          const next = event.target.value || null;
          setSaving(true);
          try {
            const saved = await setNoteAppearance(noteId, next);
            setThemeId(saved.themeId);
          } catch (error) {
            window.alert(error instanceof Error ? error.message : String(error));
          } finally {
            setSaving(false);
          }
        }}
      >
        <option value="">{isZh ? "跟随默认" : "Follow default"}</option>
        {!selectedAvailable && themeId && (
          <option value={themeId}>{isZh ? "插件不可用（已保留选择）" : "Plugin unavailable (selection kept)"}</option>
        )}
        {themes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.source === "plugin" ? `${theme.name} · ${isZh ? "插件" : "Plugin"}` : theme.name}
          </option>
        ))}
      </select>
    </label>
  );
}
