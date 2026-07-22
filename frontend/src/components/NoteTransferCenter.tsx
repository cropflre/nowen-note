import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Loader2,
  MoveRight,
  Search,
  X,
} from "lucide-react";
import { getCurrentWorkspace } from "@/lib/api.impl";
import {
  noteTransferApi,
  type NoteTransferMode,
  type NoteTransferPayload,
  type NoteTransferPreview,
  type NoteTransferResult,
  type TransferNote,
  type TransferNotebook,
  type TransferSpace,
} from "@/lib/noteTransferApi";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

function normalizeWorkspaceId(value: string | null | undefined): string | null {
  return !value || value === "personal" ? null : value;
}

function workspaceKey(value: string | null): string {
  return value || "personal";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function notebookPath(notebooks: TransferNotebook[], notebook: TransferNotebook): string {
  const byId = new Map(notebooks.map((item) => [item.id, item]));
  const path: string[] = [];
  const visited = new Set<string>();
  let cursor: TransferNotebook | undefined = notebook;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    path.unshift(cursor.name);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path.join(" / ");
}

function isMainAppRoute(): boolean {
  if (typeof window === "undefined") return false;
  return !/^\/(?:share|public|notebook-share|login)(?:\/|$)/.test(window.location.pathname);
}

export default function NoteTransferCenter() {
  const [authenticated, setAuthenticated] = useState(() =>
    typeof localStorage !== "undefined" && !!localStorage.getItem("nowen-token"),
  );
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<TransferSpace[]>([]);
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState<string | null>(() =>
    normalizeWorkspaceId(getCurrentWorkspace()),
  );
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string | null>(null);
  const [sourceNotes, setSourceNotes] = useState<TransferNote[]>([]);
  const [sourceNotebooks, setSourceNotebooks] = useState<TransferNotebook[]>([]);
  const [targetNotebooks, setTargetNotebooks] = useState<TransferNotebook[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetNotebookId, setTargetNotebookId] = useState("");
  const [mode, setMode] = useState<NoteTransferMode>("copy");
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [includeTags, setIncludeTags] = useState(true);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [preview, setPreview] = useState<NoteTransferPreview | null>(null);
  const [result, setResult] = useState<NoteTransferResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const reconcileAuth = () => setAuthenticated(!!localStorage.getItem("nowen-token"));
    const onWorkspaceChanged = () => {
      setSourceWorkspaceId(normalizeWorkspaceId(getCurrentWorkspace()));
      setPreview(null);
      setResult(null);
    };
    window.addEventListener("storage", reconcileAuth);
    window.addEventListener("nowen:token-changed", reconcileAuth);
    window.addEventListener("nowen:workspace-changed", onWorkspaceChanged);
    return () => {
      window.removeEventListener("storage", reconcileAuth);
      window.removeEventListener("nowen:token-changed", reconcileAuth);
      window.removeEventListener("nowen:workspace-changed", onWorkspaceChanged);
    };
  }, []);

  const loadSpaces = useCallback(async () => {
    const list = await noteTransferApi.listSpaces();
    setSpaces(list);
    return list;
  }, []);

  const loadSource = useCallback(async (workspaceId: string | null) => {
    const [notes, notebooks] = await Promise.all([
      noteTransferApi.listNotes(workspaceId),
      noteTransferApi.listNotebooks(workspaceId),
    ]);
    setSourceNotes(
      notes
        .filter((note) => !note.isTrashed)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    );
    setSourceNotebooks(notebooks);
    setSelectedIds(new Set());
  }, []);

  const loadTargetNotebooks = useCallback(async (workspaceId: string | null) => {
    const notebooks = await noteTransferApi.listNotebooks(workspaceId);
    setTargetNotebooks(notebooks);
    setTargetNotebookId((current) =>
      current && notebooks.some((item) => item.id === current) ? current : (notebooks[0]?.id || ""),
    );
  }, []);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError("");
    setPreview(null);
    setResult(null);
    try {
      const list = await loadSpaces();
      const sourceKey = workspaceKey(sourceWorkspaceId);
      const firstTarget = sourceKey === "personal"
        ? list.find((space) => space.id !== "personal")
        : list.find((space) => space.id === "personal");
      const nextTarget = normalizeWorkspaceId(firstTarget?.id || null);
      setTargetWorkspaceId(nextTarget);
      await Promise.all([
        loadSource(sourceWorkspaceId),
        loadTargetNotebooks(nextTarget),
      ]);
    } catch (err: any) {
      setError(err?.message || "无法加载转移数据");
    } finally {
      setLoading(false);
    }
  }, [loadSource, loadSpaces, loadTargetNotebooks, sourceWorkspaceId]);

  useEffect(() => {
    if (!open) return;
    void initialize();
  }, [open, initialize]);

  useEffect(() => {
    setPreview(null);
    setResult(null);
  }, [selectedIds, targetWorkspaceId, targetNotebookId, mode, includeAttachments, includeTags]);

  const sourceNotebookNames = useMemo(
    () => new Map(sourceNotebooks.map((notebook) => [notebook.id, notebookPath(sourceNotebooks, notebook)])),
    [sourceNotebooks],
  );

  const filteredNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sourceNotes;
    return sourceNotes.filter((note) => {
      const notebookName = sourceNotebookNames.get(note.notebookId) || "";
      return `${note.title} ${notebookName}`.toLowerCase().includes(needle);
    });
  }, [query, sourceNotes, sourceNotebookNames]);

  const targetOptions = useMemo(
    () => spaces.filter((space) => space.id !== workspaceKey(sourceWorkspaceId)),
    [sourceWorkspaceId, spaces],
  );

  const payload = useMemo<NoteTransferPayload>(() => ({
    sourceNoteIds: Array.from(selectedIds),
    targetWorkspaceId,
    targetNotebookId,
    mode,
    includeAttachments,
    includeTags,
    ...(preview?.sourceVersions ? { expectedVersions: preview.sourceVersions } : {}),
  }), [selectedIds, targetWorkspaceId, targetNotebookId, mode, includeAttachments, includeTags, preview?.sourceVersions]);

  const handleSourceWorkspaceChange = async (value: string) => {
    const next = normalizeWorkspaceId(value);
    setSourceWorkspaceId(next);
    setPreview(null);
    setResult(null);
    setLoading(true);
    setError("");
    try {
      await loadSource(next);
      const nextTargetSpace = spaces.find((space) => space.id !== workspaceKey(next));
      const nextTarget = normalizeWorkspaceId(nextTargetSpace?.id || null);
      setTargetWorkspaceId(nextTarget);
      await loadTargetNotebooks(nextTarget);
    } catch (err: any) {
      setError(err?.message || "加载源空间失败");
    } finally {
      setLoading(false);
    }
  };

  const handleTargetWorkspaceChange = async (value: string) => {
    const next = normalizeWorkspaceId(value);
    setTargetWorkspaceId(next);
    setPreview(null);
    setResult(null);
    setLoading(true);
    setError("");
    try {
      await loadTargetNotebooks(next);
    } catch (err: any) {
      setError(err?.message || "加载目标笔记本失败");
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    if (selectedIds.size === 0) {
      toast.warning("请至少选择一篇笔记");
      return;
    }
    if (!targetNotebookId) {
      toast.warning("请选择目标笔记本");
      return;
    }
    setPreviewing(true);
    setError("");
    setResult(null);
    try {
      const next = await noteTransferApi.preview({ ...payload, expectedVersions: undefined });
      setPreview(next);
      if (next.canExecute) toast.success("预检通过，可以执行转移");
      else toast.warning("预检发现阻断项，请处理后重试");
    } catch (err: any) {
      setPreview(null);
      setError(err?.message || "预检失败");
    } finally {
      setPreviewing(false);
    }
  };

  const handleExecute = async () => {
    if (!preview?.canExecute) return;
    if (mode === "move") {
      const confirmed = window.confirm(
        `移动会先在目标空间创建副本并校验，然后把源空间中的 ${selectedIds.size} 篇笔记放入回收站。是否继续？`,
      );
      if (!confirmed) return;
    }
    setExecuting(true);
    setError("");
    try {
      const completed = await noteTransferApi.execute({
        ...payload,
        expectedVersions: preview.sourceVersions,
      });
      setResult(completed);
      setPreview(null);
      toast.success(
        mode === "move"
          ? `已安全移动 ${completed.copiedNoteCount} 篇笔记`
          : `已复制 ${completed.copiedNoteCount} 篇笔记`,
      );
      window.dispatchEvent(new CustomEvent("nowen:note-transfer-complete", { detail: completed }));
      if (mode === "move") {
        await loadSource(sourceWorkspaceId);
      }
    } catch (err: any) {
      setError(err?.message || "执行转移失败");
      if (err?.code === "SOURCE_VERSION_CONFLICT") {
        setPreview(null);
      }
    } finally {
      setExecuting(false);
    }
  };

  if (!authenticated || !isMainAppRoute() || typeof document === "undefined") return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-4 z-40 inline-flex h-10 items-center gap-2 rounded-full border border-app-border bg-app-elevated px-3 text-xs font-medium text-tx-secondary shadow-lg backdrop-blur transition-colors hover:border-accent-primary/40 hover:text-accent-primary max-md:h-11 max-md:w-11 max-md:justify-center max-md:px-0"
          style={{ bottom: "calc(var(--safe-area-bottom, 0px) + 5.25rem)" }}
          title="个人空间与团队空间之间复制或移动笔记"
          aria-label="跨空间转移笔记"
        >
          <ArrowLeftRight size={16} />
          <span className="max-md:hidden">跨空间</span>
        </button>
      )}

      {open && createPortal(
        <div
          className="fixed inset-0 z-[140] flex items-center justify-center bg-black/45 p-3 backdrop-blur-sm"
          data-swipe-blocker=""
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !executing) setOpen(false);
          }}
        >
          <div className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl">
            <header className="flex items-center gap-3 border-b border-app-border px-4 py-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
                <ArrowLeftRight size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-tx-primary">跨空间复制与移动</h2>
                <p className="mt-0.5 text-[11px] text-tx-tertiary">个人空间 ↔ 团队空间，先预检、再原子执行</p>
              </div>
              <button
                type="button"
                disabled={executing}
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover disabled:opacity-40"
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </header>

            <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
              <section className="flex min-h-[320px] flex-col border-b border-app-border md:min-h-0 md:border-b-0 md:border-r">
                <div className="space-y-2 border-b border-app-border p-3">
                  <label className="block text-[11px] font-medium text-tx-tertiary">源空间</label>
                  <select
                    value={workspaceKey(sourceWorkspaceId)}
                    onChange={(event) => void handleSourceWorkspaceChange(event.target.value)}
                    disabled={loading || executing}
                    className="h-9 w-full rounded-lg border border-app-border bg-app-surface px-3 text-xs text-tx-primary outline-none focus:border-accent-primary"
                  >
                    {spaces.map((space) => (
                      <option key={space.id} value={space.id}>{space.icon || ""} {space.name}</option>
                    ))}
                  </select>
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-tx-tertiary" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索笔记或笔记本"
                      className="h-9 w-full rounded-lg border border-app-border bg-app-surface pl-9 pr-3 text-xs text-tx-primary outline-none placeholder:text-tx-tertiary focus:border-accent-primary"
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-tx-tertiary">
                    <span>已选择 {selectedIds.size} / {sourceNotes.length}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const visible = filteredNotes.filter((note) => !note.isLocked).map((note) => note.id);
                        const allSelected = visible.length > 0 && visible.every((id) => selectedIds.has(id));
                        setSelectedIds(allSelected ? new Set() : new Set(visible));
                      }}
                      className="text-accent-primary hover:underline"
                    >
                      全选当前结果
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {loading ? (
                    <div className="flex h-full min-h-40 items-center justify-center text-xs text-tx-tertiary">
                      <Loader2 size={16} className="mr-2 animate-spin" />加载中…
                    </div>
                  ) : filteredNotes.length === 0 ? (
                    <div className="flex h-full min-h-40 flex-col items-center justify-center text-xs text-tx-tertiary">
                      <FileText size={24} className="mb-2 opacity-40" />没有可选笔记
                    </div>
                  ) : filteredNotes.map((note) => {
                    const checked = selectedIds.has(note.id);
                    return (
                      <label
                        key={note.id}
                        className={cn(
                          "mb-1 flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5 transition-colors",
                          checked
                            ? "border-accent-primary/40 bg-accent-primary/10"
                            : "border-transparent hover:bg-app-hover",
                          note.isLocked && mode === "move" && "cursor-not-allowed opacity-55",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={note.isLocked === 1 && mode === "move"}
                          onChange={() => {
                            setSelectedIds((current) => {
                              const next = new Set(current);
                              if (next.has(note.id)) next.delete(note.id);
                              else next.add(note.id);
                              return next;
                            });
                          }}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-tx-primary">{note.title || "无标题笔记"}</div>
                          <div className="mt-1 flex items-center gap-1 text-[10px] text-tx-tertiary">
                            <Folder size={10} />
                            <span className="truncate">{sourceNotebookNames.get(note.notebookId) || "未知笔记本"}</span>
                            {note.isLocked === 1 && <span className="ml-auto text-amber-500">已锁定</span>}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </section>

              <section className="min-h-0 overflow-y-auto p-4">
                <div className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-[11px] font-medium text-tx-tertiary">操作方式</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setMode("copy")}
                        className={cn(
                          "flex h-11 items-center justify-center gap-2 rounded-lg border text-xs font-medium",
                          mode === "copy" ? "border-accent-primary bg-accent-primary/10 text-accent-primary" : "border-app-border text-tx-secondary hover:bg-app-hover",
                        )}
                      >
                        <Copy size={15} />复制
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode("move")}
                        className={cn(
                          "flex h-11 items-center justify-center gap-2 rounded-lg border text-xs font-medium",
                          mode === "move" ? "border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400" : "border-app-border text-tx-secondary hover:bg-app-hover",
                        )}
                      >
                        <MoveRight size={15} />安全移动
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[11px] font-medium text-tx-tertiary">目标空间</label>
                    <select
                      value={workspaceKey(targetWorkspaceId)}
                      onChange={(event) => void handleTargetWorkspaceChange(event.target.value)}
                      disabled={loading || executing}
                      className="h-9 w-full rounded-lg border border-app-border bg-app-surface px-3 text-xs text-tx-primary outline-none focus:border-accent-primary"
                    >
                      {targetOptions.map((space) => (
                        <option key={space.id} value={space.id}>{space.icon || ""} {space.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[11px] font-medium text-tx-tertiary">目标笔记本</label>
                    <select
                      value={targetNotebookId}
                      onChange={(event) => setTargetNotebookId(event.target.value)}
                      disabled={loading || executing}
                      className="h-9 w-full rounded-lg border border-app-border bg-app-surface px-3 text-xs text-tx-primary outline-none focus:border-accent-primary"
                    >
                      {targetNotebooks.length === 0 && <option value="">没有可写入的笔记本</option>}
                      {targetNotebooks.map((notebook) => (
                        <option key={notebook.id} value={notebook.id}>{notebookPath(targetNotebooks, notebook)}</option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-app-border px-3 py-2 text-xs text-tx-secondary">
                      <input type="checkbox" checked={includeAttachments} onChange={(event) => setIncludeAttachments(event.target.checked)} />
                      复制附件
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-app-border px-3 py-2 text-xs text-tx-secondary">
                      <input type="checkbox" checked={includeTags} onChange={(event) => setIncludeTags(event.target.checked)} />
                      映射标签
                    </label>
                  </div>

                  {mode === "move" && (
                    <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      目标副本、附件和引用全部校验成功后，源笔记才会进入回收站；任一步失败都会整体回滚。
                    </div>
                  )}

                  {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">{error}</div>
                  )}

                  {preview && (
                    <div className="space-y-2 rounded-xl border border-app-border bg-app-surface p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-tx-primary">
                        {preview.canExecute ? <Check size={15} className="text-emerald-500" /> : <AlertTriangle size={15} className="text-red-500" />}
                        {preview.canExecute ? "预检通过" : "预检未通过"}
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-[11px] text-tx-secondary">
                        <span>笔记：{preview.noteCount}</span>
                        <span>标签：{preview.tagCount}</span>
                        <span>附件：{preview.attachmentCount}</span>
                        <span>体积：{formatBytes(preview.attachmentBytes)}</span>
                      </div>
                      {preview.blockers.map((item, index) => (
                        <div key={`${item.code}-${index}`} className="text-[11px] leading-5 text-red-500">• {item.message}</div>
                      ))}
                      {preview.warnings.map((warning, index) => (
                        <div key={index} className="text-[11px] leading-5 text-amber-600 dark:text-amber-400">• {warning}</div>
                      ))}
                    </div>
                  )}

                  {result && (
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        <Check size={15} />操作完成
                      </div>
                      <div className="mt-2 text-[11px] leading-5 text-tx-secondary">
                        已创建 {result.copiedNoteCount} 篇目标笔记，复制 {result.copiedAttachmentCount} 个附件；
                        {result.mode === "move" ? ` ${result.movedSourceNoteCount} 篇源笔记已放入回收站。` : " 源笔记保持不变。"}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border px-4 py-3">
              <span className="text-[10px] text-tx-tertiary">同批次内部笔记链接会自动重写；外部链接保留并提示</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={executing}
                  className="h-9 rounded-lg px-4 text-xs text-tx-secondary hover:bg-app-hover disabled:opacity-40"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => void handlePreview()}
                  disabled={previewing || executing || selectedIds.size === 0 || !targetNotebookId}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-app-border px-4 text-xs font-medium text-tx-secondary hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {previewing && <Loader2 size={14} className="animate-spin" />}
                  预检
                </button>
                <button
                  type="button"
                  onClick={() => void handleExecute()}
                  disabled={!preview?.canExecute || executing}
                  className={cn(
                    "inline-flex h-9 items-center gap-2 rounded-lg px-4 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40",
                    mode === "move" ? "bg-amber-600 hover:bg-amber-700" : "bg-accent-primary hover:opacity-90",
                  )}
                >
                  {executing ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={14} />}
                  {mode === "move" ? "执行安全移动" : "执行复制"}
                </button>
              </div>
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
