import React, { useState, useRef, useCallback } from "react";
import { Plus, X, ImagePlus, Loader2, CalendarDays, Clock, Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import type { TaskQuickAddRecognizedRange } from "./taskSmartRecognition";
import type { Task } from "@/types";
import { getDateValue, getDueTimeValue } from "./taskDateUtils";
import { resolveTaskQuickAddDraft, type TaskQuickAddManualMeta } from "./taskQuickAddDraft";

// 与现有提醒接口的提前一年上限保持一致。
const MAX_REMINDER_OFFSET_MINUTES = 60 * 24 * 365;

/** 素朴的 URL 检测：用于 onPaste 时判断是否要转 markdown 链接。 */
function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/** 把 URL 截成 hostname；解析失败时返回截短的原串，避免抛异常打破 UI。 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.length > 24 ? url.slice(0, 24) + "…" : url;
  }
}

function buildRecognizedPreviewParts(value: string, ranges: TaskQuickAddRecognizedRange[]) {
  const parts: Array<{ text: string; recognized: boolean; key: string }> = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    const start = Math.max(0, Math.min(value.length, range.start));
    const end = Math.max(start, Math.min(value.length, range.end));
    if (start > cursor) {
      parts.push({ text: value.slice(cursor, start), recognized: false, key: `plain-${index}` });
    }
    if (end > start) {
      parts.push({ text: value.slice(start, end), recognized: true, key: `recognized-${index}` });
    }
    cursor = Math.max(cursor, end);
  });
  if (cursor < value.length) {
    parts.push({ text: value.slice(cursor), recognized: false, key: "plain-tail" });
  }
  return parts;
}

/* ===========================================================================
 * 新建任务输入区组件
 * ---------------------------------------------------------------------------
 * - 单行 <input> + 上传按钮 + 已上传图片缩略图条
 * - 粘贴：
 *     * clipboard 中含 image/* → 自动调用 task-attachments.upload，把
 *       返回的 url 拼成 `![filename](url)` 追加到 title。
 *     * clipboard 中是 http(s) URL 文本 → 自动包成 `[hostname](url)`
 *       插入到光标处，让标题保持紧凑。
 * - 上传按钮：触发隐藏的 <input type=file>，多选支持。
 * ========================================================================= */
export function TaskQuickAdd({
  value,
  onChange,
  onSubmit,
  inputRef,
  defaults = {},
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (orphanIds: string[], manual: TaskQuickAddManualMeta) => Promise<boolean>;
  defaults?: Partial<Task>;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // 拖拽态：把整条输入框做成 dropzone，与 onPaste 粘贴图片体验对齐。
  // 用 counter 处理 enter/leave 的子节点冒泡（缩略图、按钮等）抖动问题。
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  // 已上传但还未与任务绑定的"孤儿附件 id" — 用于：
  //   1) 在输入框旁渲染缩略图供用户预览/移除；
  //   2) 提交任务后调用 bind 把它们绑回新创建的 task。
  const [orphans, setOrphans] = useState<{ id: string; url: string; filename: string }[]>([]);
  const [manualMeta, setManualMeta] = useState<TaskQuickAddManualMeta>({});
  const [metaPanel, setMetaPanel] = useState<"deadline" | "reminder" | null>(null);
  const [customMinutes, setCustomMinutes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitPending = useRef(false);
  const quickAddPreview = resolveTaskQuickAddDraft(value, defaults, manualMeta);
  const dueDate = getDateValue(quickAddPreview.taskPatch.dueDate || quickAddPreview.taskPatch.dueAt);
  const dueTime = getDueTimeValue(quickAddPreview.taskPatch.dueAt);
  const reminderOffsets = quickAddPreview.reminderOffsets;
  const reminderLabel = (offset: number) => {
    if (offset === 0) return t("tasks.reminder.atDue");
    if (offset === 60) return t("tasks.reminder.before1hour");
    if (offset === 1440) return t("tasks.reminder.before1day");
    return t("tasks.reminder.customMinutes", { count: offset });
  };
  const reminderOptions = [...new Set([0, 10, 30, 60, 1440, ...reminderOffsets])].sort((a, b) => a - b);
  const customOffset = Number(customMinutes);
  const canAddCustom = customMinutes.trim() !== "" && Number.isInteger(customOffset)
    && customOffset > 0 && customOffset <= MAX_REMINDER_OFFSET_MINUTES;
  const toggleReminder = (offset: number) => {
    setManualMeta((prev) => ({
      ...prev,
      reminderOffsets: reminderOffsets.includes(offset)
        ? reminderOffsets.filter((item) => item !== offset)
        : [...reminderOffsets, offset],
    }));
  };
  const togglePanel = (panel: "deadline" | "reminder") => setMetaPanel((prev) => prev === panel ? null : panel);
  const chipClass = "flex items-center gap-1.5 rounded-md border border-app-border px-2 py-1 text-xs text-tx-secondary hover:bg-app-hover disabled:opacity-40";
  const fieldClass = "rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-xs text-tx-primary outline-none focus:border-accent-primary";
  const recognizedRanges = quickAddPreview.recognizedRanges;
  const hasRecognizedRanges = value.length > 0 && recognizedRanges.length > 0;
  const recognizedPreviewParts = hasRecognizedRanges
    ? buildRecognizedPreviewParts(value, recognizedRanges)
    : [];

  // 把附件 markdown 插入到 input 当前光标处；如果焦点不在 input，就追加到末尾。
  const insertAtCaret = (snippet: string) => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) {
      onChange((value ? value + " " : "") + snippet);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + snippet + value.slice(end);
    onChange(next);
    // 光标移到插入片段之后
    requestAnimationFrame(() => {
      const pos = start + snippet.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        if (!f.type.startsWith("image/")) {
          toast.error(t('tasks.imageInvalidType'));
          continue;
        }
        if (f.size > 50 * 1024 * 1024) {
          toast.error(t('tasks.imageTooLarge'));
          continue;
        }
        try {
          const res = await api.taskAttachments.upload(f);
          insertAtCaret(`![${res.filename}](${res.url})`);
          setOrphans((prev) => [...prev, { id: res.id, url: res.url, filename: res.filename }]);
        } catch (e: any) {
          toast.error(e?.message || t('tasks.uploadFailed'));
        }
      }
    } finally {
      setUploading(false);
    }
  }, [t, value]);

  // 提交：交还给父组件创建任务（附带 orphan ids），成功后清空本地预览
  const handleSubmit = async () => {
    if (!value.trim()) return;
    if (uploading || submitPending.current) return;
    submitPending.current = true;
    setSubmitting(true);
    try {
      const ok = await onSubmit(orphans.map((o) => o.id), manualMeta);
      if (ok) {
        setOrphans([]);
        setManualMeta({});
        setMetaPanel(null);
        setCustomMinutes("");
        if (fileRef.current) fileRef.current.value = "";
      }
    } finally {
      submitPending.current = false;
      setSubmitting(false);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
    // 1) 优先处理图片
    const imgFiles: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) imgFiles.push(f);
      }
    }
    if (imgFiles.length) {
      e.preventDefault();
      await uploadFiles(imgFiles);
      return;
    }
    // 2) 没有图片时检查纯文本是否是 URL — 是就转成 markdown 链接，
    //    避免长 URL 撑破列表。
    const text = e.clipboardData.getData("text/plain");
    if (text && isHttpUrl(text)) {
      e.preventDefault();
      insertAtCaret(`[${hostnameOf(text.trim())}](${text.trim()})`);
    }
  };

  const removeOrphan = async (id: string) => {
    // 同步删后端文件 + 行；同时把 title 里的对应 markdown 移除。
    try {
      await api.taskAttachments.remove(id);
    } catch {
      /* 删失败不阻塞 UI；后台清理脚本会兜底 */
    }
    setOrphans((prev) => prev.filter((o) => o.id !== id));
    // 移除 title 里 ![...](url-with-id)
    const re = new RegExp(`!\\[[^\\]]*\\]\\(/api/task-attachments/${id}\\)\\s?`, "g");
    onChange(value.replace(re, ""));
  };

  return (
    <div
      data-task-quick-add=""
      className={cn(
        "rounded-xl border px-3 py-3 transition-all md:px-4",
        dragOver
          ? "border-accent-primary bg-accent-primary/10 ring-2 ring-accent-primary/20"
          : "border-accent-primary/20 bg-accent-primary/[0.035] hover:border-accent-primary/35 focus-within:border-accent-primary/45 focus-within:ring-2 focus-within:ring-accent-primary/10",
      )}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragCounter.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        dragCounter.current--;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files || []).filter(
          (f) => f.type.startsWith("image/"),
        );
        if (files.length > 0) void uploadFiles(files);
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-primary/12 text-accent-primary">
            <Plus size={15} strokeWidth={2.2} />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-tx-primary">
              {t("tasks.newTask", { defaultValue: "新建任务" })}
            </div>
            <div className="hidden text-[11px] text-tx-tertiary sm:block">
              {t("tasks.newTaskHint", { defaultValue: "输入任务内容，按 Enter 快速创建" })}
            </div>
          </div>
        </div>
        <span className="hidden shrink-0 rounded-md border border-app-border bg-app-bg px-1.5 py-0.5 text-[10px] text-tx-tertiary md:inline-flex">
          Enter
        </span>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-app-border bg-app-bg px-3 py-2 shadow-sm transition-colors focus-within:border-accent-primary/55">
        <div className="relative min-w-0 flex-1">
          {hasRecognizedRanges && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-sm text-tx-primary"
            >
              {recognizedPreviewParts.map((part) => (
                <span
                  key={part.key}
                  data-recognized-token={part.recognized ? "true" : undefined}
                  className={part.recognized ? "text-accent-primary font-medium" : undefined}
                >
                  {part.text}
                </span>
              ))}
            </div>
          )}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleSubmit(); } }}
            onPaste={handlePaste}
            placeholder={t('tasks.addTaskPlaceholder')}
            aria-label={t("tasks.newTask", { defaultValue: "新建任务" })}
            className={cn(
              "relative z-10 w-full bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none",
              hasRecognizedRanges && "text-transparent caret-tx-primary",
            )}
          />
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title={t('tasks.insertImage')}
          className="flex-shrink-0 rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-accent-primary disabled:opacity-50"
        >
          {uploading
            ? <Loader2 size={16} className="animate-spin" />
            : <ImagePlus size={16} />}
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          aria-label={t("tasks.add")}
          disabled={!value.trim() || uploading || submitting}
          className="flex-shrink-0 rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {t('tasks.add')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            uploadFiles(files);
            e.target.value = ""; // 允许重选同一文件
          }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={chipClass} onClick={() => togglePanel("deadline")} aria-expanded={metaPanel === "deadline"}>
          <CalendarDays size={13} />{dueDate || t("tasks.dueDate")}
        </button>
        <button type="button" className={chipClass} onClick={() => togglePanel("deadline")} aria-expanded={metaPanel === "deadline"}>
          <Clock size={13} />{dueTime || t("tasks.dueAt")}
        </button>
        <button type="button" className={cn(chipClass, "max-w-full")} onClick={() => togglePanel("reminder")} aria-expanded={metaPanel === "reminder"}>
          <Bell size={13} className="shrink-0" /><span className="truncate">{reminderOffsets.length ? reminderOffsets.map(reminderLabel).join(" · ") : t("tasks.reminder.title")}</span>
        </button>
      </div>
      {metaPanel === "deadline" && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-app-border bg-app-bg p-2">
          <label className="flex flex-col gap-1 text-xs text-tx-secondary">
            {t("tasks.dueDate")}
            <input type="date" aria-label={t("tasks.dueDate")} className={fieldClass} value={dueDate}
              onChange={(e) => setManualMeta((prev) => ({ ...prev, dueDate: e.target.value || null }))} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-tx-secondary">
            {t("tasks.dueAt")}
            <input type="time" aria-label={t("tasks.dueAt")} className={fieldClass} value={dueTime} disabled={!dueDate}
              onChange={(e) => setManualMeta((prev) => ({ ...prev, dueTime: e.target.value || null }))} />
          </label>
          <button type="button" className={chipClass} onClick={() => setManualMeta((prev) => ({ ...prev, dueDate: null, dueTime: null, reminderOffsets: [] }))}>
            {t("tasks.quickAdd.clearDeadline")}
          </button>
        </div>
      )}
      {metaPanel === "reminder" && (
        <div className="mt-2 space-y-2 rounded-lg border border-app-border bg-app-bg p-2">
          {!dueDate && <p className="text-xs text-tx-tertiary">{t("tasks.reminder.needDueDate")}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {reminderOptions.map((offset) => (
              <label key={offset} className="flex items-center gap-1 text-xs text-tx-secondary">
                <input type="checkbox" disabled={!dueDate} checked={reminderOffsets.includes(offset)} onChange={() => toggleReminder(offset)} />
                {reminderLabel(offset)}
              </label>
            ))}
            <button type="button" className={chipClass} onClick={() => setManualMeta((prev) => ({ ...prev, reminderOffsets: [] }))}>
              {t("tasks.quickAdd.noReminder")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-tx-secondary">
              {t("tasks.quickAdd.customReminder")}
              <input type="number" min="1" max={MAX_REMINDER_OFFSET_MINUTES} step="1" disabled={!dueDate} aria-label={t("tasks.quickAdd.customReminder")}
                className={cn(fieldClass, "w-20")} value={customMinutes} onChange={(e) => setCustomMinutes(e.target.value)} />
              {t("tasks.reminder.minutesUnit")}
            </label>
            <button type="button" disabled={!dueDate || !canAddCustom || reminderOffsets.includes(customOffset)} className={chipClass}
              onClick={() => { toggleReminder(customOffset); setCustomMinutes(""); }}>
              {t("tasks.reminder.addCustom")}
            </button>
          </div>
        </div>
      )}

      {/* 已上传图片缩略图条 — 仅在有孤儿时渲染，不占位 */}
      {orphans.length > 0 && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {orphans.map((o) => (
            <div key={o.id} className="relative group">
              <img
                src={o.url}
                alt={o.filename}
                className="w-12 h-12 rounded object-cover border border-app-border"
              />
              <button
                type="button"
                onClick={() => removeOrphan(o.id)}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-app-bg border border-app-border text-tx-secondary hover:text-accent-danger hover:border-accent-danger flex items-center justify-center transition-colors"
                title={t('common.delete')}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
