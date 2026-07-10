import React, { useEffect, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useTranslation } from "react-i18next";

interface RenameContextNoteModalProps {
  noteId: string | null;
  initialTitle?: string;
  onClose: () => void;
}

export default function RenameContextNoteModal({
  noteId,
  initialTitle = "",
  onClose,
}: RenameContextNoteModalProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const { t, i18n } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<any | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isZh = (i18n.resolvedLanguage || i18n.language || "").toLowerCase().startsWith("zh");
  const copy = isZh
    ? {
        title: "重命名笔记",
        placeholder: "输入新的笔记标题",
        empty: "笔记标题不能为空",
        locked: "笔记已锁定，无法重命名",
        success: "笔记已重命名",
        failed: "重命名失败",
        save: "保存",
      }
    : {
        title: "Rename note",
        placeholder: "Enter a new note title",
        empty: "Note title cannot be empty",
        locked: "This note is locked and cannot be renamed",
        success: "Note renamed",
        failed: "Failed to rename note",
        save: "Save",
      };

  useEffect(() => {
    if (!noteId) {
      setNote(null);
      setTitle("");
      setError("");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError("");
    setTitle(initialTitle);

    api.getNote(noteId)
      .then((fresh) => {
        if (cancelled) return;
        setNote(fresh);
        setTitle(fresh.title || initialTitle || "");
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error("Failed to load note before rename:", err);
        toast.error(err?.message || copy.failed);
        onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [noteId, initialTitle]);

  useEffect(() => {
    if (!noteId || loading) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [noteId, loading]);

  useEffect(() => {
    if (!noteId) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [noteId, saving, onClose]);

  if (!noteId) return null;

  const normalizedTitle = title.trim();
  const unchanged = !!note && normalizedTitle === String(note.title || "").trim();
  const canSave = !!note && !!normalizedTitle && !loading && !saving && !unchanged;

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!note || loading || saving) return;

    if (!normalizedTitle) {
      setError(copy.empty);
      inputRef.current?.focus();
      return;
    }
    if (note.isLocked === 1) {
      toast.warning(copy.locked);
      return;
    }
    if (unchanged) {
      onClose();
      return;
    }

    setSaving(true);
    setError("");
    try {
      const updated = await api.updateNote(note.id, { title: normalizedTitle } as any);
      const nextTitle = updated?.title || normalizedTitle;
      const listPatch = {
        id: note.id,
        title: nextTitle,
        ...(typeof updated?.version === "number" ? { version: updated.version } : {}),
        ...(updated?.updatedAt ? { updatedAt: updated.updatedAt } : {}),
      };

      actions.updateNoteInList(listPatch);
      actions.updateNoteTab({
        id: note.id,
        title: nextTitle,
        ...(updated?.updatedAt ? { updatedAt: updated.updatedAt } : {}),
      });

      if (state.activeNote?.id === note.id) {
        actions.setActiveNote({
          ...state.activeNote,
          title: nextTitle,
          ...(typeof updated?.version === "number" ? { version: updated.version } : {}),
          ...(updated?.updatedAt ? { updatedAt: updated.updatedAt } : {}),
        });
      }

      actions.refreshNotes();
      toast.success(copy.success);
      onClose();
    } catch (err: any) {
      console.error("Failed to rename note:", err);
      const message = err?.message || copy.failed;
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={saving ? undefined : onClose}
      />
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-[420px] overflow-hidden rounded-xl border border-app-border bg-app-elevated shadow-2xl"
        style={{ animation: "contextMenuIn 0.15s ease-out" }}
      >
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Pencil size={16} className="shrink-0 text-accent-primary" />
            <span className="truncate text-sm font-medium text-tx-primary">{copy.title}</span>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="rounded-md p-1 text-tx-tertiary hover:bg-app-hover disabled:opacity-40"
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 px-4 py-4">
          <input
            ref={inputRef}
            type="text"
            value={title}
            disabled={loading || saving || note?.isLocked === 1}
            onChange={(event) => {
              setTitle(event.target.value);
              if (error) setError("");
            }}
            placeholder={copy.placeholder}
            className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary outline-none transition-colors placeholder:text-tx-tertiary focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          {note?.isLocked === 1 && <p className="text-xs text-amber-500">{copy.locked}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app-border px-4 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!canSave || note?.isLocked === 1}
            className="bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40"
          >
            {saving ? t("common.loading") : copy.save}
          </Button>
        </div>
      </form>
    </div>
  );
}
