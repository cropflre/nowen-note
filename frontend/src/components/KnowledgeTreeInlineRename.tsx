import React, { useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { api } from "@/lib/api";
import { useApp, useAppActions } from "@/store/AppContext";

export interface KnowledgeTreeInlineRenameProps {
  node: KnowledgeTreeNode;
  onSaved: (title: string) => void;
  onCancel: () => void;
}

/** 模板已经创建成功，取消命名只退出编辑，不删除该文档。 */
export default function KnowledgeTreeInlineRename({ node, onSaved, onCancel }: KnowledgeTreeInlineRenameProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const activeNoteRef = useRef(state.activeNote);
  activeNoteRef.current = state.activeNote;
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [title, setTitle] = useState(node.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.scrollIntoView({ block: "nearest" });
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [node.id]);

  const save = async () => {
    if (savingRef.current) return;
    const normalized = title.trim();
    if (!normalized) {
      setError("名称不能为空");
      inputRef.current?.focus();
      return;
    }
    if (normalized === node.title) {
      onSaved(normalized);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const snapshot = await api.getNote(node.resourceId);
      const confirmed = await api.updateNote(node.resourceId, { title: normalized, version: snapshot.version });
      const activeNote = activeNoteRef.current;
      const newerActive = activeNote?.id === node.resourceId && activeNote.version > confirmed.version ? activeNote : null;
      const metadata = {
        id: node.resourceId,
        title: newerActive?.title ?? confirmed.title,
        version: newerActive?.version ?? confirmed.version,
        updatedAt: newerActive?.updatedAt ?? confirmed.updatedAt,
      };
      if (activeNote?.id === node.resourceId && !newerActive) actions.setActiveNote({ ...activeNote, ...metadata });
      actions.updateNoteInList(metadata);
      actions.updateNoteTab(metadata);
      actions.refreshNotes();
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", {
        detail: { reason: "node-renamed-inline", resourceId: node.resourceId, title: metadata.title },
      }));
      onSaved(metadata.title);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : "重命名失败，请重试");
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="min-w-0 flex-1 py-0.5" data-knowledge-tree-inline-rename="" onClick={(event) => event.stopPropagation()}>
      <div className="flex min-w-0 items-center gap-1">
        <input
          ref={inputRef}
          value={title}
          disabled={saving}
          onChange={(event) => { setTitle(event.target.value); setError(null); }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" && !saving) { event.preventDefault(); onCancel(); }
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              void save();
            }
          }}
          className="min-w-0 flex-1 rounded border border-accent-primary/60 bg-app-bg px-1.5 py-1 text-xs text-tx-primary outline-none focus:border-accent-primary"
          aria-label="文档名称"
          aria-invalid={Boolean(error)}
        />
        <button type="button" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => void save()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-accent-primary hover:bg-accent-primary/10 disabled:opacity-50"
          title="确认重命名" aria-label="确认重命名">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
        </button>
        <button type="button" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={onCancel}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover disabled:opacity-50"
          title="取消重命名，保留文档" aria-label="取消重命名">
          <X size={13} />
        </button>
      </div>
      {error && <p className="pt-0.5 text-[10px] text-red-500" role="alert">{error}</p>}
    </div>
  );
}
