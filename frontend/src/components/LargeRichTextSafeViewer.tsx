import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Layers,
  Pencil,
  Scissors,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type {
  NoteEditorHandle,
  NoteEditorProps,
} from "@/components/editors/types";
import VirtualRichTextSectionEditor from "@/components/VirtualRichTextSectionEditor";
import { formatEditorByteSize } from "@/lib/editorComplexityProfile";
import {
  getEditorRuntimeDecisionForNote,
  getLargeDocumentOriginalFormat,
  type RuntimeLargeRichTextSafeNote,
} from "@/lib/largeRichTextSafeMode";
import type { EditorComplexityReason } from "@/lib/editorRuntimePolicy";
import {
  buildPrefixOffsets,
  buildSectionsFromBlocks,
  computeVirtualWindow,
  estimateBlockHeight,
  extractNodePlainText,
  findMatchingBlockIndices,
  findSectionForBlock,
  parseVirtualRichTextDocument,
  serializeBlocksToPlainText,
  spliceEditedSection,
  splitPlainTextLines,
  toggleTaskItemInBlock,
  type VirtualRichTextSection,
  type VirtualTiptapNode,
} from "@/lib/virtualRichTextDocument";
import { cn } from "@/lib/utils";

interface LargeRichTextSafeViewerProps extends NoteEditorProps {
  onAIAssistant?: () => void;
  canSplitDocument?: boolean;
  onSplitDocument?: () => void;
}

const REASON_KEYS: Record<EditorComplexityReason, string> = {
  "serialized-size": "markdown.largeDocument.reasons.serializedSize",
  "line-count": "markdown.largeDocument.reasons.lineCount",
  "long-line": "markdown.largeDocument.reasons.longLine",
  "node-count": "markdown.largeDocument.reasons.nodeCount",
  "media-count": "markdown.largeDocument.reasons.mediaCount",
  "code-block-count": "markdown.largeDocument.reasons.codeBlockCount",
  "initialization-timeout": "markdown.largeDocument.reasons.initializationTimeout",
  "runtime-long-task": "markdown.largeDocument.reasons.runtimeLongTask",
};

const PLAIN_TEXT_LINE_HEIGHT = 24;

function renderHighlightedText(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIdx = lower.indexOf(target, cursor);
  let key = 0;
  while (matchIdx !== -1 && key < 40) {
    if (matchIdx > cursor) parts.push(text.slice(cursor, matchIdx));
    parts.push(
      <mark
        key={`m-${key++}`}
        className="rounded bg-amber-300/70 px-0.5 text-zinc-900 dark:bg-amber-400/35 dark:text-amber-100"
      >
        {text.slice(matchIdx, matchIdx + needle.length)}
      </mark>,
    );
    cursor = matchIdx + needle.length;
    matchIdx = lower.indexOf(target, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}

function renderInlineNodes(
  nodes: VirtualTiptapNode[] | undefined,
  highlightQuery: string,
): React.ReactNode {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  return nodes.map((node, index) => {
    if (node.type === "hardBreak") return <br key={index} />;
    if (node.type === "image" || node.type === "resizableImage") {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      return src ? (
        <img
          key={index}
          src={src}
          alt={alt}
          loading="lazy"
          className="my-2 inline-block max-h-96 max-w-full rounded-xl border border-app-border object-contain"
        />
      ) : null;
    }
    if (node.type !== "text") {
      return (
        <React.Fragment key={index}>
          {renderInlineNodes(node.content, highlightQuery)}
        </React.Fragment>
      );
    }

    let content: React.ReactNode = renderHighlightedText(node.text || "", highlightQuery);
    const marks = node.marks || [];
    for (let m = 0; m < marks.length; m++) {
      const mark = marks[m];
      switch (mark.type) {
        case "bold":
          content = <strong key={`b-${m}`} className="font-semibold text-tx-primary">{content}</strong>;
          break;
        case "italic":
          content = <em key={`i-${m}`} className="italic">{content}</em>;
          break;
        case "underline":
          content = <u key={`u-${m}`} className="underline underline-offset-2">{content}</u>;
          break;
        case "strike":
          content = <s key={`s-${m}`} className="line-through opacity-75">{content}</s>;
          break;
        case "code":
          content = (
            <code
              key={`c-${m}`}
              className="rounded-md border border-app-border/70 bg-app-surface px-1.5 py-0.5 font-mono text-[0.88em] text-indigo-600 dark:text-indigo-300"
            >
              {content}
            </code>
          );
          break;
        case "highlight": {
          const color = typeof mark.attrs?.color === "string" ? mark.attrs.color : undefined;
          content = (
            <mark
              key={`h-${m}`}
              style={color ? { backgroundColor: color } : undefined}
              className="rounded px-1 py-0.5 bg-amber-200/75 text-zinc-900 dark:bg-amber-500/25 dark:text-amber-100"
            >
              {content}
            </mark>
          );
          break;
        }
        case "link": {
          const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "#";
          content = (
            <a
              key={`l-${m}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-primary underline decoration-accent-primary/40 underline-offset-2 hover:decoration-accent-primary"
            >
              {content}
            </a>
          );
          break;
        }
        case "textStyle": {
          const color = typeof mark.attrs?.color === "string" ? mark.attrs.color : undefined;
          if (color) content = <span key={`ts-${m}`} style={{ color }}>{content}</span>;
          break;
        }
        default:
          break;
      }
    }
    return <React.Fragment key={index}>{content}</React.Fragment>;
  });
}

const VirtualRichTextBlock = React.memo(function VirtualRichTextBlock({
  block,
  blockIndex,
  highlightQuery,
  isActiveMatch,
  canEdit,
  onEditBlock,
  onToggleTask,
  onHeightMeasured,
}: {
  block: VirtualTiptapNode;
  blockIndex: number;
  highlightQuery: string;
  isActiveMatch: boolean;
  canEdit: boolean;
  onEditBlock: (blockIndex: number) => void;
  onToggleTask: (blockIndex: number, itemIndex: number) => void;
  onHeightMeasured: (blockIndex: number, height: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const h = Math.ceil(el.getBoundingClientRect().height);
    if (h > 0) onHeightMeasured(blockIndex, h);
  }, [block, blockIndex, onHeightMeasured]);

  const renderBody = (): React.ReactNode => {
    switch (block.type) {
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(block.attrs?.level ?? 2)));
        const classes: Record<number, string> = {
          1: "mt-4 mb-2 text-2xl font-bold tracking-tight text-tx-primary",
          2: "mt-4 mb-1.5 text-xl font-bold tracking-tight text-tx-primary border-b border-app-border/50 pb-1",
          3: "mt-3 mb-1 text-lg font-semibold text-tx-primary",
          4: "mt-2.5 mb-1 text-base font-semibold text-tx-primary",
          5: "mt-2 mb-1 text-sm font-semibold text-tx-primary",
          6: "mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-tx-secondary",
        };
        const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
        return <Tag className={classes[level]}>{renderInlineNodes(block.content, highlightQuery)}</Tag>;
      }
      case "paragraph": {
        const textAlign = typeof block.attrs?.textAlign === "string" ? block.attrs.textAlign : undefined;
        return (
          <p
            style={textAlign ? { textAlign: textAlign as React.CSSProperties["textAlign"] } : undefined}
            className="my-1.5 min-h-[1.5em] text-[15px] leading-7 text-tx-primary"
          >
            {renderInlineNodes(block.content, highlightQuery)}
          </p>
        );
      }
      case "blockquote":
        return (
          <blockquote className="my-2 rounded-r-xl border-l-4 border-accent-primary/50 bg-app-surface/70 px-4 py-2 text-sm leading-6 text-tx-secondary">
            {(block.content || []).map((child, idx) => (
              <div key={idx} className="my-0.5">
                {renderInlineNodes(child.content, highlightQuery)}
              </div>
            ))}
          </blockquote>
        );
      case "bulletList":
        return (
          <ul className="my-2 list-disc space-y-1 pl-6 text-[15px] leading-7 text-tx-primary">
            {(block.content || []).map((item, idx) => (
              <li key={idx}>
                {(item.content || []).map((p, pIdx) => (
                  <span key={pIdx}>{renderInlineNodes(p.content, highlightQuery)}</span>
                ))}
              </li>
            ))}
          </ul>
        );
      case "orderedList":
        return (
          <ol className="my-2 list-decimal space-y-1 pl-6 text-[15px] leading-7 text-tx-primary">
            {(block.content || []).map((item, idx) => (
              <li key={idx}>
                {(item.content || []).map((p, pIdx) => (
                  <span key={pIdx}>{renderInlineNodes(p.content, highlightQuery)}</span>
                ))}
              </li>
            ))}
          </ol>
        );
      case "taskList":
        return (
          <ul className="my-2 space-y-1.5 pl-1 text-[15px] leading-6 text-tx-primary">
            {(block.content || []).map((item, idx) => {
              const checked = Boolean(item.attrs?.checked);
              return (
                <li key={idx} className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canEdit}
                    onChange={() => onToggleTask(blockIndex, idx)}
                    className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded accent-accent-primary disabled:cursor-default"
                  />
                  <span className={cn("min-w-0 flex-1", checked && "line-through text-tx-tertiary")}>
                    {(item.content || []).map((p, pIdx) => (
                      <span key={pIdx}>{renderInlineNodes(p.content, highlightQuery)}</span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        );
      case "codeBlock": {
        const lang = typeof block.attrs?.language === "string" && block.attrs.language
          ? block.attrs.language
          : "text";
        const codeText = extractNodePlainText(block);
        return (
          <div className="my-2.5 overflow-hidden rounded-xl border border-app-border/80 bg-zinc-950 text-zinc-100 shadow-xs">
            <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-zinc-400">
              <span className="font-mono uppercase">{lang}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(codeText).then(() => {
                    setCopiedCode(true);
                    window.setTimeout(() => setCopiedCode(false), 1500);
                  }).catch(() => {});
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
              >
                {copiedCode ? <Check size={11} /> : <Copy size={11} />}
                <span>{copiedCode ? "已复制" : "复制"}</span>
              </button>
            </div>
            <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-5 text-zinc-100">
              <code>{renderHighlightedText(codeText, highlightQuery)}</code>
            </pre>
          </div>
        );
      }
      case "table":
        return (
          <div className="my-2.5 overflow-x-auto rounded-xl border border-app-border/80 bg-app-surface/40">
            <table className="w-full border-collapse text-left text-xs text-tx-primary">
              <tbody>
                {(block.content || []).map((row, rIdx) => (
                  <tr key={rIdx} className="border-b border-app-border/60 last:border-b-0">
                    {(row.content || []).map((cell, cIdx) => {
                      const isHeader = cell.type === "tableHeader";
                      const CellTag = isHeader ? "th" : "td";
                      return (
                        <CellTag
                          key={cIdx}
                          className={cn(
                            "border-r border-app-border/60 px-3 py-2 align-top last:border-r-0",
                            isHeader && "bg-app-hover/65 font-semibold text-tx-primary",
                          )}
                        >
                          {(cell.content || []).map((p, pIdx) => (
                            <div key={pIdx}>{renderInlineNodes(p.content, highlightQuery)}</div>
                          ))}
                        </CellTag>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "horizontalRule":
        return <hr className="my-4 border-app-border" />;
      case "image":
      case "resizableImage": {
        const src = typeof block.attrs?.src === "string" ? block.attrs.src : "";
        const alt = typeof block.attrs?.alt === "string" ? block.attrs.alt : "";
        return src ? (
          <div className="my-2.5">
            <img
              src={src}
              alt={alt}
              loading="lazy"
              className="max-h-96 max-w-full rounded-xl border border-app-border object-contain"
            />
          </div>
        ) : null;
      }
      default: {
        const fallbackText = extractNodePlainText(block);
        return (
          <div className="my-2 rounded-xl border border-app-border/75 bg-app-surface/70 px-3.5 py-2.5 text-xs text-tx-secondary">
            <span className="mr-2 rounded bg-app-hover px-1.5 py-0.5 font-mono text-[10px] text-tx-tertiary">
              {block.type}
            </span>
            <span>{fallbackText ? renderHighlightedText(fallbackText, highlightQuery) : `[${block.type}]`}</span>
          </div>
        );
      }
    }
  };

  return (
    <div
      ref={rowRef}
      data-virtual-block-index={blockIndex}
      onDoubleClick={() => { if (canEdit) onEditBlock(blockIndex); }}
      className={cn(
        "group relative -mx-2 rounded-xl px-2 py-0.5 transition-colors",
        canEdit && "hover:bg-app-hover/40",
        isActiveMatch && "bg-amber-400/15 ring-1 ring-amber-400/50",
      )}
    >
      {canEdit && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEditBlock(blockIndex);
          }}
          className="absolute right-2 top-1.5 z-10 inline-flex items-center gap-1 rounded-lg border border-app-border/80 bg-app-elevated/95 px-2 py-1 text-[11px] font-medium text-tx-secondary opacity-0 shadow-xs backdrop-blur-sm transition-all hover:border-accent-primary/50 hover:text-accent-primary group-hover:opacity-100 focus:opacity-100"
        >
          <Pencil size={11} />
          <span>编辑本章</span>
        </button>
      )}
      {renderBody()}
    </div>
  );
});

/**
 * True virtualized plain-text viewer (Tier 3 fuse for >20MB / malformed / HTML docs
 * or explicit plain-text mode). Replaces the legacy monolithic <textarea>.
 */
function VirtualPlainTextViewport({
  text,
  searchQuery,
  ariaLabel,
  onJumpReady,
}: {
  text: string;
  searchQuery: string;
  ariaLabel: string;
  onJumpReady?: (jumpToCharOffset: (offset: number) => void) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);

  const lines = useMemo(() => splitPlainTextLines(text), [text]);
  const offsets = useMemo(() => {
    const arr = new Float64Array(lines.length + 1);
    for (let i = 0; i <= lines.length; i++) arr[i] = i * PLAIN_TEXT_LINE_HEIGHT;
    return arr;
  }, [lines.length]);

  const windowRange = useMemo(
    () => computeVirtualWindow(offsets, lines.length, scrollTop, viewportHeight, 600),
    [offsets, lines.length, scrollTop, viewportHeight],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateSize = () => setViewportHeight(el.clientHeight || 640);
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    onJumpReady?.((charOffset: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const prefix = text.slice(0, Math.max(0, Math.min(text.length, charOffset)));
      const lineIndex = prefix.split(/\r?\n/).length - 1;
      el.scrollTop = Math.max(0, lineIndex * PLAIN_TEXT_LINE_HEIGHT - 80);
    });
  }, [onJumpReady, text]);

  const visibleLines = lines.slice(windowRange.startIndex, windowRange.endIndex);

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={ariaLabel}
      data-virtual-plain-text-viewport="true"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-auto rounded-2xl border border-app-border/80 bg-app-surface/75 px-4 py-3 font-mono text-[13px] text-tx-primary shadow-xs select-text"
    >
      <div style={{ height: windowRange.totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${windowRange.offsetTop}px)` }}>
          {visibleLines.map((line, idx) => {
            const lineNumber = windowRange.startIndex + idx + 1;
            return (
              <div
                key={lineNumber}
                data-virtual-plain-line={lineNumber}
                style={{ height: PLAIN_TEXT_LINE_HEIGHT, lineHeight: `${PLAIN_TEXT_LINE_HEIGHT}px` }}
                className="flex items-center gap-3 whitespace-pre"
              >
                <span className="w-14 shrink-0 select-none text-right text-[11px] tabular-nums text-tx-tertiary/70">
                  {lineNumber}
                </span>
                <span className="min-w-0">{line ? renderHighlightedText(line, searchQuery) : "\u00A0"}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Three-tier virtualized viewer & section editor for large rich-text notes:
 * - Tier 2 (1MB–20MB valid tiptap-json): True virtualized rich-text block rendering
 *   with outline navigation, in-doc search, interactive checkboxes, and on-demand
 *   single-section TipTap editing (<= 120 blocks per edit session).
 * - Tier 3 (>20MB / malformed / legacy HTML / manual toggle): True virtualized
 *   line-by-line plain-text reader (replacing the legacy monolithic <textarea>).
 */
const LargeRichTextSafeViewer = forwardRef<
  NoteEditorHandle,
  LargeRichTextSafeViewerProps
>(function LargeRichTextSafeViewer(
  {
    note,
    onUpdate,
    onHeadingsChange,
    onEditorReady,
    searchQuery,
    editable = true,
    canSplitDocument = false,
    onSplitDocument,
  },
  forwardedRef,
) {
  const { t, i18n } = useTranslation();
  const safeNote = note as RuntimeLargeRichTextSafeNote;
  const decision = useMemo(() => getEditorRuntimeDecisionForNote(safeNote), [safeNote]);
  const profile = decision?.profile;
  const locale = i18n.resolvedLanguage || i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const originalFormat = getLargeDocumentOriginalFormat(safeNote) || "tiptap-json";
  const canEdit = editable !== false;

  const initialParsed = useMemo(
    () => parseVirtualRichTextDocument(note.content, originalFormat),
    [note.id, note.content, originalFormat],
  );

  const [blocks, setBlocks] = useState<VirtualTiptapNode[]>(() => initialParsed?.blocks ?? []);
  const [title, setTitle] = useState(note.title);
  const [viewMode, setViewMode] = useState<"rich" | "plain">(() => (initialParsed ? "rich" : "plain"));
  const [editingSection, setEditingSection] = useState<VirtualRichTextSection | null>(null);
  const [localSearch, setLocalSearch] = useState(searchQuery || "");
  const [activeMatchCursor, setActiveMatchCursor] = useState(0);
  const [copiedAll, setCopiedAll] = useState(false);

  const liveContentRef = useRef(note.content);
  const liveContentTextRef = useRef(note.contentText);
  const liveTitleRef = useRef(note.title);
  const lastEmittedContentRef = useRef<string | null>(null);
  const sectionDirtyRef = useRef<{
    dirty: boolean;
    section: VirtualRichTextSection | null;
    getSnapshot: () => string | null;
  }>({ dirty: false, section: null, getSnapshot: () => null });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const measuredHeightsRef = useRef<Map<number, number>>(new Map());
  const [heightTick, setHeightTick] = useState(0);
  const rafMeasureRef = useRef<number | null>(null);
  const plainJumpRef = useRef<((offset: number) => void) | null>(null);

  // Sync when switching notes or receiving an external server update
  useEffect(() => {
    if (lastEmittedContentRef.current && note.content === lastEmittedContentRef.current) {
      liveTitleRef.current = note.title;
      setTitle(note.title);
      return;
    }
    lastEmittedContentRef.current = null;
    liveContentRef.current = note.content;
    liveContentTextRef.current = note.contentText;
    liveTitleRef.current = note.title;
    setTitle(note.title);
    setEditingSection(null);
    measuredHeightsRef.current.clear();
    if (initialParsed) {
      setBlocks(initialParsed.blocks);
      setViewMode("rich");
    } else {
      setBlocks([]);
      setViewMode("plain");
    }
  }, [note.id, note.content, note.contentText, note.title, initialParsed]);

  useEffect(() => {
    if (searchQuery !== undefined) setLocalSearch(searchQuery);
  }, [searchQuery]);

  const sections = useMemo(() => buildSectionsFromBlocks(blocks), [blocks]);

  const headings = useMemo(() => {
    if (viewMode !== "rich" || blocks.length === 0) return [];
    const list = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== "heading") continue;
      const text = extractNodePlainText(block).trim();
      if (!text) continue;
      list.push({
        id: typeof block.attrs?.blockId === "string" ? block.attrs.blockId : `virtual-heading-${i}`,
        level: Math.min(6, Math.max(1, Number(block.attrs?.level ?? 2))),
        text,
        pos: i,
      });
    }
    return list;
  }, [blocks, viewMode]);

  useEffect(() => {
    onHeadingsChange?.(headings);
  }, [headings, onHeadingsChange]);

  const blockHeights = useMemo(() => {
    void heightTick;
    const measured = measuredHeightsRef.current;
    return blocks.map((block, index) => {
      if (editingSection && index >= editingSection.startBlock && index < editingSection.endBlock) {
        return index === editingSection.startBlock ? 460 : 0;
      }
      return measured.get(index) ?? estimateBlockHeight(block);
    });
  }, [blocks, editingSection, heightTick]);

  const offsets = useMemo(() => buildPrefixOffsets(blockHeights), [blockHeights]);

  const virtualWindow = useMemo(() => {
    const base = computeVirtualWindow(offsets, blocks.length, scrollTop, viewportHeight, 900);
    if (
      editingSection
      && base.startIndex > editingSection.startBlock
      && base.startIndex < editingSection.endBlock
    ) {
      return {
        ...base,
        startIndex: editingSection.startBlock,
        offsetTop: offsets[editingSection.startBlock],
      };
    }
    return base;
  }, [offsets, blocks.length, scrollTop, viewportHeight, editingSection]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateSize = () => setViewportHeight(el.clientHeight || 640);
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode]);

  useEffect(() => () => {
    if (rafMeasureRef.current !== null) cancelAnimationFrame(rafMeasureRef.current);
  }, []);

  const handleHeightMeasured = useCallback((blockIndex: number, height: number) => {
    const prev = measuredHeightsRef.current.get(blockIndex);
    if (prev !== undefined && Math.abs(prev - height) <= 2) return;
    measuredHeightsRef.current.set(blockIndex, height);
    if (rafMeasureRef.current === null && typeof requestAnimationFrame !== "undefined") {
      rafMeasureRef.current = requestAnimationFrame(() => {
        rafMeasureRef.current = null;
        setHeightTick((v) => v + 1);
      });
    }
  }, []);

  const scrollToBlock = useCallback((blockIndex: number) => {
    const el = scrollRef.current;
    if (!el || blocks.length === 0) return;
    const clamped = Math.max(0, Math.min(blocks.length - 1, blockIndex));
    const targetTop = Math.max(0, offsets[clamped] - 32);
    el.scrollTop = targetTop;
    setScrollTop(targetTop);
  }, [blocks.length, offsets]);

  useEffect(() => {
    onEditorReady?.((position: number) => {
      if (viewMode === "rich") {
        scrollToBlock(position);
      } else {
        plainJumpRef.current?.(position);
      }
    });
  }, [onEditorReady, scrollToBlock, viewMode]);

  const matchingIndices = useMemo(
    () => (viewMode === "rich" ? findMatchingBlockIndices(blocks, localSearch) : []),
    [blocks, localSearch, viewMode],
  );

  useEffect(() => {
    setActiveMatchCursor(0);
    if (matchingIndices.length > 0) {
      scrollToBlock(matchingIndices[0]);
    }
  }, [localSearch, matchingIndices.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpMatch = (delta: number) => {
    if (matchingIndices.length === 0) return;
    const next = (activeMatchCursor + delta + matchingIndices.length) % matchingIndices.length;
    setActiveMatchCursor(next);
    scrollToBlock(matchingIndices[next]);
  };

  const commitBlocks = useCallback((
    nextBlocks: VirtualTiptapNode[],
    nextContent: string,
    nextContentText: string,
    nextTitle = liveTitleRef.current,
  ) => {
    setBlocks(nextBlocks);
    liveContentRef.current = nextContent;
    liveContentTextRef.current = nextContentText;
    lastEmittedContentRef.current = nextContent;
    measuredHeightsRef.current.clear();
    onUpdate?.({
      title: nextTitle,
      content: nextContent,
      contentText: nextContentText,
      _noteId: note.id,
    });
  }, [note.id, onUpdate]);

  const handleSaveSection = useCallback((sectionDocJson: string) => {
    if (!editingSection) return;
    const spliced = spliceEditedSection(blocks, editingSection, sectionDocJson);
    if (!spliced) return;
    sectionDirtyRef.current = { dirty: false, section: null, getSnapshot: () => null };
    setEditingSection(null);
    commitBlocks(spliced.nextBlocks, spliced.nextContent, spliced.nextContentText);
  }, [blocks, commitBlocks, editingSection]);

  const handleToggleTask = useCallback((blockIndex: number, itemIndex: number) => {
    if (!canEdit) return;
    const target = blocks[blockIndex];
    if (!target || target.type !== "taskList") return;
    const updatedBlock = toggleTaskItemInBlock(target, itemIndex);
    const nextBlocks = blocks.slice();
    nextBlocks[blockIndex] = updatedBlock;
    const nextContent = JSON.stringify({ type: "doc", content: nextBlocks });
    const nextContentText = serializeBlocksToPlainText(nextBlocks);
    commitBlocks(nextBlocks, nextContent, nextContentText);
  }, [blocks, canEdit, commitBlocks]);

  const handleEditBlock = useCallback((blockIndex: number) => {
    if (!canEdit) return;
    // Flush any previously edited section before switching
    if (sectionDirtyRef.current.dirty && sectionDirtyRef.current.section) {
      const snap = sectionDirtyRef.current.getSnapshot();
      if (snap) {
        const spliced = spliceEditedSection(blocks, sectionDirtyRef.current.section, snap);
        if (spliced) {
          commitBlocks(spliced.nextBlocks, spliced.nextContent, spliced.nextContentText);
        }
      }
    }
    const targetSection = findSectionForBlock(sections, blockIndex);
    if (targetSection) setEditingSection(targetSection);
  }, [blocks, canEdit, commitBlocks, sections]);

  const handleTitleChange = (nextTitle: string) => {
    setTitle(nextTitle);
    liveTitleRef.current = nextTitle;
    if (!canEdit) return;
    onUpdate?.({
      title: nextTitle,
      content: liveContentRef.current,
      contentText: liveContentTextRef.current,
      _noteId: note.id,
    });
  };

  useImperativeHandle(forwardedRef, () => ({
    flushSave: () => {
      if (sectionDirtyRef.current.dirty && sectionDirtyRef.current.section) {
        const snap = sectionDirtyRef.current.getSnapshot();
        if (snap) {
          const spliced = spliceEditedSection(blocks, sectionDirtyRef.current.section, snap);
          if (spliced) {
            sectionDirtyRef.current.dirty = false;
            commitBlocks(spliced.nextBlocks, spliced.nextContent, spliced.nextContentText);
          }
        }
      }
    },
    discardPending: () => {
      sectionDirtyRef.current = { dirty: false, section: null, getSnapshot: () => null };
      setEditingSection(null);
    },
    getSnapshot: () => {
      if (sectionDirtyRef.current.dirty && sectionDirtyRef.current.section) {
        const snap = sectionDirtyRef.current.getSnapshot();
        if (snap) {
          const spliced = spliceEditedSection(blocks, sectionDirtyRef.current.section, snap);
          if (spliced) {
            return {
              content: spliced.nextContent,
              contentText: spliced.nextContentText,
            };
          }
        }
      }
      return {
        content: liveContentRef.current,
        contentText: liveContentTextRef.current,
      };
    },
    isReady: () => true,
    appendMarkdown: () => false,
  }), [blocks, commitBlocks]);

  const displayPlainText = useMemo(
    () => liveContentTextRef.current || (blocks.length > 0 ? serializeBlocksToPlainText(blocks) : "") || t("markdown.largeDocument.noPlainText"),
    [blocks, t, note.contentText], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const plainLineCount = useMemo(
    () => (viewMode === "plain" ? splitPlainTextLines(displayPlainText).length : 0),
    [displayPlainText, viewMode],
  );

  const isVirtualRichActive = viewMode === "rich" && initialParsed !== null;
  const activeMatchBlockIndex = matchingIndices[activeMatchCursor] ?? -1;

  const handleCopyAll = () => {
    void navigator.clipboard?.writeText(displayPlainText).then(() => {
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 1600);
    }).catch(() => {});
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg">
      {/* 顶部轻量化状态与控制条 */}
      <div
        className={cn(
          "border-b px-4 py-2.5 md:px-8",
          isVirtualRichActive
            ? "border-indigo-500/20 bg-gradient-to-r from-indigo-500/[0.07] via-app-elevated/90 to-violet-500/[0.06]"
            : "border-amber-400/35 bg-amber-500/10 text-amber-900 dark:text-amber-200",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
              isVirtualRichActive
                ? "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300"
                : "bg-amber-500/15 text-amber-800 dark:text-amber-200",
            )}
          >
            {isVirtualRichActive ? <Sparkles size={12} /> : <AlertTriangle size={12} />}
            <span>
              {isVirtualRichActive
                ? t("markdown.largeDocument.virtualRichTextMode")
                : t("markdown.largeDocument.virtualPlainTextMode")}
            </span>
          </span>

          <span className="rounded-full border border-app-border/70 bg-app-surface/80 px-2 py-0.5 font-mono text-[11px] font-medium text-tx-secondary">
            {formatEditorByteSize(profile?.bytes ?? liveContentRef.current.length)}
          </span>

          {isVirtualRichActive ? (
            <span className="rounded-full border border-app-border/70 bg-app-surface/80 px-2 py-0.5 text-[11px] text-tx-secondary">
              {t("markdown.largeDocument.blocksCount", {
                value: numberFormatter.format(blocks.length),
              })}
            </span>
          ) : (
            <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[11px]">
              {t("markdown.largeDocument.linesCount", {
                value: numberFormatter.format(plainLineCount),
              })}
            </span>
          )}

          {/* 右侧工具：视图切换 + 站内搜索 + 拆分长文档 */}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <div className="relative flex items-center">
              <Search size={12} className="pointer-events-none absolute left-2.5 text-tx-tertiary" />
              <input
                type="text"
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    jumpMatch(e.shiftKey ? -1 : 1);
                  }
                }}
                placeholder={t("markdown.largeDocument.searchPlaceholder")}
                className="h-7 w-40 rounded-xl border border-app-border/80 bg-app-surface/90 pl-7 pr-6 text-xs text-tx-primary outline-none transition focus:w-52 focus:border-accent-primary/60 sm:w-44"
              />
              {localSearch && (
                <button
                  type="button"
                  onClick={() => setLocalSearch("")}
                  className="absolute right-1.5 rounded p-0.5 text-tx-tertiary hover:text-tx-primary"
                  aria-label="清空搜索"
                >
                  <X size={11} />
                </button>
              )}
            </div>

            {isVirtualRichActive && localSearch.trim() && (
              <div className="inline-flex items-center gap-0.5 rounded-xl border border-app-border/70 bg-app-surface px-1.5 py-0.5 text-[11px] tabular-nums text-tx-secondary">
                <span>
                  {matchingIndices.length > 0 ? `${activeMatchCursor + 1}/${matchingIndices.length}` : "0/0"}
                </span>
                <button type="button" onClick={() => jumpMatch(-1)} disabled={matchingIndices.length === 0} className="rounded p-0.5 hover:bg-app-hover disabled:opacity-40"><ChevronUp size={12} /></button>
                <button type="button" onClick={() => jumpMatch(1)} disabled={matchingIndices.length === 0} className="rounded p-0.5 hover:bg-app-hover disabled:opacity-40"><ChevronDown size={12} /></button>
              </div>
            )}

            {initialParsed && (
              <div className="inline-flex items-center rounded-xl border border-app-border/80 bg-app-surface p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setViewMode("rich")}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium transition-colors",
                    viewMode === "rich"
                      ? "bg-app-elevated text-accent-primary shadow-2xs"
                      : "text-tx-secondary hover:text-tx-primary",
                  )}
                >
                  <Layers size={11} />
                  {t("markdown.largeDocument.richViewTab")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingSection(null);
                    setViewMode("plain");
                  }}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium transition-colors",
                    viewMode === "plain"
                      ? "bg-app-elevated text-accent-primary shadow-2xs"
                      : "text-tx-secondary hover:text-tx-primary",
                  )}
                >
                  <FileText size={11} />
                  {t("markdown.largeDocument.plainTextViewTab")}
                </button>
              </div>
            )}

            {canSplitDocument && onSplitDocument && (
              <button
                type="button"
                onClick={onSplitDocument}
                className="inline-flex h-7 shrink-0 whitespace-nowrap items-center gap-1 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-2.5 text-[11px] font-semibold text-indigo-700 transition-colors hover:bg-indigo-500/15 dark:text-indigo-300"
              >
                <Scissors size={11} />
                {t("markdown.largeDocument.splitDocument")}
              </button>
            )}

            {!isVirtualRichActive && (
              <button
                type="button"
                onClick={handleCopyAll}
                className="inline-flex h-7 shrink-0 whitespace-nowrap items-center gap-1 rounded-xl border border-app-border/80 bg-app-surface px-2.5 text-[11px] font-medium text-tx-primary hover:bg-app-hover"
              >
                {copiedAll ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                {copiedAll ? t("markdown.largeDocument.copied") : t("markdown.largeDocument.copyAll")}
              </button>
            )}
          </div>
        </div>

        <p className="mt-1 text-[11px] leading-relaxed text-tx-secondary">
          {isVirtualRichActive
            ? t("markdown.largeDocument.virtualRichTextModeDesc")
            : t("markdown.largeDocument.virtualPlainTextModeDesc")}
          {!isVirtualRichActive && decision?.reasons.length ? (
            <span className="ml-2 opacity-80">
              （{decision.reasons.map((reason) => t(REASON_KEYS[reason])).join(" · ")}）
            </span>
          ) : null}
        </p>
      </div>

      {/* 标题与标签 */}
      <div className="px-4 pb-2 pt-4 md:px-8 md:pt-5">
        <input
          value={title}
          readOnly={!canEdit || !isVirtualRichActive}
          onChange={(e) => handleTitleChange(e.target.value)}
          spellCheck={false}
          className="w-full bg-transparent text-2xl font-bold text-tx-primary outline-none md:text-3xl"
          aria-label={t("tiptap.titlePlaceholder")}
        />
        {!!note.tags?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {note.tags.map((tag) => (
              <span
                key={tag.id}
                className="rounded-full border border-app-border bg-app-surface px-2 py-0.5 text-[11px] text-tx-secondary"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 主体：Tier 2 虚拟富文本块 + 单章原地编辑 / Tier 3 真虚拟纯文本 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {isVirtualRichActive ? (
          <div
            ref={scrollRef}
            data-virtual-rich-text-viewport="true"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            className="min-h-0 flex-1 overflow-y-auto px-4 pb-2 md:px-8"
          >
            <div className="pb-24" style={{ minHeight: virtualWindow.totalHeight, position: "relative" }}>
              <div style={{ transform: `translateY(${virtualWindow.offsetTop}px)` }}>
                {blocks.slice(virtualWindow.startIndex, virtualWindow.endIndex).map((block, offsetIdx) => {
                  const blockIndex = virtualWindow.startIndex + offsetIdx;

                  if (
                    editingSection
                    && blockIndex >= editingSection.startBlock
                    && blockIndex < editingSection.endBlock
                  ) {
                    if (blockIndex !== editingSection.startBlock) return null;
                    return (
                      <VirtualRichTextSectionEditor
                        key={editingSection.id}
                        section={editingSection}
                        blocks={blocks.slice(editingSection.startBlock, editingSection.endBlock)}
                        onSave={handleSaveSection}
                        onCancel={() => {
                          sectionDirtyRef.current = { dirty: false, section: null, getSnapshot: () => null };
                          setEditingSection(null);
                        }}
                        onDirtyChange={(dirty, getSnapshot) => {
                          sectionDirtyRef.current = {
                            dirty,
                            section: editingSection,
                            getSnapshot,
                          };
                        }}
                      />
                    );
                  }

                  return (
                    <VirtualRichTextBlock
                      key={typeof block.attrs?.blockId === "string" ? block.attrs.blockId : `blk-${blockIndex}`}
                      block={block}
                      blockIndex={blockIndex}
                      highlightQuery={localSearch}
                      isActiveMatch={blockIndex === activeMatchBlockIndex}
                      canEdit={canEdit}
                      onEditBlock={handleEditBlock}
                      onToggleTask={handleToggleTask}
                      onHeightMeasured={handleHeightMeasured}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-2 md:px-8">
            <VirtualPlainTextViewport
              text={displayPlainText}
              searchQuery={localSearch}
              ariaLabel={t("markdown.largeDocument.plainTextViewer")}
              onJumpReady={(jump) => { plainJumpRef.current = jump; }}
            />
          </div>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex flex-wrap items-center gap-3 border-t border-app-border/60 px-4 py-1.5 text-[11px] text-tx-tertiary md:px-8">
        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <ShieldCheck size={12} />
          {t("markdown.largeDocument.originalProtected")}
        </span>
        <span className="opacity-50">·</span>
        <span>
          {originalFormat}
        </span>
        <span className="opacity-50">·</span>
        <span>
          {t("markdown.largeDocument.charactersCount", {
            value: numberFormatter.format(displayPlainText.length),
          })}
        </span>
        <span className="ml-auto opacity-75">
          {isVirtualRichActive
            ? `${virtualWindow.endIndex - virtualWindow.startIndex} / ${blocks.length} DOM`
            : t("markdown.largeDocument.copyAvailable")}
        </span>
      </div>
    </div>
  );
});

LargeRichTextSafeViewer.displayName = "LargeRichTextSafeViewer";

export default LargeRichTextSafeViewer;
