import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  Copy,
  FileArchive,
  FileText,
  FolderInput,
  FolderPlus,
  FolderTree,
  Hash,
  Loader2,
  PackageCheck,
  Paperclip,
  PencilLine,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Tags,
  X,
} from "lucide-react";
import RoundTripPermissionMappingPanel from "@/components/RoundTripPermissionMappingPanel";
import {
  resolveRoundTripImportReview,
  subscribeRoundTripImportReviews,
  type RoundTripImportConflictAction,
  type RoundTripImportReviewRequest,
  type RoundTripImportStrategy,
  type RoundTripPackagePreview,
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
  try { return date.toLocaleString(); } catch { return value; }
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function suggestedMappings(preview: RoundTripPackagePreview): Record<string, string> {
  const principals = preview.package?.permissions?.principals || [];
  return Object.fromEntries(principals
    .filter((item) => item.suggestedTarget?.id)
    .map((item) => [item.sourceUserId, item.suggestedTarget!.id]));
}

function RoundTripImportReviewDialog({ request }: { request: RoundTripImportReviewRequest }) {
  const zh = isChineseLocale();
  const [strategy, setStrategy] = useState<RoundTripImportStrategy>(request.initialStrategy);
  const [previews, setPreviews] = useState<Partial<Record<RoundTripImportStrategy, RoundTripPackagePreview>>>(() => ({
    [request.initialStrategy]: request.preview,
  }));
  const [loadingStrategy, setLoadingStrategy] = useState<RoundTripImportStrategy | null>(null);
  const [loadError, setLoadError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [applyPermissions, setApplyPermissions] = useState(false);
  const [permissionMappings, setPermissionMappings] = useState<Record<string, string>>(() => suggestedMappings(request.preview));

  const preview = previews[strategy] || request.preview;
  const pkg = preview.package || {};
  const counts = pkg.counts || preview.counts || {};
  const actionCounts = preview.counts || {};
  const formats = pkg.formatStats || {};
  const conflicts = preview.conflicts || [];
  const warnings = preview.warnings || [];
  const errors = [...(preview.errors || []), ...(loadError ? [loadError] : [])];
  const canChooseStrategy = typeof request.loadPreview === "function";
  const syncAvailability = request.preview.package?.sync;
  const syncEnabled = syncAvailability?.available === true;
  const permissionInspection = pkg.permissions;

  useEffect(() => {
    const suggestions = suggestedMappings(preview);
    setPermissionMappings((current) => {
      const next = { ...suggestions, ...current };
      const allowed = new Set((preview.package?.permissions?.principals || []).map((item) => item.sourceUserId));
      for (const sourceId of Object.keys(next)) if (!allowed.has(sourceId)) delete next[sourceId];
      return next;
    });
    if (!permissionInspection?.included || !permissionInspection.canApply) setApplyPermissions(false);
  }, [permissionInspection?.canApply, permissionInspection?.included, preview]);

  const copy = zh ? {
    title: "导入预检报告",
    subtitle: "选择导入方式，并核对目录、附件、账号映射和冲突处理结果",
    packageFile: "数据包",
    target: "导入目标",
    exportedAt: "导出时间",
    protocol: "协议",
    sourceInstance: "来源实例",
    notebooks: "目录",
    notes: "笔记",
    tags: "标签",
    attachments: "附件",
    formatTitle: "内容格式",
    markdown: "Markdown",
    richText: "富文本",
    html: "HTML",
    strategyTitle: "选择导入方式",
    copyTitle: "创建独立副本",
    copyBadge: "推荐",
    copyDesc: "不接触已有内容；冲突根目录自动命名为“名称 (2)”。",
    mergeTitle: "合并到现有目录",
    mergeDesc: "按同级同名目录逐层合并；已有笔记不覆盖，同名笔记增加编号。",
    syncTitle: "安全增量同步",
    syncDesc: "根据首次导入留下的稳定来源映射，只更新来源有变化且本地未修改的内容。",
    syncUnavailable: syncAvailability?.reason || "当前数据包或目标空间尚不满足同步条件",
    linkedResources: "已关联资源",
    planTitle: strategy === "sync" ? "增量同步计划" : strategy === "merge" ? "合并与重命名计划" : "目录重命名计划",
    copyPlanDesc: "只重命名冲突树的最高层目录，内部结构和名称保持不变。",
    mergePlanDesc: "同名目录会复用；导入的同名笔记改为“名称 (2)”，不会覆盖正文。",
    syncPlanDesc: "来源和本地同时变化时保留本地版本；来源包中缺少的目录和笔记不会从本地删除。",
    noPlan: strategy === "sync" ? "没有需要新增、更新或处理冲突的资源。" : strategy === "merge" ? "没有需要合并或重命名的内容。" : "目标中未发现同名根目录。",
    actionSummary: "执行摘要",
    createdDirectories: "新建目录",
    mergedDirectories: "复用目录",
    renamedNotes: "改名笔记",
    createdNotes: "新增笔记",
    updatedDirectories: "更新目录",
    updatedNotes: "更新笔记",
    unchangedNotes: "无需变更",
    localConflicts: "本地冲突",
    recreatedResources: "重建资源",
    warningsTitle: "需要检查",
    noWarnings: "未发现附件缺失、校验失败或结构异常。",
    safetyTitle: "本次导入的安全策略",
    copySafety: "创建独立副本，不覆盖或静默合并已有目录和笔记。",
    mergeSafety: "仅复用同级同名目录；所有导入笔记仍会创建为新笔记。",
    syncSafety: "只有稳定来源映射、来源已变化且目标未被本地修改的资源才会更新。",
    safetyB: strategy === "sync" ? "本地和来源同时变化时保留本地版本，并在报告中标为冲突。" : "附件会生成新的 ID，并重写正文中的附件地址。",
    safetyC: strategy === "sync" ? "同步不会删除目标中已有但本次数据包未包含的目录或笔记。" : "任一步骤失败都会回滚数据库并清理已写入文件。",
    permissionSafety: applyPermissions ? "成员权限只应用到已映射账号；目标所有者和更高的已有权限保持不变。" : "成员与权限恢复保持关闭，数据包中的账号信息不会写入目标。",
    cancel: "取消导入",
    confirm: strategy === "sync" ? "确认安全同步" : strategy === "merge" ? "确认合并导入" : "确认创建副本",
    currentSpace: "当前导入空间",
    packageKindMarkdown: "Markdown 往返包",
    packageKindNowen: "Nowen 无损包",
    loadingPlan: "正在重新计算导入计划…",
    loadFailed: "无法生成该策略的预检结果",
  } : {
    title: "Import preflight report",
    subtitle: "Choose an import mode and review the tree, attachments, account mappings and conflicts",
    packageFile: "Package",
    target: "Target",
    exportedAt: "Exported",
    protocol: "Protocol",
    sourceInstance: "Source instance",
    notebooks: "Folders",
    notes: "Notes",
    tags: "Tags",
    attachments: "Attachments",
    formatTitle: "Content formats",
    markdown: "Markdown",
    richText: "Rich text",
    html: "HTML",
    strategyTitle: "Import mode",
    copyTitle: "Create an independent copy",
    copyBadge: "Recommended",
    copyDesc: "Leaves existing content untouched and renames a conflicting root to “Name (2)”.",
    mergeTitle: "Merge into existing folders",
    mergeDesc: "Reuses exact sibling folders. Existing notes are never overwritten; duplicates are numbered.",
    syncTitle: "Safe incremental sync",
    syncDesc: "Uses stable mappings from the first import and only updates changed source resources without local edits.",
    syncUnavailable: syncAvailability?.reason || "This package or target does not meet sync requirements",
    linkedResources: "Linked resources",
    planTitle: strategy === "sync" ? "Incremental sync plan" : strategy === "merge" ? "Merge and rename plan" : "Folder rename plan",
    copyPlanDesc: "Only the highest conflicting root is renamed; its subtree remains unchanged.",
    mergePlanDesc: "Matching folders are reused and duplicate imported notes become “Name (2)”.",
    syncPlanDesc: "Local edits win when both sides changed. Missing source items are not deleted from the target.",
    noPlan: strategy === "sync" ? "No resources need to be created, updated or resolved." : strategy === "merge" ? "Nothing needs to be merged or renamed." : "No conflicting root folders were found.",
    actionSummary: "Action summary",
    createdDirectories: "New folders",
    mergedDirectories: "Reused folders",
    renamedNotes: "Renamed notes",
    createdNotes: "New notes",
    updatedDirectories: "Updated folders",
    updatedNotes: "Updated notes",
    unchangedNotes: "Unchanged",
    localConflicts: "Local conflicts",
    recreatedResources: "Recreated",
    warningsTitle: "Needs attention",
    noWarnings: "No missing attachments, checksum failures or structural errors were found.",
    safetyTitle: "Import safety policy",
    copySafety: "Creates an independent copy without overwriting or silently merging existing content.",
    mergeSafety: "Only exact sibling folders are reused; every imported note is still created as a new note.",
    syncSafety: "Only stable mapped resources changed at the source and untouched locally are updated.",
    safetyB: strategy === "sync" ? "When source and local content both changed, the local version is preserved and reported." : "Attachments receive new IDs and content references are rewritten.",
    safetyC: strategy === "sync" ? "Sync never deletes target folders or notes missing from this package." : "Any failure rolls back the database and removes files already written.",
    permissionSafety: applyPermissions ? "Permissions are applied only to mapped accounts; the target owner and stronger existing roles are preserved." : "Permission restore remains disabled and no package identities are written to the target.",
    cancel: "Cancel import",
    confirm: strategy === "sync" ? "Confirm safe sync" : strategy === "merge" ? "Confirm merge import" : "Confirm independent copy",
    currentSpace: "Current import space",
    packageKindMarkdown: "Markdown round-trip package",
    packageKindNowen: "Nowen lossless package",
    loadingPlan: "Recalculating the import plan…",
    loadFailed: "Unable to build the selected preflight plan",
  };

  const packageKind = pkg.packageKind === "markdown" ? copy.packageKindMarkdown : copy.packageKindNowen;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || submitting || loadingStrategy) return;
      event.preventDefault();
      resolveRoundTripImportReview(request.id, { accepted: false });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loadingStrategy, request.id, submitting]);

  const chooseStrategy = async (next: RoundTripImportStrategy) => {
    if (next === "sync" && !syncEnabled) return;
    if (next === strategy || submitting || loadingStrategy) return;
    setStrategy(next);
    setLoadError("");
    if (previews[next] || !request.loadPreview) return;
    setLoadingStrategy(next);
    try {
      const loaded = await request.loadPreview(next);
      setPreviews((current) => ({ ...current, [next]: loaded }));
    } catch (error) {
      setLoadError(`${copy.loadFailed}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoadingStrategy(null);
    }
  };

  const decide = (accepted: boolean) => {
    if (submitting || loadingStrategy) return;
    setSubmitting(true);
    resolveRoundTripImportReview(
      request.id,
      accepted
        ? {
            accepted: true,
            strategy,
            applyPermissions: applyPermissions && permissionInspection?.canApply === true,
            permissionMappings: applyPermissions ? permissionMappings : {},
          }
        : { accepted: false },
    );
  };

  const actionLabel = (action?: RoundTripImportConflictAction): string => {
    const labels: Record<string, string> = zh ? {
      "merge-directory": "复用目录",
      "rename-root": "根目录改名",
      "rename-note": "笔记改名",
      "sync-create-directory": "新增目录",
      "sync-update-directory": "更新目录",
      "sync-create-note": "新增笔记",
      "sync-update-note": "更新笔记",
      "sync-local-conflict": "保留本地",
      "sync-replace-attachment": "替换附件",
    } : {
      "merge-directory": "Reuse folder",
      "rename-root": "Rename root",
      "rename-note": "Rename note",
      "sync-create-directory": "Create folder",
      "sync-update-directory": "Update folder",
      "sync-create-note": "Create note",
      "sync-update-note": "Update note",
      "sync-local-conflict": "Keep local",
      "sync-replace-attachment": "Replace attachment",
    };
    return labels[action || "rename-root"] || labels["rename-root"];
  };

  const stats = [
    { label: copy.notebooks, value: count(counts.notebooks), icon: FolderTree },
    { label: copy.notes, value: count(counts.notes), icon: FileText },
    { label: copy.tags, value: count(counts.tags), icon: Tags },
    { label: copy.attachments, value: count(counts.attachments), icon: Paperclip },
  ];
  const strategyClass = strategy === "sync"
    ? "bg-blue-600 hover:bg-blue-700"
    : strategy === "merge"
      ? "bg-violet-600 hover:bg-violet-700"
      : "bg-emerald-600 hover:bg-emerald-700";
  const summaryItems = strategy === "sync"
    ? [
        [copy.createdDirectories, actionCounts.notebooks, FolderPlus],
        [copy.createdNotes, actionCounts.notes, FileText],
        [copy.updatedDirectories, actionCounts.updatedNotebooks, FolderTree],
        [copy.updatedNotes, actionCounts.updatedNotes, PencilLine],
        [copy.unchangedNotes, actionCounts.unchangedNotes, ShieldCheck],
        [copy.localConflicts, actionCounts.localConflicts, ShieldAlert],
      ] as const
    : strategy === "merge"
      ? [
          [copy.createdDirectories, actionCounts.notebooks, FolderPlus],
          [copy.mergedDirectories, actionCounts.mergedNotebooks, FolderInput],
          [copy.renamedNotes, actionCounts.renamedNotes, PencilLine],
        ] as const
      : [];

  return createPortal(
    <div className="fixed inset-0 z-[12000] flex items-end justify-center bg-black/45 backdrop-blur-[1px] sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="round-trip-import-review-title">
      <div className="flex max-h-[calc(100dvh-0.75rem)] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:max-h-[min(92dvh,880px)] sm:rounded-2xl">
        <header className="flex items-start gap-3 border-b border-zinc-200 px-4 py-4 dark:border-zinc-800 sm:px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400"><PackageCheck size={21} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="round-trip-import-review-title" className="text-base font-bold text-zinc-900 dark:text-zinc-100">{copy.title}</h2>
            <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{copy.subtitle}</p>
          </div>
          <button type="button" onClick={() => decide(false)} disabled={submitting || !!loadingStrategy} className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200" aria-label={copy.cancel}><X size={18} /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <section className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-950/35">
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="flex min-w-0 items-center gap-2"><FileArchive size={14} className="shrink-0 text-zinc-400" /><span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.packageFile}</span><span className="truncate font-medium text-zinc-800 dark:text-zinc-200" title={request.fileName}>{request.fileName}</span></div>
              <div className="flex min-w-0 items-center gap-2"><ShieldCheck size={14} className="shrink-0 text-zinc-400" /><span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.target}</span><span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{request.targetLabel || copy.currentSpace}</span></div>
              <div className="flex min-w-0 items-center gap-2"><Hash size={14} className="shrink-0 text-zinc-400" /><span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.protocol}</span><span className="font-medium text-zinc-800 dark:text-zinc-200">{packageKind} · v{pkg.formatVersion || "?"}{pkg.schemaVersion ? ` · schema ${pkg.schemaVersion}` : ""}</span></div>
              <div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.exportedAt}</span><span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{formatDate(pkg.exportedAt)}</span></div>
              {pkg.sourceInstanceId && <div className="flex min-w-0 items-center gap-2 sm:col-span-2"><RefreshCw size={14} className="shrink-0 text-zinc-400" /><span className="shrink-0 text-zinc-500 dark:text-zinc-400">{copy.sourceInstance}</span><code className="truncate text-[11px] text-zinc-700 dark:text-zinc-300">{pkg.sourceInstanceId}</code></div>}
            </div>
          </section>

          {canChooseStrategy && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-zinc-800 dark:text-zinc-200">{copy.strategyTitle}</h3>
              <div className="grid gap-2 lg:grid-cols-3">
                <button type="button" onClick={() => void chooseStrategy("copy")} disabled={submitting || !!loadingStrategy} className={`rounded-xl border p-3 text-left transition-colors ${strategy === "copy" ? "border-emerald-400 bg-emerald-50/70 ring-2 ring-emerald-500/10 dark:border-emerald-700 dark:bg-emerald-500/10" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"}`}>
                  <div className="flex items-center gap-2"><Copy size={17} className="text-emerald-600 dark:text-emerald-400" /><span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{copy.copyTitle}</span><span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">{copy.copyBadge}</span></div>
                  <p className="mt-1.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">{copy.copyDesc}</p>
                </button>
                <button type="button" onClick={() => void chooseStrategy("merge")} disabled={submitting || !!loadingStrategy} className={`rounded-xl border p-3 text-left transition-colors ${strategy === "merge" ? "border-violet-400 bg-violet-50/70 ring-2 ring-violet-500/10 dark:border-violet-700 dark:bg-violet-500/10" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"}`}>
                  <div className="flex items-center gap-2"><FolderInput size={17} className="text-violet-600 dark:text-violet-400" /><span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{copy.mergeTitle}</span>{loadingStrategy === "merge" && <Loader2 size={14} className="animate-spin text-violet-500" />}</div>
                  <p className="mt-1.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">{copy.mergeDesc}</p>
                </button>
                <button type="button" onClick={() => void chooseStrategy("sync")} disabled={submitting || !!loadingStrategy || !syncEnabled} className={`rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${strategy === "sync" ? "border-blue-400 bg-blue-50/70 ring-2 ring-blue-500/10 dark:border-blue-700 dark:bg-blue-500/10" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"}`}>
                  <div className="flex items-center gap-2"><RefreshCw size={17} className="text-blue-600 dark:text-blue-400" /><span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{copy.syncTitle}</span>{loadingStrategy === "sync" && <Loader2 size={14} className="animate-spin text-blue-500" />}</div>
                  <p className="mt-1.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">{copy.syncDesc}</p>
                  {syncEnabled ? <p className="mt-1 text-[10px] font-medium text-blue-600 dark:text-blue-300">{copy.linkedResources}：{count(syncAvailability?.linkedResources)}</p> : <p className="mt-1 text-[10px] leading-4 text-amber-600 dark:text-amber-300">{copy.syncUnavailable}</p>}
                </button>
              </div>
            </section>
          )}

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.map(({ label, value, icon: Icon }) => <div key={label} className="rounded-xl border border-zinc-200 px-3 py-3 dark:border-zinc-800"><div className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400"><Icon size={14} />{label}</div><div className="mt-1 text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div></div>)}
          </section>

          <section className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{copy.formatTitle}</h3>
            <div className="mt-2 flex flex-wrap gap-2 text-xs"><span className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">{copy.markdown} {count(formats.markdown)}</span><span className="rounded-lg bg-violet-50 px-2.5 py-1.5 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">{copy.richText} {count(formats.richText)}</span><span className="rounded-lg bg-orange-50 px-2.5 py-1.5 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300">{copy.html} {count(formats.html)}</span></div>
          </section>

          <RoundTripPermissionMappingPanel
            inspection={permissionInspection}
            enabled={applyPermissions}
            onEnabledChange={setApplyPermissions}
            mappings={permissionMappings}
            onMappingsChange={setPermissionMappings}
            disabled={submitting || !!loadingStrategy}
          />

          {summaryItems.length > 0 && (
            <section className={`rounded-xl border p-3 ${strategy === "sync" ? "border-blue-200 bg-blue-50/45 dark:border-blue-900/45 dark:bg-blue-500/5" : "border-violet-200 bg-violet-50/45 dark:border-violet-900/45 dark:bg-violet-500/5"}`}>
              <h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{copy.actionSummary}</h3>
              <div className={`mt-2 grid grid-cols-2 gap-2 text-center text-[11px] ${strategy === "sync" ? "sm:grid-cols-3 lg:grid-cols-6" : "sm:grid-cols-3"}`}>
                {summaryItems.map(([label, value, Icon]) => <div key={String(label)} className="rounded-lg bg-white/75 p-2 dark:bg-zinc-900/50"><Icon size={14} className="mx-auto mb-1 text-blue-500" /><div className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{count(value)}</div><div className="text-zinc-500">{String(label)}</div></div>)}
              </div>
              {count(actionCounts.recreatedResources) > 0 && <p className="mt-2 text-[11px] text-blue-700 dark:text-blue-300">{copy.recreatedResources}：{count(actionCounts.recreatedResources)}</p>}
            </section>
          )}

          <section className={`rounded-xl border p-3 ${conflicts.length > 0 ? "border-amber-200 bg-amber-50/45 dark:border-amber-900/50 dark:bg-amber-500/5" : "border-emerald-200 bg-emerald-50/45 dark:border-emerald-900/50 dark:bg-emerald-500/5"}`}>
            <div className="flex items-start gap-2">{conflicts.length > 0 ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" /> : <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}<div className="min-w-0 flex-1"><h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{copy.planTitle} · {conflicts.length}</h3><p className="mt-1 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">{conflicts.length > 0 ? (strategy === "sync" ? copy.syncPlanDesc : strategy === "merge" ? copy.mergePlanDesc : copy.copyPlanDesc) : copy.noPlan}</p>{conflicts.length > 0 && <div className="mt-2 max-h-52 space-y-1.5 overflow-y-auto pr-1">{conflicts.map((conflict, index) => <div key={`${conflict.sourceId || index}-${index}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-amber-200/70 bg-white/75 px-2.5 py-2 text-xs dark:border-amber-900/45 dark:bg-zinc-900/60"><span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">{actionLabel(conflict.action)}</span><span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300" title={conflict.originalName || ""}>{conflict.originalName || "—"}</span>{conflict.importedName !== conflict.originalName && <><ArrowRight size={13} className="shrink-0 text-amber-500" /><span className="min-w-0 flex-1 truncate font-semibold text-amber-700 dark:text-amber-300" title={conflict.importedName || ""}>{conflict.importedName || "—"}</span></>}</div>)}</div>}</div></div>
          </section>

          <section className={`rounded-xl border p-3 ${warnings.length || errors.length ? "border-red-200 bg-red-50/40 dark:border-red-900/50 dark:bg-red-500/5" : "border-zinc-200 dark:border-zinc-800"}`}><h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{copy.warningsTitle} · {warnings.length + errors.length}</h3>{warnings.length || errors.length ? <div className="mt-2 max-h-36 space-y-1 overflow-y-auto text-[11px] leading-5 text-red-700 dark:text-red-300">{errors.map((message, index) => <p key={`error-${index}`}>• {message}</p>)}{warnings.map((warning, index) => <p key={`${warning.type || "warning"}-${index}`}>• {warning.message || warning.type || "warning"}</p>)}</div> : <p className="mt-1 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">{copy.noWarnings}</p>}</section>

          <section className="rounded-xl border border-blue-200 bg-blue-50/45 p-3 dark:border-blue-900/45 dark:bg-blue-500/5"><h3 className="flex items-center gap-1.5 text-xs font-semibold text-blue-800 dark:text-blue-200"><ShieldCheck size={15} />{copy.safetyTitle}</h3><div className="mt-2 space-y-1 text-[11px] leading-5 text-blue-700/90 dark:text-blue-300/90"><p>• {strategy === "sync" ? copy.syncSafety : strategy === "merge" ? copy.mergeSafety : copy.copySafety}</p><p>• {copy.safetyB}</p><p>• {copy.safetyC}</p>{permissionInspection?.included && <p>• {copy.permissionSafety}</p>}</div></section>
        </div>

        <footer className="flex shrink-0 gap-2 border-t border-zinc-200 px-4 pt-3 pb-[max(0.9rem,env(safe-area-inset-bottom))] dark:border-zinc-800 sm:justify-end sm:px-5 sm:pb-4">
          <button type="button" onClick={() => decide(false)} disabled={submitting || !!loadingStrategy} className="flex-1 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:flex-none">{copy.cancel}</button>
          <button type="button" onClick={() => decide(true)} disabled={submitting || !!loadingStrategy || errors.length > 0} className={`flex flex-1 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none ${strategyClass}`}>{submitting || loadingStrategy ? <Loader2 size={16} className="mr-2 animate-spin" /> : strategy === "sync" ? <RefreshCw size={16} className="mr-2" /> : strategy === "merge" ? <FolderInput size={16} className="mr-2" /> : <PackageCheck size={16} className="mr-2" />}{loadingStrategy ? copy.loadingPlan : copy.confirm}</button>
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
