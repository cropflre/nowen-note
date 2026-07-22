import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  FileArchive,
  FileText,
  FolderTree,
  Hash,
  Loader2,
  PackageCheck,
  Paperclip,
  ShieldCheck,
  Tags,
  X,
} from "lucide-react";
import {
  resolveRoundTripImportReview,
  subscribeRoundTripImportReviews,
  type RoundTripImportReviewRequest,
} from "@/lib/roundTripImportReview";

function isChineseLocale(): boolean {
  if (typeof document === "undefined") return true;
  const lang = document.documentElement.lang || navigator.language || "zh-CN";
  return lang.toLowerCase().startsWith("zh");
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString();
  } catch {
    return value;
  }
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function RoundTripImportReviewDialog({ request }: { request: RoundTripImportReviewRequest }) {
  const zh = isChineseLocale();
  const preview = request.preview;
  const pkg = preview.package || {};
  const counts = pkg.counts || preview.counts || {};
  const formats = pkg.formatStats || {};
  const conflicts = preview.conflicts || [];
  const warnings = preview.warnings || [];
  const errors = preview.errors || [];
  const [submitting, setSubmitting] = useState(false);

  const copy = zh ? {
    title: "导入预检报告",
    subtitle: "正式写入前，请核对目录、附件和重名处理结果",
    packageFile: "数据包",
    target: "导入目标",
    exportedAt: "导出时间",
    protocol: "协议",
    notebooks: "目录",
    notes: "笔记",
    tags: "标签",
    attachments: "附件",
    formatTitle: "内容格式",
    markdown: "Markdown",
    richText: "富文本",
    html: "HTML",
    conflictsTitle: "目录冲突处理",
    conflictsDesc: "只重命名冲突树的最高层目录，内部结构和名称保持不变。",
    warningsTitle: "需要检查",
    noWarnings: "未发现附件缺失、校验失败或结构异常。",
    safetyTitle: "本次导入的安全策略",
    safetyA: "默认创建独立副本，不覆盖已有目录或笔记。",
    safetyB: "附件会生成新的 ID，并重写正文中的附件地址。",
    safetyC: "任一步骤失败都会回滚数据库并清理已写入文件。",
    cancel: "取消导入",
    confirm: "确认导入",
    noConflicts: "目标中未发现同名根目录。",
    currentSpace: "当前导入空间",
    packageKindMarkdown: "Markdown 往返包",
    packageKindNowen: "Nowen 无损包",
  } : {
    title: "Import preflight report",
    subtitle: "Review the tree, attachments and conflict plan before any data is written",
    packageFile: "Package",
    target: "Target",
    exportedAt: "Exported",
    protocol: "Protocol",
    notebooks: "Folders",
    notes: "Notes",
    tags: "Tags",
    attachments: "Attachments",
    formatTitle: "Content formats",
    markdown: "Markdown",
    richText: "Rich text",
    html: "HTML",
    conflictsTitle: "Folder conflicts",
    conflictsDesc: "Only the highest conflicting root is renamed; the subtree remains unchanged.",
    warningsTitle: "Needs attention",
    noWarnings: "No missing attachments, checksum failures or structural errors were found.",
    safetyTitle: "Import safety policy",
    safetyA: "Creates an independent copy and never overwrites existing folders or notes.",
    safetyB: "Attachments receive new IDs and content references are rewritten.",
    safetyC: "Any failure rolls back the database and removes files already written.",
    cancel: "Cancel import",
    confirm: "Confirm import",
    noConflicts: "No conflicting root folders were found.",
    currentSpace: "Current import space",
    packageKindMarkdown: "Markdown round-trip package",
    packageKindNowen: "Nowen lossless package",
  };

  const packageKind = pkg.packageKind === "markdown"
    ? copy.packageKindMarkdown
    : copy.packageKindNowen;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || submitting) return;
      event.preventDefault();
      resolveRoundTripImportReview(request.id, false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request.id, submitting]);

  const stats = useMemo(() => [
    { label: copy.notebooks, value: count(counts.notebooks), icon: FolderTree },
    { label: copy.notes, value: count(counts.notes), icon: FileText },
    { label: copy.tags, value: count(counts.tags), icon: Tags },
    { label: copy.attachments, value: count(counts.attachments), icon: Paperclip },
  ], [copy.attachments, copy.notebooks, copy.notes, copy.tags, counts.attachments, counts.notebooks, counts.notes, counts.tags]);

  const decide = (accepted: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    resolveRoundTripImportReview(request.id, accepted);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[12000] flex items-end justify-center bg-black/45 backdrop-blur-[1px] sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="round-trip-import-review-title"
    >
      <div className="flex max-h-[calc(100dvh-0.75rem)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:max-h-[min(88dvh,760px)] sm:rounded-2xl">
        <header className="flex items-start gap-3 border-b border-zinc-200 px-4 py-4 dark:border-zinc-800 sm:px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
            <PackageCheck size={21} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="round-trip-import-review-title" className="text-base font-bold text-zinc-900 dark:text-zinc-100">
              {copy.title}
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              {copy.subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={() => decide(false)}
            disabled={submitting}
            className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            aria-label={copy.cancel}
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <section className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-950/35">
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="flex min-w-0 items-center gap-2">
                <FileArchive size={14} className="shrink-0 text-zinc-400" />
                <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.packageFile}</span>
                <span className="truncate font-medium text-zinc-800 dark:text-zinc-200" title={request.fileName}>{request.fileName}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <ShieldCheck size={14} className="shrink-0 text-zinc-400" />
                <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.target}</span>
                <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{request.targetLabel || copy.currentSpace}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Hash size={14} className="shrink-0 text-zinc-400" />
                <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.protocol}</span>
                <span className="font-medium text-zinc-800 dark:text-zinc-200">
                  {packageKind} · v{pkg.formatVersion || "?"}
                  {pkg.schemaVersion ? ` · schema ${pkg.schemaVersion}` : ""}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.exportedAt}</span>
                <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{formatDate(pkg.exportedAt)}</span>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.map(({ label, value, icon: Icon }) => (
              <div key={label} className="rounded-xl border border-zinc-200 px-3 py-3 dark:border-zinc-800">
                <div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <Icon size={14} />
                  {label}
                </div>
                <div className="mt-1 text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div>
              </div>
            ))}
          </section>

          <section className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{copy.formatTitle}</h3>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">{copy.markdown} {count(formats.markdown)}</span>
              <span className="rounded-lg bg-violet-50 px-2.5 py-1.5 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">{copy.richText} {count(formats.richText)}</span>
              <span className="rounded-lg bg-orange-50 px-2.5 py-1.5 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">{copy.html} {count(formats.html)}</span>
            </div>
          </section>

          <section className={`rounded-xl border p-3 ${conflicts.length > 0
            ? "border-amber-200 bg-amber-50/45 dark:border-amber-900/50 dark:bg-amber-500/5"
            : "border-emerald-200 bg-emerald-50/45 dark:border-emerald-900/50 dark:bg-emerald-500/5"
          }`}>
            <div className="flex items-start gap-2">
              {conflicts.length > 0
                ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                : <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  {copy.conflictsTitle} · {conflicts.length}
                </h3>
                <p className="mt-1 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
                  {conflicts.length > 0 ? copy.conflictsDesc : copy.noConflicts}
                </p>
                {conflicts.length > 0 && (
                  <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                    {conflicts.map((conflict, index) => (
                      <div key={`${conflict.sourceId || index}-${index}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-amber-200/70 bg-white/75 px-2.5 py-2 text-xs dark:border-amber-900/45 dark:bg-zinc-900/60">
                        <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300" title={conflict.originalName || ""}>
                          {conflict.originalName || "—"}
                        </span>
                        <ArrowRight size={13} className="shrink-0 text-amber-500" />
                        <span className="min-w-0 flex-1 truncate font-semibold text-amber-700 dark:text-amber-300" title={conflict.importedName || ""}>
                          {conflict.importedName || "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className={`rounded-xl border p-3 ${warnings.length || errors.length
            ? "border-red-200 bg-red-50/40 dark:border-red-900/50 dark:bg-red-500/5"
            : "border-zinc-200 dark:border-zinc-800"
          }`}>
            <h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
              {copy.warningsTitle} · {warnings.length + errors.length}
            </h3>
            {warnings.length || errors.length ? (
              <div className="mt-2 max-h-36 space-y-1 overflow-y-auto text-[11px] leading-5 text-red-700 dark:text-red-300">
                {errors.map((message, index) => <p key={`error-${index}`}>• {message}</p>)}
                {warnings.map((warning, index) => (
                  <p key={`${warning.type || "warning"}-${index}`}>• {warning.message || warning.type || "warning"}</p>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">{copy.noWarnings}</p>
            )}
          </section>

          <section className="rounded-xl border border-blue-200 bg-blue-50/45 p-3 dark:border-blue-900/45 dark:bg-blue-500/5">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-blue-800 dark:text-blue-200">
              <ShieldCheck size={15} />
              {copy.safetyTitle}
            </h3>
            <div className="mt-2 space-y-1 text-[11px] leading-5 text-blue-700/90 dark:text-blue-300/90">
              <p>• {copy.safetyA}</p>
              <p>• {copy.safetyB}</p>
              <p>• {copy.safetyC}</p>
            </div>
          </section>
        </div>

        <footer className="flex shrink-0 gap-2 border-t border-zinc-200 px-4 pt-3 pb-[max(0.9rem,env(safe-area-inset-bottom))] dark:border-zinc-800 sm:justify-end sm:px-5 sm:pb-4">
          <button
            type="button"
            onClick={() => decide(false)}
            disabled={submitting}
            className="flex-1 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:flex-none"
          >
            {copy.cancel}
          </button>
          <button
            type="button"
            onClick={() => decide(true)}
            disabled={submitting || errors.length > 0}
            className="flex flex-1 items-center justify-center rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
          >
            {submitting ? <Loader2 size={16} className="mr-2 animate-spin" /> : <PackageCheck size={16} className="mr-2" />}
            {copy.confirm}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default function RoundTripImportReviewCenter() {
  const [requests, setRequests] = useState<RoundTripImportReviewRequest[]>([]);

  useEffect(() => subscribeRoundTripImportReviews(setRequests), []);

  const current = requests[0];
  if (!current || typeof document === "undefined") return null;
  return <RoundTripImportReviewDialog key={current.id} request={current} />;
}
