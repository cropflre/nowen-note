import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckSquare, FileText, Loader2, RotateCcw, Scissors, Square, X } from "lucide-react";

import { api } from "@/lib/api";
import {
  NoteSplitRequestError,
  splitMarkdownNote,
  undoMarkdownNoteSplit,
  type SplitNoteResult,
} from "@/lib/noteSplitApi";
import {
  buildMarkdownSplitPreview,
  type NoteSplitHeadingLevel,
} from "@/lib/noteSplit";
import { buildTiptapSplitPreview } from "@/lib/tiptapNoteSplit";
import { cn } from "@/lib/utils";
import type { Note, Notebook } from "@/types";

interface NoteSplitDialogProps {
  open: boolean;
  note: Note;
  notebooks: Notebook[];
  preferredLevel: NoteSplitHeadingLevel;
  onClose: () => void;
  onApplied: (note: Note) => void;
}

function flattenNotebooks(items: Notebook[], depth = 0): Array<Notebook & { depth: number }> {
  const result: Array<Notebook & { depth: number }> = [];
  for (const item of items) {
    result.push({ ...item, depth });
    if (item.children?.length) result.push(...flattenNotebooks(item.children, depth + 1));
  }
  return result;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export default function NoteSplitDialog({
  open,
  note,
  notebooks,
  preferredLevel,
  onClose,
  onApplied,
}: NoteSplitDialogProps) {
  const [freshNote, setFreshNote] = useState<Note | null>(null);
  const [headingLevel, setHeadingLevel] = useState<NoteSplitHeadingLevel>(preferredLevel);
  const [preservePreamble, setPreservePreamble] = useState(true);
  const [targetNotebookId, setTargetNotebookId] = useState(note.notebookId);
  const [selectedSectionIndexes, setSelectedSectionIndexes] = useState<number[]>([]);
  const [blockLinkRiskCount, setBlockLinkRiskCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SplitNoteResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setFreshNote(null);
    setHeadingLevel(preferredLevel);
    setPreservePreamble(true);
    setTargetNotebookId(note.notebookId);
    setSelectedSectionIndexes([]);
    setBlockLinkRiskCount(0);

    // EditorPane already listens to this event and flushes the active editor immediately.
    window.dispatchEvent(new CustomEvent("nowen:before-note-switch"));
    void wait(180)
      .then(() => api.getNote(note.id))
      .then((latest) => {
        if (cancelled) return;
        if (latest.contentFormat !== "markdown" && latest.contentFormat !== "tiptap-json") {
          throw new Error("当前笔记格式不支持按标题拆分");
        }
        setFreshNote(latest);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取最新笔记内容");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [note.id, note.notebookId, open, preferredLevel]);

  const previews = useMemo(() => {
    const content = freshNote?.content || "";
    const build = freshNote?.contentFormat === "tiptap-json"
      ? buildTiptapSplitPreview
      : buildMarkdownSplitPreview;
    return {
      1: build(content, 1),
      2: build(content, 2),
    };
  }, [freshNote?.content, freshNote?.contentFormat]);
  const preview = previews[headingLevel];

  // A heading-level switch means a different coordinate system. Select all valid sections again
  // instead of carrying stale H1 indexes into an H2 request.
  useEffect(() => {
    setSelectedSectionIndexes(preview.sections.map((section) => section.index));
    setBlockLinkRiskCount(0);
  }, [freshNote?.content, headingLevel]);

  const selectedSet = useMemo(() => new Set(selectedSectionIndexes), [selectedSectionIndexes]);
  const selectedCount = selectedSectionIndexes.length;
  const retainedCount = Math.max(0, preview.sections.length - selectedCount);
  const allSelected = preview.sections.length > 0 && selectedCount === preview.sections.length;
  const isRichText = freshNote?.contentFormat === "tiptap-json";

  const targetNotebooks = useMemo(
    () => flattenNotebooks(notebooks).filter((item) => {
      if ((item.workspaceId || null) !== (note.workspaceId || null)) return false;
      return item.permission !== "read" && item.permission !== "comment";
    }),
    [notebooks, note.workspaceId],
  );

  if (!open) return null;

  const toggleSection = (index: number) => {
    setBlockLinkRiskCount(0);
    setSelectedSectionIndexes((current) => current.includes(index)
      ? current.filter((value) => value !== index)
      : [...current, index].sort((a, b) => a - b));
  };

  const selectAllSections = () => {
    setBlockLinkRiskCount(0);
    setSelectedSectionIndexes(preview.sections.map((section) => section.index));
  };

  const invertSelection = () => {
    setBlockLinkRiskCount(0);
    setSelectedSectionIndexes(
      preview.sections
        .filter((section) => !selectedSet.has(section.index))
        .map((section) => section.index),
    );
  };

  const handleSplit = async () => {
    if (!freshNote || preview.sections.length < 2 || selectedCount === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const splitResult = await splitMarkdownNote(freshNote.id, {
        version: freshNote.version,
        headingLevel,
        sectionIndexes: [...selectedSectionIndexes].sort((a, b) => a - b),
        targetNotebookId: targetNotebookId || freshNote.notebookId,
        preservePreamble,
        acknowledgeBlockLinkRisk: blockLinkRiskCount > 0,
      });
      setResult(splitResult);
      setFreshNote(splitResult.sourceNote);
      setBlockLinkRiskCount(0);
      onApplied(splitResult.sourceNote);
    } catch (reason) {
      if (
        reason instanceof NoteSplitRequestError
        && reason.code === "BLOCK_LINKS_REQUIRE_CONFIRMATION"
        && (reason.blockLinkCount || 0) > 0
      ) {
        setBlockLinkRiskCount(reason.blockLinkCount || 0);
        setError(null);
      } else {
        setError(reason instanceof Error ? reason.message : "拆分失败，原笔记未被修改");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleUndo = async () => {
    if (!result || undoing) return;
    setUndoing(true);
    setError(null);
    try {
      const undone = await undoMarkdownNoteSplit(result.sourceNote.id, result.operationId);
      onApplied(undone.sourceNote);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "撤销失败");
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-3 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-split-title"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-app-border px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
            <Scissors size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="note-split-title" className="truncate text-base font-semibold text-tx-primary">按标题拆分笔记</h2>
            <p className="mt-0.5 text-xs text-tx-tertiary">
              {isRichText ? "富文本按顶层标题切分，嵌套标题不会成为边界。" : "勾选要独立成篇的章节；未选择章节继续保留在原笔记中。"}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover" aria-label="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-tx-tertiary">
              <Loader2 size={17} className="animate-spin" />
              正在保存并读取最新内容…
            </div>
          ) : result ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-emerald-700 dark:text-emerald-300">
                <div className="font-semibold">拆分完成</div>
                <div className="mt-1 text-sm">
                  已创建 {result.createdNotes.length} 篇章节笔记。
                  {result.retainedSectionCount > 0
                    ? `另有 ${result.retainedSectionCount} 个章节继续保留在原笔记中。`
                    : "原笔记已转换为目录页。"}
                </div>
              </div>
              {Boolean(result.blockLinkWarningCount) && (
                <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                  本次拆分包含 {result.blockLinkWarningCount} 个已确认的外部 Block 引用。旧链接仍指向原笔记，后续可从新章节重新复制链接。
                </div>
              )}
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-app-border bg-app-bg/40 p-3">
                {result.createdNotes.map((created, index) => (
                  <div key={created.id} className="flex items-center gap-2 rounded-lg bg-app-surface px-3 py-2 text-sm text-tx-secondary">
                    <span className="w-6 shrink-0 text-right text-xs text-tx-tertiary">{index + 1}</span>
                    <FileText size={14} className="shrink-0 text-accent-primary" />
                    <span className="truncate">{created.title}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                只有原笔记和新章节都未继续编辑、且章节没有新增附件时，才能自动撤销。原始正文始终保存在版本历史和拆分记录中。
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-tx-secondary">拆分层级</label>
                  <div className="flex rounded-lg border border-app-border bg-app-bg p-1">
                    {([1, 2] as const).map((level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() => setHeadingLevel(level)}
                        className={cn(
                          "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                          headingLevel === level
                            ? "bg-accent-primary text-white"
                            : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary",
                        )}
                      >
                        H{level} · {previews[level].sections.length} 节
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-tx-secondary">章节笔记本</label>
                  <select
                    value={targetNotebookId || ""}
                    onChange={(event) => setTargetNotebookId(event.target.value)}
                    className="h-9 w-full rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:border-accent-primary"
                  >
                    {targetNotebooks.map((item) => (
                      <option key={item.id} value={item.id}>{`${"　".repeat(item.depth)}${item.name}`}</option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-app-border bg-app-bg/40 p-3">
                <input
                  type="checkbox"
                  checked={preservePreamble}
                  onChange={(event) => setPreservePreamble(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-tx-secondary">在原笔记中保留首个标题前的前言</span>
                  <span className="mt-0.5 block text-xs text-tx-tertiary">前言不会复制到章节笔记，避免内容重复。</span>
                </span>
              </label>

              {preview.sections.length < 2 ? (
                <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  当前 H{headingLevel} 只有 {preview.sections.length} 个可拆分标题，至少需要两个。
                </div>
              ) : (
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-tx-tertiary">
                    <span>
                      已选择 {selectedCount}/{preview.sections.length} 篇
                      {retainedCount > 0 ? `，保留 ${retainedCount} 篇在原笔记` : "，全部拆分"}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={selectAllSections}
                        disabled={allSelected}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-app-hover disabled:opacity-40"
                      >
                        <CheckSquare size={13} />
                        全选
                      </button>
                      <button
                        type="button"
                        onClick={invertSelection}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-app-hover"
                      >
                        <Square size={13} />
                        反选
                      </button>
                    </div>
                  </div>
                  <div className="max-h-72 space-y-1.5 overflow-y-auto rounded-xl border border-app-border bg-app-bg/40 p-2">
                    {preview.sections.map((section) => {
                      const selected = selectedSet.has(section.index);
                      return (
                        <label
                          key={`${section.index}-${section.sourceStart}`}
                          className={cn(
                            "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-app-hover",
                            selected && "bg-accent-primary/5",
                          )}
                        >
                          <input
                            data-testid={`note-split-section-${section.index}`}
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSection(section.index)}
                            className="shrink-0"
                          />
                          <span className="w-7 shrink-0 text-right text-xs text-tx-tertiary">{section.index + 1}</span>
                          <FileText size={14} className="shrink-0 text-accent-primary" />
                          <span className="min-w-0 flex-1 truncate text-sm text-tx-secondary">{section.title}</span>
                          <span className="shrink-0 text-[11px] text-tx-tertiary">{section.sourceCharacters.toLocaleString()} 字符</span>
                        </label>
                      );
                    })}
                  </div>
                  {selectedCount === 0 && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      请至少选择一个要拆分的章节。
                    </div>
                  )}
                </div>
              )}

              {blockLinkRiskCount > 0 && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">检测到 {blockLinkRiskCount} 个外部 Block 引用</div>
                    <div className="mt-1 text-xs leading-5">
                      所选富文本章节被其他笔记通过块链接引用。拆分后旧链接仍指向原笔记，可能无法定位到已迁移块。再次点击确认表示接受该风险。
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-app-border px-5 py-3">
          {result ? (
            <>
              <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover">完成</button>
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoing}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-500/15 disabled:opacity-50 dark:text-amber-300"
              >
                {undoing ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
                撤销拆分
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover">取消</button>
              <button
                type="button"
                onClick={handleSplit}
                disabled={loading || submitting || !freshNote || preview.sections.length < 2 || selectedCount === 0}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
                  blockLinkRiskCount > 0 ? "bg-amber-600" : "bg-accent-primary",
                )}
              >
                {submitting ? <Loader2 size={15} className="animate-spin" /> : <Scissors size={15} />}
                {blockLinkRiskCount > 0 ? "确认风险并继续" : `拆分所选 ${selectedCount > 0 ? selectedCount : ""} 篇`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
