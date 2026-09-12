import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Palette, RotateCcw, X } from "lucide-react";
import { useApp } from "@/store/AppContext";
import { canWriteNote } from "@/lib/notePermissions";
import { toast } from "@/lib/toast";
import {
  DEFAULT_NOTE_THEME_ID,
  NOTE_THEMES,
  getNoteAppearance,
  noteThemeCssVariables,
  resolveNoteTheme,
  setNoteAppearance,
} from "@/lib/noteAppearance";

interface AnchorPosition {
  top: number;
  right: number;
}

function editorAnchor(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".nowen-md-editor")
    || document.querySelector<HTMLElement>(".ProseMirror[contenteditable]")
    || document.querySelector<HTMLElement>(".ProseMirror");
}

function themeSurfaceFor(target: HTMLElement): HTMLElement {
  // Keep application chrome outside the note theme. The immediate editor content wrapper is the
  // narrowest shared boundary for Tiptap and Markdown and is safe to decorate/remove repeatedly.
  return target.parentElement || target;
}

function positionFor(target: HTMLElement): AnchorPosition {
  const rect = target.getBoundingClientRect();
  return {
    top: Math.max(72, Math.min(window.innerHeight - 56, rect.top + 12)),
    right: Math.max(12, window.innerWidth - rect.right + 12),
  };
}

function clearThemeSurface(surface: HTMLElement): void {
  surface.classList.remove("nowen-note-theme-surface");
  surface.removeAttribute("data-note-theme");
  for (const name of Array.from(surface.style)) {
    if (name.startsWith("--note-theme-")) surface.style.removeProperty(name);
  }
}

function applyThemeSurface(surface: HTMLElement, themeId: string): void {
  const theme = resolveNoteTheme(themeId);
  surface.classList.add("nowen-note-theme-surface");
  surface.dataset.noteTheme = theme.id;
  for (const [name, value] of Object.entries(noteThemeCssVariables(theme))) {
    surface.style.setProperty(name, value);
  }
}

/**
 * Current-note appearance entry.
 *
 * Kept as a bridge so both editor engines share exactly one capability without duplicating theme
 * state inside the very large Tiptap/Markdown editor components. The persisted source of truth is
 * note metadata on the backend; DOM decoration is a renderer adapter only.
 */
export default function NoteAppearanceBridge() {
  const { state } = useApp();
  const activeNote = state.activeNote;
  const noteId = activeNote?.id || "";
  const editable = canWriteNote(activeNote);
  const [themeId, setThemeId] = useState(DEFAULT_NOTE_THEME_ID);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [anchor, setAnchor] = useState<AnchorPosition | null>(null);
  const themedSurfaceRef = useRef<HTMLElement | null>(null);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    setOpen(false);
    setThemeId(DEFAULT_NOTE_THEME_ID);
    if (!noteId) return;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    void getNoteAppearance(noteId)
      .then((result) => {
        if (requestGenerationRef.current !== generation) return;
        setThemeId(result.themeId || DEFAULT_NOTE_THEME_ID);
      })
      .catch((error) => {
        if (requestGenerationRef.current !== generation) return;
        console.warn("[note-appearance] load failed", error);
        setThemeId(DEFAULT_NOTE_THEME_ID);
      })
      .finally(() => {
        if (requestGenerationRef.current === generation) setLoading(false);
      });
  }, [noteId]);

  useEffect(() => {
    if (!noteId) {
      if (themedSurfaceRef.current) clearThemeSurface(themedSurfaceRef.current);
      themedSurfaceRef.current = null;
      setAnchor(null);
      return;
    }

    let frame = 0;
    const reconcile = () => {
      frame = 0;
      const target = editorAnchor();
      if (!target) {
        setAnchor(null);
        return;
      }
      const surface = themeSurfaceFor(target);
      if (themedSurfaceRef.current && themedSurfaceRef.current !== surface) {
        clearThemeSurface(themedSurfaceRef.current);
      }
      themedSurfaceRef.current = surface;
      applyThemeSurface(surface, themeId);
      setAnchor(positionFor(target));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(reconcile);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (themedSurfaceRef.current) clearThemeSurface(themedSurfaceRef.current);
      themedSurfaceRef.current = null;
    };
  }, [noteId, themeId]);

  const selected = useMemo(() => resolveNoteTheme(themeId), [themeId]);

  const chooseTheme = useCallback(async (nextThemeId: string) => {
    if (!noteId || saving || nextThemeId === themeId) {
      setOpen(false);
      return;
    }
    const previous = themeId;
    setThemeId(nextThemeId);
    setSaving(true);
    try {
      const result = await setNoteAppearance(noteId, nextThemeId);
      setThemeId(result.themeId);
      setOpen(false);
      toast.success(`已应用「${resolveNoteTheme(result.themeId).name}」`);
    } catch (error) {
      setThemeId(previous);
      toast.error(error instanceof Error ? error.message : "主题保存失败");
    } finally {
      setSaving(false);
    }
  }, [noteId, saving, themeId]);

  if (!noteId || !anchor) return null;

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
        title={`笔记外观 · ${selected.name}`}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-app-border bg-app-surface/95 px-2.5 text-xs text-tx-secondary shadow-md backdrop-blur transition hover:bg-app-hover hover:text-tx-primary disabled:opacity-50"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Palette size={14} />}
        <span className="hidden lg:inline">{selected.name}</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(340px,calc(100vw-24px))] overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-tx-primary">这篇笔记的外观</div>
              <div className="mt-0.5 text-[11px] text-tx-tertiary">只改变当前笔记，不改变 Nowen 界面皮肤</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-tx-tertiary hover:bg-app-hover">
              <X size={15} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 p-3">
            {NOTE_THEMES.map((theme) => {
              const active = theme.id === themeId;
              return (
                <button
                  key={theme.id}
                  type="button"
                  disabled={!editable || saving}
                  onClick={() => void chooseTheme(theme.id)}
                  className={`group relative overflow-hidden rounded-xl border p-2 text-left transition ${active ? "border-accent-primary ring-1 ring-accent-primary/30" : "border-app-border hover:border-accent-primary/50"} disabled:cursor-not-allowed disabled:opacity-55`}
                >
                  <div className="h-16 rounded-lg p-2" style={{ background: theme.preview.background }}>
                    <div className="h-full rounded-md px-2 py-1.5" style={{ background: theme.preview.surface }}>
                      <div className="h-1.5 w-2/3 rounded" style={{ background: theme.preview.text }} />
                      <div className="mt-2 h-1 w-full rounded opacity-45" style={{ background: theme.preview.text }} />
                      <div className="mt-1 h-1 w-4/5 rounded opacity-30" style={{ background: theme.preview.text }} />
                      <div className="mt-2 h-1 w-1/3 rounded" style={{ background: theme.preview.accent }} />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-tx-primary">
                    {active && <Check size={13} className="text-accent-primary" />}
                    {theme.name}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-tx-tertiary">{theme.description}</div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-app-border px-3 py-2 text-[11px] text-tx-tertiary">
            <span>{editable ? "主题作为笔记元数据保存" : "只读笔记不可修改主题"}</span>
            {themeId !== DEFAULT_NOTE_THEME_ID && editable && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void chooseTheme(DEFAULT_NOTE_THEME_ID)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-tx-secondary hover:bg-app-hover"
              >
                <RotateCcw size={12} /> 恢复默认
              </button>
            )}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
