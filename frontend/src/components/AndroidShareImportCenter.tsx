import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Share2,
  UploadCloud,
  X,
} from "lucide-react";
import { api, getBaseUrl, getCurrentWorkspace } from "@/lib/api";
import type { Note, NoteListItem, Notebook, Workspace } from "@/types";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import {
  cancelAndroidShareUpload,
  completeAndroidShareItems,
  discardAndroidSharePayload,
  getPendingAndroidShares,
  isAndroidShareImportAvailable,
  onAndroidShareReceived,
  onAndroidShareUploadProgress,
  uploadAndroidShareItem,
  type AndroidShareItem,
  type AndroidSharePayload,
} from "@/lib/androidShareImport";
import {
  appendAndroidShareToNote,
  buildAndroidShareNoteTitle,
  type SharedUploadedAttachment,
} from "@/lib/androidShareImportContent";

type Destination = "files" | "existing" | "new";
type ItemRunState = { status: "idle" | "uploading" | "success" | "error"; progress: number; error?: string };

type AttachmentFolder = {
  id: string;
  name: string;
  parentId: string | null;
  fileCount: number;
};

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`;
}

function hasSharedText(payload: AndroidSharePayload): boolean {
  return Boolean(payload.subject?.trim() || payload.text?.trim() || payload.url?.trim());
}

function actionLabel(action: string): string {
  if (action.endsWith("SEND_MULTIPLE")) return "多文件分享";
  if (action.endsWith("SEND")) return "系统分享";
  if (action.endsWith("VIEW")) return "用 Nowen 打开";
  return "外部导入";
}

function itemIcon(item: AndroidShareItem): React.ReactNode {
  if (item.mimeType?.startsWith("image/")) return <ImageIcon size={17} />;
  return <FileText size={17} />;
}

function relativeAttachment(response: {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  category: "image" | "file";
}): SharedUploadedAttachment {
  const url = response.url?.startsWith("/api/attachments/")
    ? response.url
    : `/api/attachments/${response.id}`;
  return { ...response, url };
}

export default function AndroidShareImportCenter() {
  const available = useMemo(() => isAndroidShareImportAvailable(), []);
  const [payloads, setPayloads] = useState<AndroidSharePayload[]>([]);
  const [dismissedPayloadIds, setDismissedPayloadIds] = useState<Set<string>>(() => new Set());
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [destination, setDestination] = useState<Destination>("new");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [folders, setFolders] = useState<AttachmentFolder[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => getCurrentWorkspace() || "personal");
  const [notebookId, setNotebookId] = useState("");
  const [noteId, setNoteId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [noteQuery, setNoteQuery] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeUploadItemId, setActiveUploadItemId] = useState<string | null>(null);
  const [itemRuns, setItemRuns] = useState<Record<string, ItemRunState>>({});
  const mountedRef = useRef(true);

  const token = typeof localStorage !== "undefined" ? localStorage.getItem("nowen-token") || "" : "";
  const current = payloads.find((payload) => !dismissedPayloadIds.has(payload.id)) || null;
  const readyItems = current?.items.filter((item) => item.status === "ready") || [];
  const nonReadyItems = current?.items.filter((item) => item.status !== "ready") || [];

  const refreshQueue = useCallback(async (showSpinner = false) => {
    if (!available) return;
    if (showSpinner) setLoadingQueue(true);
    try {
      const result = await getPendingAndroidShares();
      if (!mountedRef.current) return;
      setPayloads(result.payloads || []);
      setDismissedPayloadIds((previous) => {
        const live = new Set((result.payloads || []).map((payload) => payload.id));
        return new Set([...previous].filter((id) => live.has(id)));
      });
    } catch (error) {
      console.warn("[AndroidShareImport] read pending queue failed", error);
    } finally {
      if (showSpinner && mountedRef.current) setLoadingQueue(false);
    }
  }, [available]);

  useEffect(() => {
    mountedRef.current = true;
    if (!available) return () => { mountedRef.current = false; };
    void refreshQueue(true);
    const timer = window.setInterval(() => void refreshQueue(false), 1800);
    let receivedHandle: { remove: () => Promise<void> } | null = null;
    let progressHandle: { remove: () => Promise<void> } | null = null;
    void onAndroidShareReceived(() => {
      setDismissedPayloadIds(new Set());
      void refreshQueue(false);
    }).then((handle) => { receivedHandle = handle; });
    void onAndroidShareUploadProgress((event) => {
      setItemRuns((previous) => ({
        ...previous,
        [event.itemId]: {
          status: "uploading",
          progress: Math.max(0, Math.min(100, event.percent || 0)),
        },
      }));
    }).then((handle) => { progressHandle = handle; });
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      void receivedHandle?.remove();
      void progressHandle?.remove();
    };
  }, [available, refreshQueue]);

  useEffect(() => {
    if (!current) return;
    setDestination(current.items.some((item) => item.status === "ready") ? "new" : "existing");
    setNewTitle(buildAndroidShareNoteTitle(current));
    setItemRuns({});
    setActiveUploadItemId(null);
  }, [current?.id]);

  useEffect(() => {
    if (!current || !token) return;
    let cancelled = false;
    setOptionsLoading(true);
    Promise.all([
      api.getWorkspaces().catch(() => [] as Workspace[]),
      api.attachmentFolders.list().catch(() => ({ folders: [] as AttachmentFolder[] })),
    ]).then(([workspaceList, folderResult]) => {
      if (cancelled) return;
      setWorkspaces(workspaceList);
      setFolders(folderResult.folders || []);
      const selected = workspaceId === "personal" || workspaceList.some((item) => item.id === workspaceId)
        ? workspaceId
        : "personal";
      setWorkspaceId(selected);
    }).finally(() => {
      if (!cancelled) setOptionsLoading(false);
    });
    return () => { cancelled = true; };
  }, [current?.id, token]);

  useEffect(() => {
    if (!current || !token) return;
    let cancelled = false;
    setOptionsLoading(true);
    api.getNotebooks(workspaceId).then((items) => {
      if (cancelled) return;
      setNotebooks(items);
      setNotebookId((previous) => items.some((item) => item.id === previous) ? previous : (items[0]?.id || ""));
    }).catch((error) => {
      if (!cancelled) {
        setNotebooks([]);
        setNotebookId("");
        toast.error(error?.message || "加载笔记本失败");
      }
    }).finally(() => {
      if (!cancelled) setOptionsLoading(false);
    });
    return () => { cancelled = true; };
  }, [current?.id, token, workspaceId]);

  useEffect(() => {
    if (!current || !token || destination !== "existing") return;
    let cancelled = false;
    const params: Record<string, string> = { workspaceId };
    if (notebookId) params.notebookId = notebookId;
    api.getNotes(params).then((items) => {
      if (cancelled) return;
      setNotes(items);
      setNoteId((previous) => items.some((item) => item.id === previous) ? previous : (items[0]?.id || ""));
    }).catch((error) => {
      if (!cancelled) {
        setNotes([]);
        setNoteId("");
        toast.error(error?.message || "加载笔记失败");
      }
    });
    return () => { cancelled = true; };
  }, [current?.id, token, destination, workspaceId, notebookId]);

  const visibleNotes = useMemo(() => {
    const query = noteQuery.trim().toLowerCase();
    if (!query) return notes;
    return notes.filter((note) => note.title.toLowerCase().includes(query));
  }, [notes, noteQuery]);

  const setRun = useCallback((itemId: string, next: ItemRunState) => {
    setItemRuns((previous) => ({ ...previous, [itemId]: next }));
  }, []);

  const uploadOne = useCallback(async (
    payload: AndroidSharePayload,
    item: AndroidShareItem,
    target: "files" | "attachment",
    targetNoteId?: string,
  ) => {
    const apiBaseUrl = getBaseUrl();
    if (!/^https?:\/\//i.test(apiBaseUrl)) {
      throw new Error("尚未配置可访问的 Nowen 服务器地址");
    }
    const authToken = localStorage.getItem("nowen-token") || "";
    if (!authToken) throw new Error("登录状态已失效，请重新登录后重试");
    setActiveUploadItemId(item.id);
    setRun(item.id, { status: "uploading", progress: 0 });
    try {
      const result = await uploadAndroidShareItem({
        payloadId: payload.id,
        itemId: item.id,
        apiBaseUrl,
        token: authToken,
        destination: target,
        workspaceId,
        noteId: targetNoteId,
        folderId: target === "files" ? folderId || undefined : undefined,
      });
      setRun(item.id, { status: "success", progress: 100 });
      return result.response;
    } catch (error: any) {
      const message = error?.message || "上传失败";
      setRun(item.id, { status: "error", progress: 0, error: message });
      throw error;
    } finally {
      setActiveUploadItemId((active) => active === item.id ? null : active);
    }
  }, [folderId, setRun, workspaceId]);

  const handleFileManagerImport = useCallback(async () => {
    if (!current || readyItems.length === 0 || running) return;
    setRunning(true);
    const completed: string[] = [];
    let failed = 0;
    try {
      for (const item of readyItems) {
        try {
          await uploadOne(current, item, "files");
          completed.push(item.id);
        } catch {
          failed += 1;
        }
      }
      if (completed.length) await completeAndroidShareItems(current.id, completed, false);
      if (completed.length) toast.success(`已保存 ${completed.length} 个文件${failed ? `，${failed} 个失败可重试` : ""}`);
      else toast.error("文件保存失败，可检查服务器后重试");
      if (hasSharedText(current)) toast.info("分享文字仍保留在待导入队列，可继续插入笔记");
      await refreshQueue(false);
    } finally {
      setRunning(false);
    }
  }, [current, readyItems, running, uploadOne, refreshQueue]);

  const handleNoteImport = useCallback(async () => {
    if (!current || running) return;
    if (destination === "existing" && !noteId) {
      toast.error("请选择要插入的笔记");
      return;
    }
    if (destination === "new" && !notebookId) {
      toast.error("请选择目标笔记本");
      return;
    }
    if (readyItems.length === 0 && !hasSharedText(current)) {
      toast.error("没有可导入的内容");
      return;
    }

    setRunning(true);
    let note: Note | null = null;
    let createdNew = false;
    const completed: string[] = [];
    const attachments: SharedUploadedAttachment[] = [];
    let failed = 0;
    try {
      if (destination === "existing") {
        note = await api.getNote(noteId);
      } else {
        note = await api.createNote({
          title: newTitle.trim() || buildAndroidShareNoteTitle(current),
          notebookId,
          workspaceId: workspaceId === "personal" ? null : workspaceId,
          content: "",
          contentText: "",
          contentFormat: "markdown",
        });
        createdNew = true;
      }

      for (const item of readyItems) {
        try {
          const response = await uploadOne(current, item, "attachment", note.id);
          completed.push(item.id);
          attachments.push(relativeAttachment(response));
        } catch {
          failed += 1;
        }
      }

      const shouldWrite = attachments.length > 0 || hasSharedText(current);
      if (shouldWrite) {
        const patch = appendAndroidShareToNote(note, current, attachments);
        note = await api.updateNote(note.id, {
          ...patch,
          version: note.version,
          ...(createdNew && newTitle.trim() ? { title: newTitle.trim().slice(0, 255) } : {}),
        });
      } else if (createdNew) {
        await api.deleteNote(note.id).catch(() => undefined);
        note = null;
      }

      if (note) {
        await completeAndroidShareItems(current.id, completed, true);
        window.dispatchEvent(new CustomEvent("nowen:open-note", { detail: { noteId: note.id } }));
        window.dispatchEvent(new CustomEvent("nowen:notes-changed", { detail: { noteId: note.id } }));
        if (createdNew) emitKnowledgeTreeRefresh("android-share-note-created");
        toast.success(`${createdNew ? "已新建笔记并导入" : "已插入笔记"}${failed ? `，${failed} 个文件失败可重试` : ""}`);
      } else {
        toast.error("没有文件上传成功，未保留空笔记");
      }
      await refreshQueue(false);
    } catch (error: any) {
      toast.error(error?.message || "导入笔记失败");
    } finally {
      setRunning(false);
    }
  }, [current, running, destination, noteId, notebookId, readyItems, newTitle, workspaceId, uploadOne, refreshQueue]);

  const handleDiscard = useCallback(async () => {
    if (!current || running) return;
    const accepted = await confirm({
      title: "放弃这次外部导入？",
      description: "已复制到 Nowen 私有目录的临时文件会被删除，此操作无法恢复。",
      confirmText: "放弃并清理",
      danger: true,
    });
    if (!accepted) return;
    await discardAndroidSharePayload(current.id);
    setDismissedPayloadIds((previous) => new Set([...previous].filter((id) => id !== current.id)));
    await refreshQueue(false);
  }, [current, running, refreshQueue]);

  const handleIgnoreInvalid = useCallback(async () => {
    if (!current || nonReadyItems.length === 0 || running) return;
    await completeAndroidShareItems(current.id, nonReadyItems.map((item) => item.id), false);
    await refreshQueue(false);
  }, [current, nonReadyItems, running, refreshQueue]);

  const handleCancelUpload = useCallback(async () => {
    if (!activeUploadItemId) return;
    await cancelAndroidShareUpload(activeUploadItemId);
  }, [activeUploadItemId]);

  if (!available || !current || !token) return null;

  const canSubmit = destination === "files"
    ? readyItems.length > 0
    : destination === "existing"
      ? Boolean(noteId) && (readyItems.length > 0 || hasSharedText(current))
      : Boolean(notebookId) && (readyItems.length > 0 || hasSharedText(current));

  return (
    <div className="fixed inset-0 z-[180] flex items-end sm:items-center justify-center bg-black/45 backdrop-blur-[2px] px-0 sm:px-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="导入 Android 分享内容"
        className="w-full sm:max-w-2xl max-h-[92dvh] flex flex-col overflow-hidden rounded-t-3xl sm:rounded-2xl border border-app-border bg-app-elevated shadow-2xl"
      >
        <header className="flex items-start gap-3 px-4 sm:px-5 py-4 border-b border-app-border">
          <div className="w-10 h-10 rounded-xl bg-accent-primary/10 text-accent-primary flex items-center justify-center shrink-0">
            <Share2 size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-tx-primary">导入到 Nowen Note</h2>
              {payloads.length > 1 && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-app-hover text-tx-tertiary">
                  还有 {payloads.length - 1} 项待处理
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-tx-tertiary truncate">
              {current.sourceLabel || "其他应用"} · {actionLabel(current.action)}
            </p>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={() => setDismissedPayloadIds((previous) => new Set(previous).add(current.id))}
            className="p-2 rounded-lg text-tx-tertiary hover:text-tx-primary hover:bg-app-hover disabled:opacity-40"
            title="稍后处理"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-5 py-4 space-y-5">
          {current.captureError && (
            <div className="flex gap-2 rounded-xl border border-red-500/25 bg-red-500/8 px-3 py-2.5 text-sm text-red-500">
              <AlertTriangle size={17} className="mt-0.5 shrink-0" />
              <span>{current.captureError}</span>
            </div>
          )}

          {hasSharedText(current) && (
            <div className="rounded-xl border border-app-border bg-app-bg/60 p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-tx-secondary mb-2">
                <Link2 size={14} /> 分享文字
              </div>
              {current.subject && <p className="text-sm font-medium text-tx-primary break-words">{current.subject}</p>}
              {current.text && (
                <p className="mt-1 text-sm text-tx-secondary whitespace-pre-wrap break-words line-clamp-5">{current.text}</p>
              )}
              {current.url && current.url !== current.text?.trim() && (
                <p className="mt-2 text-xs text-accent-primary break-all">{current.url}</p>
              )}
            </div>
          )}

          {current.items.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-medium text-tx-secondary">文件（{current.items.length}）</h3>
                {nonReadyItems.length > 0 && (
                  <button type="button" onClick={handleIgnoreInvalid} disabled={running} className="text-xs text-tx-tertiary hover:text-red-500 disabled:opacity-40">
                    忽略不可导入项
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {current.items.map((item) => {
                  const run = itemRuns[item.id];
                  const invalid = item.status !== "ready";
                  return (
                    <div key={item.id} className={cn(
                      "rounded-xl border px-3 py-2.5",
                      invalid ? "border-red-500/20 bg-red-500/5" : "border-app-border bg-app-bg/50",
                    )}>
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
                          invalid ? "bg-red-500/10 text-red-500" : "bg-accent-primary/10 text-accent-primary",
                        )}>
                          {invalid ? <AlertTriangle size={17} /> : itemIcon(item)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-tx-primary truncate">{item.name}</p>
                          <p className="text-[11px] text-tx-tertiary truncate">
                            {item.mimeType || "application/octet-stream"} · {humanSize(item.size || item.sourceSize || 0)}
                            {item.mimeMismatch ? " · 已纠正来源 MIME" : ""}
                          </p>
                        </div>
                        {run?.status === "success" && <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />}
                        {run?.status === "error" && <RefreshCw size={17} className="text-red-500 shrink-0" />}
                        {run?.status === "uploading" && <span className="text-xs tabular-nums text-accent-primary">{run.progress}%</span>}
                      </div>
                      {(item.error || run?.error) && <p className="mt-2 pl-12 text-xs text-red-500 break-words">{run?.error || item.error}</p>}
                      {run?.status === "uploading" && (
                        <div className="mt-2 pl-12">
                          <div className="h-1.5 rounded-full bg-app-hover overflow-hidden">
                            <div className="h-full bg-accent-primary transition-[width] duration-150" style={{ width: `${run.progress}%` }} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <h3 className="text-xs font-medium text-tx-secondary mb-2">保存方式</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {([
                ["files", FolderOpen, "保存到文件管理", "稍后再插入笔记"],
                ["existing", BookOpen, "插入已有笔记", "追加到正文末尾"],
                ["new", Plus, "新建笔记并插入", "自动生成标题"],
              ] as const).map(([value, Icon, title, detail]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDestination(value)}
                  disabled={value === "files" && readyItems.length === 0}
                  className={cn(
                    "text-left rounded-xl border p-3 transition-colors disabled:opacity-40",
                    destination === value
                      ? "border-accent-primary bg-accent-primary/8"
                      : "border-app-border hover:bg-app-hover",
                  )}
                >
                  <Icon size={17} className={destination === value ? "text-accent-primary" : "text-tx-tertiary"} />
                  <p className="mt-2 text-sm font-medium text-tx-primary">{title}</p>
                  <p className="mt-0.5 text-[11px] text-tx-tertiary">{detail}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-tx-tertiary mb-1.5">目标空间</span>
              <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={running || optionsLoading}
                className="w-full h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:ring-2 focus:ring-accent-primary/30">
                <option value="personal">🏠 个人空间</option>
                {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.icon || "🏢"} {workspace.name}</option>)}
              </select>
            </label>

            {destination === "files" ? (
              <label className="block">
                <span className="block text-xs text-tx-tertiary mb-1.5">附件目录</span>
                <select value={folderId} onChange={(event) => setFolderId(event.target.value)} disabled={running || optionsLoading}
                  className="w-full h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:ring-2 focus:ring-accent-primary/30">
                  <option value="">未归档文件</option>
                  {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}（{folder.fileCount}）</option>)}
                </select>
              </label>
            ) : (
              <label className="block">
                <span className="block text-xs text-tx-tertiary mb-1.5">目标笔记本</span>
                <select value={notebookId} onChange={(event) => setNotebookId(event.target.value)} disabled={running || optionsLoading}
                  className="w-full h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:ring-2 focus:ring-accent-primary/30">
                  {notebooks.length === 0 && <option value="">暂无可写笔记本</option>}
                  {notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.icon || "📓"} {notebook.name}</option>)}
                </select>
              </label>
            )}
          </div>

          {destination === "existing" && (
            <div>
              <label className="block text-xs text-tx-tertiary mb-1.5">选择已有笔记</label>
              <input value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} placeholder="搜索笔记标题"
                className="w-full h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:ring-2 focus:ring-accent-primary/30" />
              <select value={noteId} onChange={(event) => setNoteId(event.target.value)} disabled={running}
                className="mt-2 w-full h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:ring-2 focus:ring-accent-primary/30">
                {visibleNotes.length === 0 && <option value="">没有匹配的笔记</option>}
                {visibleNotes.map((note) => <option key={note.id} value={note.id}>{note.title || "无标题"}</option>)}
              </select>
            </div>
          )}

          {destination === "new" && (
            <label className="block">
              <span className="block text-xs text-tx-tertiary mb-1.5">新笔记标题</span>
              <input value={newTitle} maxLength={255} onChange={(event) => setNewTitle(event.target.value)} disabled={running}
                className="w-full h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:ring-2 focus:ring-accent-primary/30" />
            </label>
          )}

          {destination === "files" && hasSharedText(current) && (
            <p className="text-xs text-amber-500 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              文件管理只保存二进制文件；分享文字会继续保留，之后仍可选择“新建笔记并插入”。
            </p>
          )}
        </div>

        <footer
          className="px-4 sm:px-5 py-3 border-t border-app-border bg-app-elevated"
          style={{ paddingBottom: "max(0.75rem, var(--safe-area-bottom, 0px))" }}
        >
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleDiscard} disabled={running}
              className="px-3 py-2 text-sm rounded-lg text-red-500 hover:bg-red-500/10 disabled:opacity-40">
              放弃
            </button>
            <div className="flex-1" />
            {activeUploadItemId && (
              <button type="button" onClick={handleCancelUpload} className="px-3 py-2 text-sm rounded-lg border border-app-border text-tx-secondary hover:bg-app-hover">
                取消上传
              </button>
            )}
            <button
              type="button"
              disabled={!canSubmit || running || optionsLoading || loadingQueue}
              onClick={destination === "files" ? handleFileManagerImport : handleNoteImport}
              className="min-w-32 px-4 py-2.5 rounded-lg bg-accent-primary text-white text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-45"
            >
              {running || optionsLoading ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
              {running ? "正在导入" : destination === "files" ? "保存文件" : "导入笔记"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
