import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrainCircuit, Copy, FileArchive, FileCode, FileText, FileType2, Folder, LayoutTemplate, Link2, Table2 } from "lucide-react";
import type { KnowledgeTreeInlineCreateKind } from "@/lib/knowledgeTreeInlineCreate";
import { duplicateKnowledgeTreeNoteAsChild, resolveDuplicableKnowledgeTreeNote } from "@/lib/knowledgeTreeDuplicateAsChild";
import { revealCreatedKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import { toast } from "@/lib/toast";

const KNOWLEDGE_TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

const CREATE_MENU_WIDTH = 232;

const CREATE_ITEMS = [
  { kind: "note", label: "富文本文档", icon: FileText },
  { kind: "markdown", label: "Markdown 文档", icon: FileCode },
  { kind: "mindmap", label: "思维导图", icon: BrainCircuit },
  { kind: "sheet", label: "轻量表格", icon: Table2 },
] as const;
const FOLDER_CREATE_ITEM = { kind: "folder", label: "文件夹" } as const;

const IMPORT_ITEMS = [
  { kind: "markdown", label: "导入 Markdown 文件", icon: FileCode },
  { kind: "markdown-zip", label: "导入 Markdown + 附件（ZIP）", icon: FileArchive },
  { kind: "word", label: "导入 Word 文档", icon: FileType2 },
  { kind: "wechat", label: "导入公众号文章", icon: Link2 },
] as const;

export interface KnowledgeTreeCreateMenuState {
  parentId: string | null;
  anchor: DOMRect;
}

interface KnowledgeTreeCreateDropdownProps {
  menu: KnowledgeTreeCreateMenuState | null;
  onClose: () => void;
  onCreate: (parentId: string | null, kind: KnowledgeTreeInlineCreateKind) => void;
  onCreateFromTemplate: (parentId: string | null) => void;
  onCreateEncrypted?: (parentId: string | null) => void;
  onImport: (parentId: string | null, kind: "markdown" | "markdown-zip" | "word" | "wechat") => void;
}

function menuPosition(anchor: DOMRect, menuHeight: number): React.CSSProperties {
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const maxHeight = Math.max(0, viewportHeight - 16);
  const measuredHeight = Math.min(menuHeight, maxHeight);
  const below = anchor.bottom + 6;
  const top = below + measuredHeight <= viewportHeight - 8
    ? below
    : Math.max(8, anchor.top - measuredHeight - 6);
  const left = Math.min(
    Math.max(8, anchor.right - CREATE_MENU_WIDTH),
    Math.max(8, viewportWidth - CREATE_MENU_WIDTH - 8),
  );
  return { top, left, width: CREATE_MENU_WIDTH, maxHeight };
}

export function KnowledgeTreeCreateDropdown({
  menu,
  onClose,
  onCreate,
  onCreateFromTemplate,
  onCreateEncrypted,
  onImport,
}: KnowledgeTreeCreateDropdownProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<React.CSSProperties | null>(null);
  const [canDuplicateAsChild, setCanDuplicateAsChild] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCanDuplicateAsChild(false);
    const sourceNodeId = menu?.parentId;
    if (!sourceNodeId) return () => { cancelled = true; };

    void resolveDuplicableKnowledgeTreeNote(sourceNodeId)
      .then((source) => {
        if (!cancelled) setCanDuplicateAsChild(Boolean(source));
      })
      .catch(() => {
        if (!cancelled) setCanDuplicateAsChild(false);
      });

    return () => { cancelled = true; };
  }, [menu?.parentId]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setPosition(null);
      return;
    }
    setPosition(menuPosition(menu.anchor, menuRef.current.scrollHeight));
  }, [menu, canDuplicateAsChild]);

  useEffect(() => {
    if (!menu) return;
    const closeFromPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("pointerdown", closeFromPointer, true);
    window.addEventListener("keydown", closeFromKeyboard, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", closeFromPointer, true);
      window.removeEventListener("keydown", closeFromKeyboard, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [menu, onClose]);

  const duplicateAsChild = useCallback(async () => {
    const sourceNodeId = menu?.parentId;
    if (!sourceNodeId || duplicating) return;
    setDuplicating(true);
    onClose();
    try {
      const duplicated = await duplicateKnowledgeTreeNoteAsChild(sourceNodeId);
      revealCreatedKnowledgeTreeNote(sourceNodeId, duplicated.treeNodeId);
      window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, {
        detail: { reason: "note-duplicated-as-child", parentId: sourceNodeId },
      }));
      toast.success("副本已创建到子目录");
    } catch (error: any) {
      toast.error(error?.message || "创建副本失败");
    } finally {
      setDuplicating(false);
    }
  }, [duplicating, menu?.parentId, onClose]);

  if (!menu || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={menu.parentId ? "在当前节点下新建或复制" : "在根目录新建"}
      className="fixed z-[420] overflow-y-auto overscroll-contain rounded-lg border border-app-border bg-app-bg p-1 shadow-xl"
      style={position || { left: 8, top: 8, width: CREATE_MENU_WIDTH, visibility: "hidden" }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {CREATE_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.kind}
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary focus:bg-app-hover focus:text-tx-primary focus:outline-none"
            onClick={() => onCreate(menu.parentId, item.kind)}
          >
            <Icon
              size={15}
              className={item.kind === "markdown" ? "text-emerald-500" : "text-accent-primary"}
            />
            <span>{item.label}</span>
          </button>
        );
      })}
      {onCreateEncrypted && <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-tx-secondary hover:bg-app-hover" onClick={() => onCreateEncrypted(menu.parentId)}>
        <FileText size={15} /><span>加密笔记</span>
      </button>}
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary focus:bg-app-hover focus:text-tx-primary focus:outline-none"
        onClick={() => onCreateFromTemplate(menu.parentId)}
      >
        <LayoutTemplate size={15} className="text-violet-500" />
        <span>从模板新建</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary focus:bg-app-hover focus:text-tx-primary focus:outline-none"
        onClick={() => onCreate(menu.parentId, FOLDER_CREATE_ITEM.kind)}
      >
        <Folder size={15} className="text-amber-500" />
        <span>{FOLDER_CREATE_ITEM.label}</span>
      </button>
      {canDuplicateAsChild && menu.parentId && (
        <button
          type="button"
          role="menuitem"
          disabled={duplicating}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary focus:bg-app-hover focus:text-tx-primary focus:outline-none disabled:cursor-wait disabled:opacity-50"
          onClick={() => { void duplicateAsChild(); }}
        >
          <Copy size={15} className="text-sky-500" />
          <span>创建副本</span>
        </button>
      )}
      <div className="my-1 border-t border-app-border" />
      {IMPORT_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.kind}
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary focus:bg-app-hover focus:text-tx-primary focus:outline-none"
            onClick={() => onImport(menu.parentId, item.kind)}
          >
            <Icon
              size={15}
              className={item.kind === "markdown"
                ? "text-emerald-500"
                : item.kind === "markdown-zip"
                  ? "text-amber-500"
                  : item.kind === "word"
                    ? "text-violet-500"
                    : "text-sky-500"}
            />
            <span>{item.label}</span>
          </button>
        );
      })}
      <p className="border-t border-app-border px-2.5 pb-1 pt-2 text-[10px] text-tx-tertiary">
        也可将 .md 文件拖拽到目录树导入（或 Markdown 附件 ZIP）
      </p>
    </div>,
    document.body,
  );
}
