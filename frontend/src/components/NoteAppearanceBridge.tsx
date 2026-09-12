import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Palette, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/AppContext";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { canWriteNote } from "@/lib/notePermissions";
import { toast } from "@/lib/toast";
import { getNoteAppearance, setNoteAppearance } from "@/lib/noteAppearance";
import {
  NOTE_THEMES,
  applyNoteTheme,
  getNoteTheme,
  isNoteThemeId,
  resolveDocumentThemeMode,
  type NoteThemeId,
} from "@/lib/noteTheme";

interface AnchorPosition {
  top: number;
  right: number;
}

const LOCAL_THEME_PROPERTIES = [
  "--note-theme-surface", "--pm-text", "--pm-heading", "--note-theme-muted",
  "--note-theme-border", "--note-theme-accent", "--note-theme-accent-hover",
  "--pm-code-bg", "--pm-code-text", "--pm-pre-bg", "--pm-pre-text",
  "--pm-blockquote-border", "--pm-blockquote-text", "--note-theme-soft",
  "--note-theme-table-stripe", "--note-theme-mark", "--pm-selection",
  "--note-theme-content-width", "--pm-p-line-height",
] as const;

function noteSurface(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".note-theme-surface");
}

function positionFor(target: HTMLElement): AnchorPosition {
  const rect = target.getBoundingClientRect();
  return {
    top: Math.max(72, Math.min(window.innerHeight - 56, rect.top + 12)),
    right: Math.max(12, window.innerWidth - rect.right + 12),
  };
}

function clearLocalTheme(surface: HTMLElement): void {
  surface.removeAttribute("data-note-theme");
  for (const property of LOCAL_THEME_PROPERTIES) surface.style.removeProperty(property);
}

/**
 * Per-note appearance controller.
 *
 * `prefs.noteTheme` is the account-level default only. A note stores either NULL (inherit that
 * default) or one explicit theme id. The editor document never carries appearance data.
 */
export default function NoteAppearanceBridge() {
  const { state } = useApp();
  const { prefs } = useUserPreferences();
  const { i18n } = useTranslation();
  const activeNote = state.activeNote;
  const noteId = activeNote?.id || "";
  const editable = canWriteNote(activeNote);
  const language = i18n.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  const [storedThemeId, setStoredThemeId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [anchor, setAnchor] = useState<AnchorPosition | null>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const requestGenerationRef = useRef(0);

  const explicitThemeId: NoteThemeId | null = isNoteThemeId(storedThemeId) ? storedThemeId : null;
  const missingThemeId = storedThemeId && !isNoteThemeId(storedThemeId) ? storedThemeId : null;
  const effectiveThemeId = explicitThemeId || prefs.noteTheme;
  const selectedTheme = useMemo(() => getNoteTheme(effectiveThemeId), [effectiveThemeId]);
  const accountDefaultTheme = useMemo(() => getNoteTheme(prefs.noteTheme), [prefs.noteTheme]);

  useEffect(() => {
    setOpen(false);
    setStoredThemeId(null);
    if (!noteId) return;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    void getNoteAppearance(noteId)
      .then((result) => {
        if (requestGenerationRef.current !== generation) return;
        setStoredThemeId(result.themeId);
      })
      .catch((error) => {
        if (requestGenerationRef.current !== generation) return;
        console.warn("[note-appearance] load failed", error);
        setStoredThemeId(null);
      })
      .finally(() => {
        if (requestGenerationRef.current === generation) setLoading(false);
      });
  }, [noteId]);

  useEffect(() => {
    if (!noteId) {
      if (surfaceRef.current) clearLocalTheme(surfaceRef.current);
      surfaceRef.current = null;
      setAnchor(null);
      return;
    }

    let frame = 0;
    const reconcile = () => {
      frame = 0;
      const surface = noteSurface();
      if (!surface) {
        setAnchor(null);
        return;
      }
      if (surfaceRef.current && surfaceRef.current !== surface) clearLocalTheme(surfaceRef.current);
      surfaceRef.current = surface;

      if (explicitThemeId) {
        applyNoteTheme(explicitThemeId, surface);
      } else {
        // No per-note override: the account default already lives on documentElement and cascades.
        clearLocalTheme(surface);
      }
      setAnchor(positionFor(surface));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(reconcile);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    const themeObserver = new MutationObserver(schedule);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (surfaceRef.current) clearLocalTheme(surfaceRef.current);
      surfaceRef.current = null;
    };
  }, [noteId, explicitThemeId]);

  const chooseTheme = useCallback(async (nextThemeId: NoteThemeId | null) => {
    if (!noteId || saving || nextThemeId === explicitThemeId && storedThemeId !== null) {
      setOpen(false);
      return;
    }
    if (nextThemeId === null && storedThemeId === null) {
      setOpen(false);
      return;
    }
    const previous = storedThemeId;
    setStoredThemeId(nextThemeId);
    setSaving(true);
    try {
      const result = await setNoteAppearance(noteId, nextThemeId);
      setStoredThemeId(result.themeId);
      setOpen(false);
      const effective = nextThemeId || prefs.noteTheme;
      const name = getNoteTheme(effective).name[language];
      toast.success(nextThemeId ? `已应用「${name}」` : `已跟随默认主题「${name}」`);
    } catch (error) {
      setStoredThemeId(previous);
      toast.error(error instanceof Error ? error.message : "主题保存失败");
    } finally {
      setSaving(false);
    }
  }, [explicitThemeId, language, noteId, prefs.noteTheme, saving, storedThemeId]);

  if (!noteId || !anchor) return null;

  const mode = resolveDocumentThemeMode();

  return createPortal(
    <div
      data-note-appearance-control
      className="fixed z-[72]"
      style={{ top: anchor.top, right: anchor.right }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={loading}
        aria-label="笔记外观"
        title={`笔记外观 · ${selectedTheme.name[language]}`}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-app-border bg-app-surface/95 px-2.5 text-xs text-tx-secondary shadow-md backdrop-blur transition hover:bg-app-hover hover:text-tx-primary disabled:opacity-50"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Palette size={14} />}
        <span className="hidden lg:inline">{selectedTheme.name[language]}</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-tx-primary">这篇笔记的外观</div>
              <div className="mt-0.5 text-[11px] text-tx-tertiary">单篇覆盖优先；未设置时跟随账号默认主题</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-tx-tertiary hover:bg-app-hover">
              <X size={15} />
            </button>
          </div>

          {missingThemeId && (
            <div className="mx-3 mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              主题「{missingThemeId}」当前未安装，已回退到账号默认主题。
            </div>
          )}

          <div className="p-3 pb-1">
            <button
              type="button"
              disabled={!editable || saving}
              onClick={() => void chooseTheme(null)}
              className={`flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition ${storedThemeId === null ? "border-accent-primary bg-accent-primary/5 ring-1 ring-accent-primary/20" : "border-app-border hover:border-accent-primary/50"} disabled:cursor-not-allowed disabled:opacity-55`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app-hover text-accent-primary">
                {storedThemeId === null ? <Check size={16} /> : <RotateCcw size={15} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-tx-primary">跟随默认</div>
                <div className="mt-0.5 text-[10px] text-tx-tertiary">当前默认：{accountDefaultTheme.name[language]}</div>
              </div>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 p-3 pt-2">
            {NOTE_THEMES.map((theme) => {
              const active = explicitThemeId === theme.id;
              const tokens = theme.modes[mode];
              return (
                <button
                  key={theme.id}
                  type="button"
                  disabled={!editable || saving}
                  onClick={() => void chooseTheme(theme.id)}
                  className={`group relative overflow-hidden rounded-xl border p-2 text-left transition ${active ? "border-accent-primary ring-1 ring-accent-primary/30" : "border-app-border hover:border-accent-primary/50"} disabled:cursor-not-allowed disabled:opacity-55`}
                >
                  <div className="h-16 rounded-lg p-2" style={{ background: tokens.softBackground }}>
                    <div className="h-full rounded-md px-2 py-1.5" style={{ background: tokens.surface }}>
                      <div className="h-1.5 w-2/3 rounded" style={{ background: tokens.heading }} />
                      <div className="mt-2 h-1 w-full rounded opacity-45" style={{ background: tokens.text }} />
                      <div className="mt-1 h-1 w-4/5 rounded opacity-30" style={{ background: tokens.text }} />
                      <div className="mt-2 h-1 w-1/3 rounded" style={{ background: tokens.accent }} />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-tx-primary">
                    {active && <Check size={13} className="text-accent-primary" />}
                    {theme.name[language]}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-tx-tertiary">{theme.description[language]}</div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-app-border px-3 py-2 text-[11px] text-tx-tertiary">
            {editable ? "外观作为笔记元数据保存，不修改正文和正文版本" : "只读笔记不可修改主题"}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
