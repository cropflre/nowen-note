import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveAs } from "file-saver";
import type { NoteEditorHandle, NoteEditorProps, NoteEditorUpdatePayload } from "./editors/types";
import { saveDraft } from "@/lib/draftStorage";
import { isAndroidNative, saveBlobToSystemFile } from "@/lib/nativeImageSave";
import { toast } from "@/lib/toast";

/** TXT never passes through Markdown, HTML or JSON parsing. */
const PlainTextEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function PlainTextEditor(
  { note, onUpdate, onLocalUpdate, onHeadingsChange, editable = true, isGuest = false }, ref,
) {
  const { t } = useTranslation();
  const [content, setContent] = useState(note.content);
  const [title, setTitle] = useState(note.title);
  const snapshot = useRef({ content: note.content, contentText: note.content, title: note.title });
  const latest = useRef({ onUpdate, editable });
  latest.current = { onUpdate, editable };
  const generation = useRef(0);
  const dirty = useRef(false);
  const pending = useRef<NoteEditorUpdatePayload | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  function discardPending() {
    clearTimeout(timer.current);
    pending.current = null;
  }
  const flushSave = useCallback(() => {
    clearTimeout(timer.current);
    const payload = pending.current;
    pending.current = null;
    if (payload && latest.current.editable) latest.current.onUpdate(payload);
  }, []);

  useImperativeHandle(ref, () => ({
    flushSave, discardPending, getSnapshot: () => snapshot.current, isReady: () => true,
    acknowledgeSave: (ack) => {
      if (ack.noteId === note.id && ack.saveGeneration === generation.current && !ack.preserveLocalEditor) dirty.current = false;
    },
  }));

  useEffect(() => {
    onHeadingsChange?.([]);
  }, [note.id, onHeadingsChange]);

  useEffect(() => () => flushSave(), [note.id, flushSave]);

  useEffect(() => {
    // Split/share hosts return saved props rather than an imperative ACK.
    if (!onLocalUpdate && note.content === snapshot.current.content && note.title === snapshot.current.title) dirty.current = false;
    if (dirty.current && (note.content !== snapshot.current.content || note.title !== snapshot.current.title)) return;
    snapshot.current = { content: note.content, contentText: note.content, title: note.title };
    setContent(note.content);
    setTitle(note.title);
  }, [note.content, note.title, onLocalUpdate]);

  function update(nextContent: string, nextTitle: string) {
    if (!editable) return;
    generation.current += 1;
    dirty.current = true;
    snapshot.current = { content: nextContent, contentText: nextContent, title: nextTitle };
    setContent(nextContent);
    setTitle(nextTitle);
    const payload = { ...snapshot.current, _noteId: note.id, _saveGeneration: generation.current };
    pending.current = payload;
    // Protect typing before debounce fires, including close/refresh and failed saves.
    if (!isGuest) saveDraft({ noteId: note.id, editorMode: "tiptap", contentFormat: "plaintext", ...snapshot.current, baseVersion: note.version, savedAt: Date.now() });
    onLocalUpdate?.(payload);
    clearTimeout(timer.current);
    timer.current = setTimeout(flushSave, 500);
  }

  async function exportTxt() {
    const blob = new Blob([snapshot.current.content], { type: "text/plain;charset=utf-8" });
    // eslint-disable-next-line no-control-regex -- Filenames must exclude control characters.
    const fileName = `${(snapshot.current.title || "Untitled").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}.txt`;
    try {
      if (isAndroidNative()) await saveBlobToSystemFile({ blob, fileName, mimeType: "text/plain" });
      else saveAs(blob, fileName, { autoBom: false });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("export.exportFailed"));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-plaintext-editor="">
      <div className="flex shrink-0 items-center gap-2 border-b border-app-border px-4 py-2">
        <input className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-tx-primary outline-none"
          value={title} readOnly={!editable} aria-label={t("tiptap.titlePlaceholder")}
          placeholder={t("tiptap.titlePlaceholder")} onChange={(event) => update(content, event.target.value)} onBlur={flushSave} />
        <button type="button" className="shrink-0 rounded px-2 py-1 text-xs text-tx-secondary hover:bg-app-hover"
          onClick={() => { void exportTxt(); }}>{t("note.format.exportTxt")}</button>
      </div>
      <textarea className="min-h-0 w-full flex-1 resize-none bg-transparent p-4 text-tx-primary outline-none"
        style={{ fontFamily: "var(--note-theme-font-family, var(--editor-font-family, inherit))", fontSize: "var(--note-theme-font-size, var(--editor-font-size, 16px))", lineHeight: 1.7, tabSize: 4 }}
        value={content} readOnly={!editable} aria-label={t("note.format.plainText")}
        spellCheck={false} onChange={(event) => update(event.target.value, title)} onBlur={flushSave} />
    </div>
  );
});

export default PlainTextEditor;
