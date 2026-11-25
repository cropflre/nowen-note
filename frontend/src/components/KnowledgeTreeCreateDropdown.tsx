import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BrainCircuit,
  ChevronRight,
  Copy,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType2,
  Folder,
  LayoutTemplate,
  Link2,
  Lock,
  MoreHorizontal,
  Presentation,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { KnowledgeTreeImportKind } from "@/components/knowledgeTreeImport";
import type { KnowledgeTreeInlineCreateKind } from "@/lib/knowledgeTreeInlineCreate";
import { duplicateKnowledgeTreeNoteAsChild, resolveDuplicableKnowledgeTreeNote } from "@/lib/knowledgeTreeDuplicateAsChild";
import { revealCreatedKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import { toast } from "@/lib/toast";
import { isExcelCreationEnabled } from "@/lib/excelApi";

const KNOWLEDGE_TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

const CREATE_MENU_WIDTH = 224;

/** 高频核心新建项：一级直接展示，一次点击即达 */
const PRIMARY_CREATE_ITEMS = [
  { kind: "note", label: "富文本文档", icon: FileText },
  { kind: "word", label: "Word 文档", icon: FileType2 },
  { kind: "markdown", label: "Markdown 文档", icon: FileCode },
] as const;

const FOLDER_CREATE_ITEM = { kind: "folder", label: "文件夹", icon: Folder } as const;

/** 低频扩展新建项：收纳入“更多类型”手风琴，减少视觉噪声 */
const MORE_CREATE_ITEMS = [
  { kind: "ppt", label: "PPT 演示文稿", icon: Presentation },
  { kind: "plaintext", label: "note.format.plainTextDocument", icon: FileText },
  { kind: "mindmap", label: "思维导图", icon: BrainCircuit },
] as const;

const EXCEL_CREATE_ITEM = { kind: "excel", label: "Excel 表格", icon: FileSpreadsheet } as const;

/** 导入类入口：统一收纳入“导入内容”手风琴 */
const IMPORT_ITEMS = [
  { kind: "markdown", label: "导入 Markdown 文件", icon: FileCode },
  { kind: "markdown-zip", label: "导入 Markdown + 附件（ZIP）", icon: FileArchive },
  { kind: "word", label: "导入 Word 文档", icon: FileType2 },
  { kind: "ppt", label: "导入 PPTX 演示文稿", icon: Presentation },
  { kind: "sheet", label: "导入表格（XLSX / CSV）", icon: FileSpreadsheet },
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
  onImport: (parentId: string | null, kind: KnowledgeTreeImportKind) => void;
}

type ExpandedSection = "more" | "import" | null;

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

function itemIconClass(kind: string): string {
  if (kind === "markdown") return "text-emerald-500";
  if (kind === "word") return "text-blue-500";
  if (kind === "ppt") return "text-orange-500";
  if (kind === "excel") return "text-emerald-600";
  if (kind === "folder") return "text-amber-500";
  return "text-accent-primary";
}

export function KnowledgeTreeCreateDropdown({
  menu,
  onClose,
  onCreate,
  onCreateFromTemplate,
  onCreateEncrypted,
  onImport,
}: KnowledgeTreeCreateDropdownProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<React.CSSProperties | null>(null);
  const [canDuplicateAsChild, setCanDuplicateAsChild] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [excelEnabled, setExcelEnabled] = useState(false);
  const [expandedSection, setExpandedSection] = useState<ExpandedSection>(null);

  useEffect(() => {
    setExpandedSection(null);
    if (!menu) return;
    let cancelled = false;
    void isExcelCreationEnabled().then((enabled) => { if (!cancelled) setExcelEnabled(enabled); });
    return () => { cancelled = true; };
  }, [menu]);

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
  }, [menu, canDuplicateAsChild, expandedSection, excelEnabled]);

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
    } catch (caughtError: unknown) {
      const error = caughtError as Error & { code?: string };
      toast.error(error?.message || "创建副本失败");
    } finally {
      setDuplicating(false);
    }
  }, [duplicating, menu?.parentId, onClose]);

  const toggleSection = (section: Exclude<ExpandedSection, null>) => {
    setExpandedSection((current) => (current === section ? null : section));
  };

  if (!menu || typeof document === "undefined") return null;

  const moreItems = [...MORE_CREATE_ITEMS, ...(excelEnabled ? [EXCEL_CREATE_ITEM] : [])];
  const itemButtonClass =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary focus-visible:bg-app-hover focus-visible:text-tx-primary focus-visible:outline-2 focus-visible:outline-accent-primary focus:outline-none";

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={menu.parentId ? "在当前节点下新建或复制" : "在根目录新建"}
      className="fixed z-[420] overflow-y-auto overscroll-contain rounded-lg border border-app-border bg-app-bg p-1.5 shadow-xl"
      style={position || { left: 8, top: 8, width: CREATE_MENU_WIDTH, visibility: "hidden" }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* 1. 高频核心创建（4 项直出） */}
      {PRIMARY_CREATE_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.kind}
            type="button"
            role="menuitem"
            className={itemButtonClass}
            onClick={() => onCreate(menu.parentId, item.kind)}
          >
            <Icon size={15} className={itemIconClass(item.kind)} />
            <span>{item.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        role="menuitem"
        className={itemButtonClass}
        onClick={() => onCreate(menu.parentId, FOLDER_CREATE_ITEM.kind)}
      >
        <Folder size={15} className="text-amber-500" />
        <span>{FOLDER_CREATE_ITEM.label}</span>
      </button>

      <div className="my-1 border-t border-app-border" />

      {/* 2. 模板与副本 */}
      <button
        type="button"
        role="menuitem"
        className={itemButtonClass}
        onClick={() => onCreateFromTemplate(menu.parentId)}
      >
        <LayoutTemplate size={15} className="text-violet-500" />
        <span>从模板新建</span>
      </button>

      {canDuplicateAsChild && menu.parentId && (
        <button
          type="button"
          role="menuitem"
          disabled={duplicating}
          className={`${itemButtonClass} disabled:cursor-wait disabled:opacity-50`}
          onClick={() => { void duplicateAsChild(); }}
        >
          <Copy size={15} className="text-sky-500" />
          <span>创建副本</span>
        </button>
      )}

      <div className="my-1 border-t border-app-border" />

      {/* 3. 低频扩展类型（手风琴折叠） */}
      <button
        type="button"
        aria-expanded={expandedSection === "more"}
        aria-controls="nowen-create-menu-more"
        className={`${itemButtonClass} justify-between`}
        onClick={() => toggleSection("more")}
      >
        <span className="inline-flex items-center gap-2">
          <MoreHorizontal size={15} className="text-tx-tertiary" />
          <span>更多类型</span>
        </span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`text-tx-tertiary transition-transform duration-150 ${expandedSection === "more" ? "rotate-90" : ""}`}
        />
      </button>
      {expandedSection === "more" && (
        <div
          id="nowen-create-menu-more"
          role="group"
          aria-label="更多新建类型"
          className="mt-0.5 space-y-0.5 rounded-md bg-app-surface/70 p-1 pl-2"
        >
          {moreItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                className={itemButtonClass}
                onClick={() => onCreate(menu.parentId, item.kind)}
              >
                <Icon size={14} className={itemIconClass(item.kind)} />
                <span>{item.kind === "plaintext" ? t(item.label, { defaultValue: "纯文本文档（TXT）" }) : item.label}</span>
              </button>
            );
          })}
          {onCreateEncrypted && (
            <button
              type="button"
              role="menuitem"
              className={itemButtonClass}
              onClick={() => onCreateEncrypted(menu.parentId)}
            >
              <Lock size={14} className="text-amber-500" />
              <span>加密笔记</span>
            </button>
          )}
        </div>
      )}

      {/* 4. 导入外部内容（手风琴折叠） */}
      <button
        type="button"
        aria-expanded={expandedSection === "import"}
        aria-controls="nowen-create-menu-import"
        className={`${itemButtonClass} justify-between`}
        onClick={() => toggleSection("import")}
      >
        <span className="inline-flex items-center gap-2">
          <Upload size={15} className="text-sky-500" />
          <span>导入内容</span>
        </span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`text-tx-tertiary transition-transform duration-150 ${expandedSection === "import" ? "rotate-90" : ""}`}
        />
      </button>
      {expandedSection === "import" && (
        <div
          id="nowen-create-menu-import"
          role="group"
          aria-label="导入外部内容"
          className="mt-0.5 space-y-0.5 rounded-md bg-app-surface/70 p-1 pl-2"
        >
          {IMPORT_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                className={itemButtonClass}
                onClick={() => onImport(menu.parentId, item.kind)}
              >
                <Icon
                  size={14}
                  className={item.kind === "markdown"
                    ? "text-emerald-500"
                    : item.kind === "markdown-zip"
                      ? "text-amber-500"
                      : item.kind === "word"
                        ? "text-violet-500"
                        : item.kind === "ppt"
                          ? "text-orange-500"
                          : item.kind === "sheet"
                            ? "text-emerald-600"
                            : "text-sky-500"}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
          <p className="px-2 pb-0.5 pt-1 text-[10px] leading-snug text-tx-tertiary">
            也可将 .md 文件拖拽到目录树导入（也支持 Word / PPTX / 表格 / Markdown 附件 ZIP）
          </p>
        </div>
      )}
    </div>,
    document.body,
  );
}
