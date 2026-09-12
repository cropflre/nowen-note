import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoteThemeDefinition, NoteThemeMode } from "@/lib/noteTheme";

interface NoteAppearanceStyleCardProps {
  theme: NoteThemeDefinition;
  mode: NoteThemeMode;
  language: "zh" | "en";
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  compact?: boolean;
}

function PreviewContent({
  theme,
  language,
}: {
  theme: NoteThemeDefinition;
  language: "zh" | "en";
}) {
  const tokens = theme.modes.light;
  if (theme.previewKind === "code") {
    return (
      <div className="h-full rounded-md px-2 py-1.5" style={{ background: tokens.surface }}>
        <div className="flex items-center justify-between gap-2">
          <div className="h-1.5 w-1/3 rounded" style={{ background: tokens.heading }} />
          <div className="text-[7px] font-mono" style={{ color: tokens.muted }}>API</div>
        </div>
        <div className="mt-2 rounded px-1.5 py-1 font-mono text-[7px] leading-3" style={{ background: tokens.preBackground, color: tokens.preText }}>
          const note = await api.get()
        </div>
        <div className="mt-1.5 h-1 w-2/5 rounded" style={{ background: tokens.accent }} />
      </div>
    );
  }

  if (theme.previewKind === "magazine") {
    return (
      <div className="h-full rounded-md px-2.5 py-1.5" style={{ background: tokens.surface }}>
        <div className="text-[7px] font-semibold tracking-[0.18em] uppercase" style={{ color: tokens.accent }}>
          {language === "zh" ? "NOWEN · 阅读" : "NOWEN · JOURNAL"}
        </div>
        <div className="mt-1 text-[12px] font-bold leading-tight" style={{ color: tokens.heading }}>
          {language === "zh" ? "把内容讲得更好" : "Tell the story better"}
        </div>
        <div className="mt-1.5 h-px w-full" style={{ background: tokens.border }} />
        <div className="mt-1.5 h-1 w-full rounded opacity-45" style={{ background: tokens.text }} />
        <div className="mt-1 h-1 w-4/5 rounded opacity-30" style={{ background: tokens.text }} />
      </div>
    );
  }

  return (
    <div className="h-full rounded-md px-2.5 py-1.5" style={{ background: tokens.surface }}>
      <div className="h-1.5 w-2/3 rounded" style={{ background: tokens.heading }} />
      <div className="mt-2 h-1 w-full rounded opacity-45" style={{ background: tokens.text }} />
      <div className="mt-1 h-1 w-4/5 rounded opacity-30" style={{ background: tokens.text }} />
      <div className="mt-2 h-1 w-1/3 rounded" style={{ background: tokens.accent }} />
    </div>
  );
}

export default function NoteAppearanceStyleCard({
  theme,
  mode,
  language,
  selected,
  onSelect,
  disabled = false,
  compact = false,
}: NoteAppearanceStyleCardProps) {
  const tokens = theme.modes[mode];
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group overflow-hidden rounded-xl border text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50",
        selected
          ? "border-accent-primary ring-1 ring-accent-primary/30"
          : "border-app-border hover:border-accent-primary/50",
        disabled && "cursor-not-allowed opacity-55",
      )}
    >
      <div
        className={cn(compact ? "h-16 p-2" : "h-24 p-3")}
        style={{ background: tokens.softBackground }}
      >
        <PreviewContent theme={{ ...theme, modes: { ...theme.modes, light: tokens } }} language={language} />
      </div>
      <div className={cn("bg-app-surface", compact ? "px-2.5 py-2" : "px-3 py-2.5")}>
        <div className="flex items-center gap-1.5 text-xs font-medium text-tx-primary">
          {selected && <Check size={13} className="shrink-0 text-accent-primary" />}
          <span>{theme.name[language]}</span>
        </div>
        <div className={cn("mt-0.5 text-tx-tertiary", compact ? "line-clamp-2 text-[10px] leading-4" : "text-[11px] leading-4")}>
          {theme.description[language]}
        </div>
      </div>
    </button>
  );
}
