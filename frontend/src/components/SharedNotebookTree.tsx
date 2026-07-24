import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Plus } from "lucide-react";
import type { Notebook, NoteListItem, WorkspacePermission } from "@/types";
import { cn } from "@/lib/utils";

export interface SharedNotebook extends Notebook {
  sharedRootId?: string;
  sharedDepth?: number;
  permission?: WorkspacePermission;
}

export interface SharedNotebookNode extends SharedNotebook {
  children: SharedNotebookNode[];
}

function compareSharedNotebooks(a: SharedNotebook, b: SharedNotebook): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    || String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

export function buildSharedNotebookTree(notebooks: SharedNotebook[]): SharedNotebookNode[] {
  const nodes = new Map<string, SharedNotebookNode>();
  for (const notebook of notebooks) {
    if (!notebook?.id || nodes.has(notebook.id)) continue;
    nodes.set(notebook.id, { ...notebook, children: [] });
  }

  const roots: SharedNotebookNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (!parent || parent.id === node.id) roots.push(node);
    else parent.children.push(node);
  }

  const sortTree = (items: SharedNotebookNode[]) => {
    items.sort(compareSharedNotebooks);
    for (const item of items) sortTree(item.children);
  };
  sortTree(roots);
  return roots;
}

export function canEditSharedNotebook(notebook: SharedNotebook): boolean {
  return notebook.permission === "write"
    || notebook.permission === "manage"
    || notebook.myRole === "editor"
    || notebook.myRole === "owner";
}

interface Props {
  notebooks: SharedNotebook[];
  selectedNotebookId: string | null;
  activeNoteId: string | null;
  showNotes: boolean;
  notesByNotebookId: Map<string, NoteListItem[]>;
  loadingNotebookIds: Set<string>;
  refreshToken: number;
  onSelectNotebook: (notebookId: string) => void;
  onSelectNote: (noteId: string) => void;
  onLoadNotes: (notebookId: string, force?: boolean) => void | Promise<void>;
  onCreateNote: (notebookId: string) => void | Promise<void>;
}

interface ItemProps extends Omit<Props, "notebooks" | "refreshToken" | "onLoadNotes"> {
  notebook: SharedNotebookNode;
  depth: number;
  expandedIds: Set<string>;
  onToggle: (notebook: SharedNotebookNode) => void;
}

const SharedNotebookTreeItem = memo(function SharedNotebookTreeItem({
  notebook,
  depth,
  selectedNotebookId,
  activeNoteId,
  showNotes,
  notesByNotebookId,
  loadingNotebookIds,
  onSelectNotebook,
  onSelectNote,
  onCreateNote,
  expandedIds,
  onToggle,
}: ItemProps) {
  const expanded = expandedIds.has(notebook.id);
  const directNotes = notesByNotebookId.get(notebook.id);
  const loading = loadingNotebookIds.has(notebook.id);
  const hasChildren = notebook.children.length > 0;
  const mayHaveNotes = showNotes && ((notebook.noteCount ?? 0) > 0 || directNotes !== undefined);
  const showDisclosure = hasChildren || mayHaveNotes;
  const isRoot = !notebook.parentId
    || notebook.parentId === notebook.id
    || notebook.sharedRootId === notebook.id;
  const canEdit = canEditSharedNotebook(notebook);

  return (
    <div data-shared-notebook-id={notebook.id}>
      <div
        className={cn(
          "group/shared flex min-w-0 items-center rounded-md text-sm transition-colors",
          selectedNotebookId === notebook.id
            ? "bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
            : "text-tx-secondary hover:bg-app-hover",
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <button
          type="button"
          aria-label={expanded ? "折叠共享笔记本" : "展开共享笔记本"}
          onClick={() => showDisclosure && onToggle(notebook)}
          className={cn(
            "flex h-7 w-5 shrink-0 items-center justify-center rounded",
            showDisclosure ? "text-tx-tertiary hover:text-tx-primary" : "pointer-events-none opacity-0",
          )}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        <button
          type="button"
          onClick={() => onSelectNotebook(notebook.id)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left"
        >
          <span className="shrink-0 text-base leading-none">{notebook.icon || "📒"}</span>
          <span className="min-w-0 flex-1 truncate">{notebook.name}</span>
          {isRoot && (
            <span className="shrink-0 text-[10px] text-tx-tertiary">
              {canEdit ? "可编辑" : "只读"}
            </span>
          )}
        </button>

        {canEdit && (
          <button
            type="button"
            aria-label="在共享笔记本中新建笔记"
            title="新建笔记"
            className="mr-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded text-tx-tertiary hover:bg-app-active hover:text-tx-primary group-hover/shared:flex focus:flex"
            onClick={(event) => {
              event.stopPropagation();
              void onCreateNote(notebook.id);
            }}
          >
            <Plus size={13} />
          </button>
        )}
      </div>

      {expanded && (
        <div>
          {notebook.children.map((child) => (
            <SharedNotebookTreeItem
              key={child.id}
              notebook={child}
              depth={depth + 1}
              selectedNotebookId={selectedNotebookId}
              activeNoteId={activeNoteId}
              showNotes={showNotes}
              notesByNotebookId={notesByNotebookId}
              loadingNotebookIds={loadingNotebookIds}
              onSelectNotebook={onSelectNotebook}
              onSelectNote={onSelectNote}
              onCreateNote={onCreateNote}
              expandedIds={expandedIds}
              onToggle={onToggle}
            />
          ))}

          {showNotes && loading && (
            <div
              className="py-1 text-[11px] text-tx-tertiary"
              style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}
            >
              加载中…
            </div>
          )}

          {showNotes && !loading && (directNotes || []).map((note) => (
            <button
              key={note.id}
              type="button"
              data-shared-note-id={note.id}
              onClick={() => onSelectNote(note.id)}
              className={cn(
                "flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs transition-colors",
                activeNoteId === note.id
                  ? "bg-app-active text-tx-primary"
                  : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
              )}
              style={{ paddingLeft: `${(depth + 1) * 16 + 28}px` }}
            >
              <FileText size={12} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{note.title || "无标题笔记"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default function SharedNotebookTree({
  notebooks,
  selectedNotebookId,
  activeNoteId,
  showNotes,
  notesByNotebookId,
  loadingNotebookIds,
  refreshToken,
  onSelectNotebook,
  onSelectNote,
  onLoadNotes,
  onCreateNote,
}: Props) {
  const tree = useMemo(() => buildSharedNotebookTree(notebooks), [notebooks]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(
    notebooks.filter((notebook) => notebook.isExpanded === 1).map((notebook) => notebook.id),
  ));

  useEffect(() => {
    const validIds = new Set(notebooks.map((notebook) => notebook.id));
    setExpandedIds((previous) => {
      const next = new Set(Array.from(previous).filter((id) => validIds.has(id)));
      for (const notebook of notebooks) {
        if (notebook.isExpanded === 1) next.add(notebook.id);
      }
      return next;
    });
  }, [notebooks]);

  useEffect(() => {
    if (!showNotes) return;
    for (const notebookId of expandedIds) void onLoadNotes(notebookId);
  }, [expandedIds, onLoadNotes, showNotes]);

  useEffect(() => {
    if (!showNotes || refreshToken === 0) return;
    for (const notebookId of expandedIds) void onLoadNotes(notebookId, true);
  }, [expandedIds, onLoadNotes, refreshToken, showNotes]);

  const handleToggle = useCallback((notebook: SharedNotebookNode) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(notebook.id)) next.delete(notebook.id);
      else next.add(notebook.id);
      return next;
    });
  }, []);

  if (tree.length === 0) return null;

  return (
    <div className="border-t border-app-border shrink-0 px-2 py-2">
      <div className="px-1 pb-1 text-xs font-medium text-tx-tertiary uppercase tracking-wider">
        共享笔记本
      </div>
      <div className="max-h-[min(38vh,320px)] space-y-0.5 overflow-y-auto overscroll-contain">
        {tree.map((notebook) => (
          <SharedNotebookTreeItem
            key={notebook.id}
            notebook={notebook}
            depth={0}
            selectedNotebookId={selectedNotebookId}
            activeNoteId={activeNoteId}
            showNotes={showNotes}
            notesByNotebookId={notesByNotebookId}
            loadingNotebookIds={loadingNotebookIds}
            onSelectNotebook={onSelectNotebook}
            onSelectNote={onSelectNote}
            onCreateNote={onCreateNote}
            expandedIds={expandedIds}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </div>
  );
}
