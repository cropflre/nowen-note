import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageIcon, Search, SmilePlus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { isImageIcon } from "@/lib/iconValue";
import { getCachedNoteIcon, refreshNoteIcons, setNoteIcon } from "@/lib/noteIcons";
import { ALL_NOTE_ICONS, getVirtualIconRows, searchNoteIcons } from "@/lib/noteIconRegistry";

const PRESET_ICONS = [
  "📝", "📌", "📚", "💡", "✅", "⭐", "🔥", "🎯",
  "🚀", "💻", "🧠", "📅", "💼", "🏠", "❤️", "🔖",
  "📖", "✍️", "🗂️", "🔒", "🌱", "🎨", "📊", "🧩",
  "🔬", "🛠️", "🎵", "🌍", "💬", "📎", "🧪", "☕",
] as const;
const MAX_ICON_CODE_POINTS = 32;

interface NoteIconPickerModalProps {
  noteId: string | null;
  locked?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

function getCopy(language: string) {
  language = language.toLowerCase();
  return language.startsWith("zh") ? {
    title: "设置笔记图标",
    subtitle: "选择 emoji，或粘贴一个自定义短图标。",
    common: "常用",
    allIcons: "全部图标",
    searchPlaceholder: "搜索分类，如：工作、开发、旅行…",
    noIcons: "没有匹配的图标",
    custom: "自定义图标",
    importedImage: "从思源笔记导入的图片图标",
    importedImageHint: "可直接保留，也可以选择 emoji 或输入新图标进行替换。",
    placeholder: "例如：📝",
    remove: "移除图标",
    cancel: "取消",
    save: "保存",
    saving: "保存中…",
    success: "笔记图标已更新",
    failed: "更新笔记图标失败",
    locked: "笔记已锁定，无法修改图标",
    invalid: `图标最多 ${MAX_ICON_CODE_POINTS} 个字符，且不能包含换行`,
  } : {
    title: "Set note icon",
    subtitle: "Choose an emoji or paste a short custom icon.",
    common: "Common",
    allIcons: "All icons",
    searchPlaceholder: "Search categories, e.g. work, dev, travel…",
    noIcons: "No matching icons",
    custom: "Custom icon",
    importedImage: "Image icon imported from SiYuan",
    importedImageHint: "Keep it as-is, or replace it with an emoji or another short icon.",
    placeholder: "For example: 📝",
    remove: "Remove icon",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving…",
    success: "Note icon updated",
    failed: "Failed to update note icon",
    locked: "This note is locked and its icon cannot be changed",
    invalid: `The icon must be at most ${MAX_ICON_CODE_POINTS} characters without line breaks`,
  };
}

export default function NoteIconPickerModal({
  noteId,
  locked = false,
  onClose,
  onSaved,
}: NoteIconPickerModalProps) {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const copy = useMemo(() => getCopy(language), [language]);
  const inputRef = useRef<HTMLInputElement>(null);
  const iconScrollRef = useRef<HTMLDivElement>(null);
  const [iconQuery, setIconQuery] = useState("");
  const [iconScrollTop, setIconScrollTop] = useState(0);
  const [icon, setIcon] = useState("");
  const [originalIcon, setOriginalIcon] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!noteId) return;
    let cancelled = false;
    const cached = getCachedNoteIcon(noteId) || "";
    setIcon(cached);
    setOriginalIcon(cached);
    setError("");
    setLoading(true);
    void refreshNoteIcons([noteId]).finally(() => {
      if (cancelled) return;
      const fresh = getCachedNoteIcon(noteId) || "";
      setIcon(fresh);
      setOriginalIcon(fresh);
      setLoading(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  useEffect(() => {
    if (!noteId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [noteId, onClose, saving]);

  const filteredIcons = useMemo(() => searchNoteIcons(iconQuery), [iconQuery]);
  const iconWindow = getVirtualIconRows(filteredIcons.length, iconScrollTop, 224);


  if (!noteId) return null;

  const normalizedIcon = icon.trim();
  const imageIcon = isImageIcon(normalizedIcon);
  const invalid = !imageIcon && (/\r|\n|\t/.test(normalizedIcon)
    || Array.from(normalizedIcon).length > MAX_ICON_CODE_POINTS);
  const unchanged = normalizedIcon === originalIcon.trim();

  const persist = async (value: string) => {
    if (saving || locked) return;
    const normalized = value.trim();
    if (!isImageIcon(normalized)
      && (/\r|\n|\t/.test(normalized) || Array.from(normalized).length > MAX_ICON_CODE_POINTS)) {
      setError(copy.invalid);
      inputRef.current?.focus();
      return;
    }

    setSaving(true);
    setError("");
    try {
      await setNoteIcon(noteId, normalized || null);
      toast.success(copy.success);
      onSaved?.();
      onClose();
    } catch (requestError: any) {
      const message = requestError?.code === "NOTE_LOCKED"
        ? copy.locked
        : (requestError?.message || copy.failed);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={saving ? undefined : onClose} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading && !saving && !locked && !invalid && !unchanged) {
            void persist(normalizedIcon);
          }
        }}
        className="relative w-full max-w-[460px] overflow-hidden rounded-xl border border-app-border bg-app-elevated shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <SmilePlus size={16} className="shrink-0 text-accent-primary" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-tx-primary">{copy.title}</div>
              <div className="mt-0.5 truncate text-[11px] text-tx-tertiary">{copy.subtitle}</div>
            </div>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="rounded-md p-1 text-tx-tertiary hover:bg-app-hover disabled:opacity-40"
            aria-label={copy.cancel}
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          {imageIcon && (
            <div className="flex items-center gap-3 rounded-xl border border-accent-primary/20 bg-accent-primary/[0.06] p-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-bg">
                <img src={normalizedIcon} alt="" className="h-8 w-8 object-contain" draggable={false} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-tx-primary">
                  <ImageIcon size={13} className="shrink-0 text-accent-primary" />
                  {copy.importedImage}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-tx-tertiary">{copy.importedImageHint}</p>
              </div>
            </div>
          )}

          <div className="text-xs font-medium text-tx-secondary">{copy.common}</div>
          <div className="grid grid-cols-8 gap-2 sm:grid-cols-10">
            {PRESET_ICONS.map((preset) => {
              const selected = normalizedIcon === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  disabled={loading || saving || locked}
                  onClick={() => {
                    setIcon(preset);
                    setError("");
                  }}
                  className={`flex aspect-square items-center justify-center rounded-lg border text-xl transition-colors ${selected
                    ? "border-accent-primary bg-accent-primary/10"
                    : "border-app-border bg-app-bg hover:border-accent-primary/40 hover:bg-app-hover"}`}
                  aria-pressed={selected}
                >
                  {preset}
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-tx-secondary">
                {copy.allIcons} · {filteredIcons.length}/{ALL_NOTE_ICONS.length}
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-app-border bg-app-bg px-2.5 py-1.5 sm:max-w-[270px]">
                <Search size={13} className="shrink-0 text-tx-tertiary" />
                <input
                  type="search"
                  value={iconQuery}
                  disabled={loading || saving || locked}
                  onChange={(event) => {
                    setIconQuery(event.target.value);
                    setIconScrollTop(0);
                    if (iconScrollRef.current) iconScrollRef.current.scrollTop = 0;
                  }}
                  placeholder={copy.searchPlaceholder}
                  className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
                />
              </div>
            </div>
            <div
              ref={iconScrollRef}
              className="h-56 overflow-y-auto overscroll-contain rounded-lg border border-app-border bg-app-bg"
              onScroll={(event) => setIconScrollTop(event.currentTarget.scrollTop)}
              data-note-icon-browser=""
            >
              {filteredIcons.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-tx-tertiary">{copy.noIcons}</div>
              ) : (
                <div className="relative" style={{ height: iconWindow.totalRows * 44 }}>
                  {Array.from({ length: Math.max(0, iconWindow.endRow - iconWindow.startRow) }, (_, offset) => {
                    const rowIndex = iconWindow.startRow + offset;
                    const rowIcons = filteredIcons.slice(rowIndex * 8, rowIndex * 8 + 8);
                    return (
                      <div
                        key={rowIndex}
                        className="absolute left-0 right-0 grid grid-cols-8 gap-1 px-1.5"
                        style={{ top: rowIndex * 44, height: 44 }}
                      >
                        {rowIcons.map((preset) => {
                          const selected = normalizedIcon === preset;
                          return (
                            <button
                              key={preset}
                              type="button"
                              disabled={loading || saving || locked}
                              onClick={() => {
                                setIcon(preset);
                                setError("");
                              }}
                              className={`m-0.5 flex items-center justify-center rounded-md border text-xl transition-colors ${selected
                                ? "border-accent-primary bg-accent-primary/10"
                                : "border-transparent hover:border-app-border hover:bg-app-hover"}`}
                              aria-label={preset}
                              aria-pressed={selected}
                            >
                              {preset}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>


          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-tx-secondary">{copy.custom}</span>
            <input
              ref={inputRef}
              type="text"
              value={imageIcon ? "" : icon}
              disabled={loading || saving || locked}
              onChange={(event) => {
                setIcon(event.target.value);
                if (error) setError("");
              }}
              placeholder={copy.placeholder}
              className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-lg text-tx-primary outline-none transition-colors placeholder:text-sm placeholder:text-tx-tertiary focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          {invalid && <p className="text-xs text-red-500">{copy.invalid}</p>}
          {locked && <p className="text-xs text-amber-500">{copy.locked}</p>}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex items-center justify-between border-t border-app-border px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || saving || locked || !originalIcon}
            onClick={() => void persist("")}
            className="text-red-500 hover:text-red-600"
          >
            <Trash2 size={14} className="mr-1.5" />
            {copy.remove}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              {copy.cancel}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={loading || saving || locked || invalid || unchanged}
              className="bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40"
            >
              {saving ? copy.saving : copy.save}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
