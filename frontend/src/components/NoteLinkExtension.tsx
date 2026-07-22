import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ArrowLeft, Code, FileText, Heading, List, Loader2, Plus, Quote, Search, SquareCheckBig, Type } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { parseNoteLinkQuery, type NoteTitleMode } from "@/lib/noteLinkSyntax";

export interface NoteSearchResult { id: string; title: string; notebookId: string; updatedAt: string; }
export interface NoteLinkBlockItem {
  blockId: string;
  blockType: "heading" | "paragraph" | "listItem" | "taskItem" | "blockquote" | "codeBlock";
  parentBlockId: string | null;
  blockOrder: number;
  plainText: string;
  path: string;
}
export interface NoteLinkSelectionOptions { titleMode: NoteTitleMode; alias?: string; }

interface NoteLinkMenuProps {
  editor?: Editor;
  position: { top: number; left: number };
  query: string;
  notebookId: string;
  onSelect: (note: NoteSearchResult, block?: NoteLinkBlockItem, options?: NoteLinkSelectionOptions) => void;
  onClose: () => void;
}

const blockIcons: Record<string, React.ComponentType<any>> = {
  heading: Heading, paragraph: Type, listItem: List, taskItem: SquareCheckBig, blockquote: Quote, codeBlock: Code,
};

export function NoteLinkMenu({ position, query, notebookId, onSelect, onClose }: NoteLinkMenuProps) {
  const parsed = useMemo(() => parseNoteLinkQuery(query), [query]);
  const [results, setResults] = useState<NoteSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"search" | "blocks">("search");
  const [selectedNote, setSelectedNote] = useState<NoteSearchResult | null>(null);
  const [blocks, setBlocks] = useState<NoteLinkBlockItem[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [alias, setAlias] = useState(parsed.alias);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setAlias(parsed.alias), [parsed.alias]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api.searchNotes(parsed.searchText, 12).then(
        (data) => alive && setResults(data || []),
        () => alive && setResults([]),
      ).finally(() => alive && setLoading(false));
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [parsed.searchText]);

  const exact = results.some((item) => item.title.trim().toLowerCase() === parsed.searchText.toLowerCase());
  const canCreate = !!parsed.searchText && !exact;

  const loadBlocks = useCallback(async (note: NoteSearchResult) => {
    setSelectedNote(note); setView("blocks"); setBlocksLoading(true); setBlocks([]); setSelectedIndex(0);
    try { const data = await api.getNoteBlocks(note.id, 1000); setBlocks(data.blocks || []); }
    finally { setBlocksLoading(false); }
  }, []);

  const selectionOptions = (): NoteLinkSelectionOptions => ({
    titleMode: alias.trim() ? "alias" : "auto",
    ...(alias.trim() ? { alias: alias.trim() } : {}),
  });

  const createTarget = useCallback(async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      const created = await api.createNote({
        notebookId,
        title: parsed.searchText,
        contentFormat: "tiptap-json",
        content: JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
        contentText: "",
      });
      onSelect({ id: created.id, title: created.title, notebookId: created.notebookId, updatedAt: created.updatedAt }, undefined, selectionOptions());
    } finally { setCreating(false); }
  }, [canCreate, creating, notebookId, onSelect, parsed.searchText, alias]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); view === "blocks" ? setView("search") : onClose(); return; }
      if (event.key === "Backspace" && view === "blocks" && !alias) { event.preventDefault(); setView("search"); return; }
      const count = view === "search" ? results.length + (canCreate ? 1 : 0) : blocks.length + 1;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex((value) => (value + delta + Math.max(1, count)) % Math.max(1, count));
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (view === "search") {
          if (results[selectedIndex]) loadBlocks(results[selectedIndex]);
          else if (canCreate && selectedIndex === results.length) void createTarget();
        } else if (selectedNote) {
          if (selectedIndex === 0) onSelect(selectedNote, undefined, selectionOptions());
          else if (blocks[selectedIndex - 1]) onSelect(selectedNote, blocks[selectedIndex - 1], selectionOptions());
        }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [alias, blocks, canCreate, createTarget, loadBlocks, onClose, onSelect, results, selectedIndex, selectedNote, view]);

  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [onClose]);

  return (
    <div ref={rootRef} className="fixed z-[110] w-[min(360px,calc(100vw-16px))] overflow-hidden rounded-xl border border-app-border bg-app-elevated shadow-2xl" style={{ top: Math.min(position.top, window.innerHeight - 420), left: Math.max(8, Math.min(position.left, window.innerWidth - 368)) }}>
      {view === "search" ? <>
        <div className="flex items-center gap-2 border-b border-app-border px-3 py-2"><Search size={14} className="text-tx-tertiary" /><span className="min-w-0 flex-1 truncate text-xs text-tx-primary">{parsed.searchText || "搜索笔记"}</span>{parsed.alias && <span className="rounded bg-app-hover px-1.5 py-0.5 text-[10px] text-tx-tertiary">别名：{parsed.alias}</span>}{loading && <Loader2 size={14} className="animate-spin" />}</div>
        <div className="max-h-72 overflow-y-auto p-1">
          {results.map((note, index) => <button key={note.id} type="button" onClick={() => loadBlocks(note)} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs", index === selectedIndex ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}><FileText size={14} /><span className="flex-1 truncate">{note.title || "无标题笔记"}</span></button>)}
          {canCreate && <button type="button" onClick={() => void createTarget()} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs", selectedIndex === results.length ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}><Plus size={14} /><span className="flex-1 truncate">创建“{parsed.searchText}”</span>{creating && <Loader2 size={13} className="animate-spin" />}</button>}
          {!loading && results.length === 0 && !canCreate && <div className="px-3 py-6 text-center text-xs text-tx-tertiary">输入标题搜索笔记</div>}
        </div>
      </> : <>
        <div className="flex items-center gap-2 border-b border-app-border px-2 py-2"><button type="button" onClick={() => setView("search")} className="rounded p-1 hover:bg-app-hover"><ArrowLeft size={14} /></button><FileText size={14} className="text-tx-tertiary" /><span className="min-w-0 flex-1 truncate text-xs font-medium">{selectedNote?.title}</span>{blocksLoading && <Loader2 size={14} className="animate-spin" />}</div>
        <div className="border-b border-app-border px-3 py-2"><label className="text-[10px] text-tx-tertiary">显示文字（留空则随标题自动更新）</label><input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="固定别名，可选" className="mt-1 w-full rounded-md border border-app-border bg-app-surface px-2 py-1.5 text-xs outline-none focus:border-accent-primary" /></div>
        <div className="max-h-72 overflow-y-auto p-1">
          <button type="button" onClick={() => selectedNote && onSelect(selectedNote, undefined, selectionOptions())} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs", selectedIndex === 0 ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}><FileText size={14} /><span>引用整篇笔记</span></button>
          {blocks.map((block, index) => { const Icon = blockIcons[block.blockType] || Type; return <button key={block.blockId} type="button" onClick={() => selectedNote && onSelect(selectedNote, block, selectionOptions())} className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left", selectedIndex === index + 1 ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}><Icon size={13} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate text-xs">{block.plainText || "空块"}</span><span className="mt-0.5 block text-[10px] text-tx-tertiary">{block.blockType} · {block.blockId}</span></span></button>; })}
        </div>
      </>}
    </div>
  );
}
