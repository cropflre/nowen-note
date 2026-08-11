import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ClipboardPlus, Inbox, Loader2, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { parseTaskQuickAdd } from "./taskSmartRecognition";
import {
  captureTaskToInbox,
  publishTaskInboxChanged,
  type TaskCaptureSourceType,
} from "@/lib/taskInboxApi";

interface CaptureSnapshot {
  text: string;
  sourceType: TaskCaptureSourceType;
  sourceId: string | null;
  sourceTitle: string | null;
  noteId: string | null;
}

interface OpenCaptureDetail {
  text?: string;
  sourceType?: TaskCaptureSourceType;
  sourceId?: string | null;
  sourceTitle?: string | null;
  noteId?: string | null;
}

function selectedTextFromTarget(target: EventTarget | null): string {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (end > start) return target.value.slice(start, end).trim();
  }
  return window.getSelection()?.toString().trim() || "";
}

function inferSource(target: EventTarget | null, text: string): CaptureSnapshot {
  const element = target instanceof Element ? target : null;
  const sourceRoot = element?.closest<HTMLElement>(
    "[data-task-capture-source], [data-note-id], [data-diary-id], .tiptap, .cm-editor, [contenteditable='true']",
  );
  const explicitType = sourceRoot?.dataset.taskCaptureSource as TaskCaptureSourceType | undefined;
  const noteId = sourceRoot?.dataset.noteId || null;
  const diaryId = sourceRoot?.dataset.diaryId || null;
  const route = window.location.pathname;
  let sourceType: TaskCaptureSourceType = explicitType || "global";

  if (!explicitType) {
    if (noteId || sourceRoot?.matches(".tiptap, .cm-editor, [contenteditable='true']")) sourceType = "note";
    else if (diaryId) sourceType = "diary";
    else if (route.startsWith("/share/")) sourceType = "share";
    else if (text) sourceType = "selection";
  }

  return {
    text,
    sourceType,
    sourceId: noteId || diaryId || route || null,
    sourceTitle: sourceRoot?.dataset.taskCaptureTitle || document.title || null,
    noteId,
  };
}

function titleFromText(text: string): string {
  return (
    text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ""
  ).slice(0, 180);
}

export default function TaskQuickCaptureBridge() {
  const { i18n } = useTranslation();
  const chinese = i18n.language.toLowerCase().startsWith("zh");
  const lastSelectionRef = useRef<CaptureSnapshot>({
    text: "",
    sourceType: "global",
    sourceId: null,
    sourceTitle: null,
    noteId: null,
  });
  const titleRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(2);
  const [source, setSource] = useState<CaptureSnapshot>(lastSelectionRef.current);
  const [saving, setSaving] = useState(false);
  const [keepOpen, setKeepOpen] = useState(false);

  const labels = useMemo(() => chinese ? {
    title: "快速捕获到收集箱",
    subtitle: "先记下来，稍后再整理项目、日期和执行计划",
    taskTitle: "任务",
    taskPlaceholder: "输入待办，支持“明天晚上8点”等智能日期语法",
    description: "补充说明",
    descriptionPlaceholder: "可选：上下文、下一步或原文摘录",
    source: "来源",
    priority: "优先级",
    low: "低",
    medium: "中",
    high: "高",
    keepOpen: "保存后继续捕获",
    save: "加入收集箱",
    saved: "已加入收集箱",
    failed: "捕获任务失败",
    selected: "已带入选中文本",
    shortcut: "Ctrl/⌘ + Shift + A",
  } : {
    title: "Quick capture to Inbox",
    subtitle: "Capture now, organize projects and dates later",
    taskTitle: "Task",
    taskPlaceholder: "Type a task; smart date phrases such as tomorrow 8pm are supported",
    description: "Details",
    descriptionPlaceholder: "Optional context, next action or source excerpt",
    source: "Source",
    priority: "Priority",
    low: "Low",
    medium: "Medium",
    high: "High",
    keepOpen: "Keep capturing after save",
    save: "Add to Inbox",
    saved: "Added to Inbox",
    failed: "Failed to capture task",
    selected: "Selected text included",
    shortcut: "Ctrl/⌘ + Shift + A",
  }, [chinese]);

  const openDialog = useCallback((detail?: OpenCaptureDetail) => {
    const fallback = lastSelectionRef.current;
    const text = (detail?.text ?? fallback.text).trim();
    const snapshot: CaptureSnapshot = {
      text,
      sourceType: detail?.sourceType || fallback.sourceType || (text ? "selection" : "global"),
      sourceId: detail?.sourceId ?? fallback.sourceId,
      sourceTitle: detail?.sourceTitle ?? fallback.sourceTitle,
      noteId: detail?.noteId ?? fallback.noteId,
    };
    setSource(snapshot);
    setTitle(titleFromText(text));
    setDescription(text.length > 180 || text.includes("\n") ? text : "");
    setPriority(2);
    setOpen(true);
    requestAnimationFrame(() => titleRef.current?.focus());
  }, []);

  useEffect(() => {
    const rememberSelection = (event: Event) => {
      const text = selectedTextFromTarget(event.target);
      if (!text) return;
      lastSelectionRef.current = inferSource(event.target, text.slice(0, 8_000));
    };
    document.addEventListener("selectionchange", rememberSelection);
    document.addEventListener("select", rememberSelection, true);
    document.addEventListener("mouseup", rememberSelection, true);
    document.addEventListener("keyup", rememberSelection, true);
    return () => {
      document.removeEventListener("selectionchange", rememberSelection);
      document.removeEventListener("select", rememberSelection, true);
      document.removeEventListener("mouseup", rememberSelection, true);
      document.removeEventListener("keyup", rememberSelection, true);
    };
  }, []);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      openDialog((event as CustomEvent<OpenCaptureDetail | undefined>).detail);
    };
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "a") {
        if (!localStorage.getItem("nowen-token")) return;
        event.preventDefault();
        openDialog();
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("nowen:open-task-capture", handleOpen);
    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("nowen:open-task-capture", handleOpen);
      window.removeEventListener("keydown", handleShortcut);
    };
  }, [open, openDialog]);

  const recognition = useMemo(() => parseTaskQuickAdd(title), [title]);
  const recognizedLabels = useMemo(() => recognition.recognizedRanges
    .map((range) => title.slice(range.start, range.end).trim())
    .filter(Boolean), [recognition.recognizedRanges, title]);

  const save = async () => {
    const rawTitle = title.trim();
    if (!rawTitle || saving) return;
    const parsed = parseTaskQuickAdd(rawTitle);
    const patch = parsed.taskPatch as {
      priority?: number;
      dueDate?: string | null;
      dueAt?: string | null;
      startDate?: string | null;
      repeatRule?: string;
    };
    const supportsCleanTitle = !patch.repeatRule || patch.repeatRule === "none";
    setSaving(true);
    try {
      const result = await captureTaskToInbox({
        title: supportsCleanTitle ? (parsed.cleanTitle || rawTitle) : rawTitle,
        description,
        priority: patch.priority || priority,
        dueDate: patch.dueDate,
        dueAt: patch.dueAt,
        startDate: patch.startDate,
        noteId: source.noteId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceTitle: source.sourceTitle,
        excerpt: source.text,
      });
      if (supportsCleanTitle && parsed.reminderOffsets.length) {
        await Promise.all(parsed.reminderOffsets.map((offset) =>
          api.createTaskReminder(result.task.id, offset).catch(() => null),
        ));
      }
      publishTaskInboxChanged({ taskId: result.task.id, count: result.count });
      toast.success(labels.saved);
      if (keepOpen) {
        setTitle("");
        setDescription("");
        setSource({
          text: "",
          sourceType: "global",
          sourceId: window.location.pathname || null,
          sourceTitle: document.title || null,
          noteId: null,
        });
        requestAnimationFrame(() => titleRef.current?.focus());
      } else {
        setOpen(false);
      }
    } catch (error) {
      console.error("[TaskQuickCapture] capture failed", error);
      toast.error(labels.failed);
    } finally {
      setSaving(false);
    }
  };

  const sourceLabel = source.sourceTitle
    || (source.sourceType === "note" ? (chinese ? "当前笔记" : "Current note")
      : source.sourceType === "diary" ? (chinese ? "当前说说" : "Current diary")
        : source.sourceType === "selection" ? (chinese ? "页面选中文本" : "Page selection")
          : (chinese ? "全局快速捕获" : "Global quick capture"));

  const dialog = open ? createPortal(
    <div
      className="fixed inset-0 z-[260] flex items-center justify-center bg-black/45 px-4 py-8 backdrop-blur-sm"
      data-swipe-blocker=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl">
        <div className="flex items-start gap-3 border-b border-app-border px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary/12 text-accent-primary">
            <Inbox size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-tx-primary">{labels.title}</h2>
            <p className="mt-0.5 text-xs text-tx-tertiary">{labels.subtitle}</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary">
            <X size={17} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-tx-secondary">{labels.taskTitle}</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void save();
              }}
              placeholder={labels.taskPlaceholder}
              className="w-full rounded-xl border border-app-border bg-app-bg px-3.5 py-3 text-sm text-tx-primary outline-none transition-colors placeholder:text-tx-tertiary focus:border-accent-primary"
            />
          </label>

          {(recognizedLabels.length > 0 || source.text) && (
            <div className="flex flex-wrap gap-1.5">
              {source.text && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                  <ClipboardPlus size={11} /> {labels.selected}
                </span>
              )}
              {recognizedLabels.map((token, index) => (
                <span key={`${token}-${index}`} className="rounded-full bg-accent-primary/10 px-2 py-1 text-[11px] text-accent-primary">
                  {token}
                </span>
              ))}
            </div>
          )}

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-tx-secondary">{labels.description}</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={labels.descriptionPlaceholder}
              rows={5}
              className="w-full resize-y rounded-xl border border-app-border bg-app-bg px-3.5 py-3 text-sm leading-6 text-tx-primary outline-none transition-colors placeholder:text-tx-tertiary focus:border-accent-primary"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-tx-secondary">{labels.source}</span>
              <div className="truncate rounded-lg border border-app-border bg-app-bg px-3 py-2 text-xs text-tx-tertiary" title={sourceLabel}>
                {sourceLabel}
              </div>
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-tx-secondary">{labels.priority}</span>
              <div className="flex rounded-lg border border-app-border bg-app-bg p-1">
                {[
                  { value: 1, label: labels.low },
                  { value: 2, label: labels.medium },
                  { value: 3, label: labels.high },
                ].map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setPriority(item.value)}
                    className={cn(
                      "rounded-md px-2.5 py-1.5 text-xs transition-colors",
                      priority === item.value
                        ? "bg-accent-primary text-white"
                        : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-app-border px-5 py-3.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-tx-tertiary">
            <button
              type="button"
              onClick={() => setKeepOpen((value) => !value)}
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded border",
                keepOpen ? "border-accent-primary bg-accent-primary text-white" : "border-app-border bg-app-bg",
              )}
            >
              {keepOpen && <Check size={11} />}
            </button>
            {labels.keepOpen}
          </label>
          <div className="flex items-center gap-3">
            <span className="hidden text-[10px] text-tx-tertiary sm:inline">{labels.shortcut}</span>
            <button
              type="button"
              disabled={!title.trim() || saving}
              onClick={() => void save()}
              className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              {labels.save}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return dialog;
}
