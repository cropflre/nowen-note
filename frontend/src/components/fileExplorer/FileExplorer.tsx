import AssetTrash from "./AssetTrash";
import { Capacitor } from "@capacitor/core";
import SimilarImages from "./SimilarImages";
import BatchRenameDialog from "./BatchRenameDialog";
import { MOBILE_SYNC_APPLIED_EVENT } from "@/lib/mobileSyncStatus";
import { explorerAssetFilters } from "@/lib/assetFilters";
import AssetTagEditor from "./AssetTagEditor";
import AssetFilterPanel from "./AssetFilterPanel";
import AssetOrganizationSidebar from "./AssetOrganizationSidebar";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Folder, Upload, Plus, Search, Menu, ChevronRight, LayoutGrid, List, Columns3, MoreHorizontal, Loader2 } from "lucide-react";
import { api, getBaseUrl, getServerUrl, getCurrentWorkspace, resolveAttachmentUrl } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import { folderPath, selectFile, type AssetCategory, type AssetFolder, type AssetView } from "@/lib/fileExplorerModel";
import { useFileUploadQueue } from "@/hooks/useFileUploadQueue";
import { useAppActions } from "@/store/AppContext";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { confirm, prompt } from "@/components/ui/confirm";
import { downloadAttachment } from "@/lib/downloadFile";
import { copyText } from "@/lib/clipboard";
import type { FileItem, FileSortKey, AssetFilters, AssetOrganization, AssetSmartFolder } from "@/types";
import AttachmentDetailDrawer from "@/components/attachmentDetail/AttachmentDetailDrawer";
import FileMoveDialog from "@/components/FileMoveDialog";
import FileFolderTree from "./FileFolderTree";
import FileCard from "./FileCard";
import FileUploadQueue from "./FileUploadQueue";

const Advanced = lazy(() => import("../FileManager").then((module) => ({ default: module.FileManagerAdvanced })));
const AssetAIDialog = lazy(() => import("./AssetAIDialog"));
const identity = () => `${getOfflineQueueStorageKey()}:${getServerUrl()}:${getCurrentWorkspace()}`;
const sortKeys: FileSortKey[] = ["created_desc", "created_asc", "name_asc", "name_desc", "size_asc", "size_desc"];

export default function FileExplorer() {
  const [scope, setScope] = useState(identity);
  useEffect(() => {
    const changed = () => setScope(identity());
    window.addEventListener("nowen:workspace-changed", changed);
    window.addEventListener("nowen:token-changed", changed);
    window.addEventListener("nowen:server-url-changed", changed);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener("nowen:workspace-changed", changed);
      window.removeEventListener("nowen:token-changed", changed);
      window.removeEventListener("nowen:server-url-changed", changed);
      window.removeEventListener("storage", changed);
    };
  }, []);
  return <FileExplorerContent key={scope} scope={scope} />;
}

function FileExplorerContent({ scope }: { scope: string }) {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [assetFilters, setAssetFilters] = useState<AssetFilters>({});
  const [organization, setOrganization] = useState<AssetOrganization | null>(null);
  const [organizationError, setOrganizationError] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [smartFolder, setSmartFolder] = useState<AssetSmartFolder | null>(null);
  const [batchTags, setBatchTags] = useState(false);
  const [batchRename, setBatchRename] = useState(false);
  const [aiMode, setAIMode] = useState<"organize" | "search" | null>(null);
  const [similar, setSimilar] = useState<{ id: string; filename: string } | null>(null);
  const [category, setCategory] = useState<AssetCategory>("all");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [folderSupport, setFolderSupport] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [items, setItems] = useState<FileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<FileSortKey>("created_desc");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<AssetView>("grid");
  const [density, setDensity] = useState(170);
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 768);
  const [advanced, setAdvanced] = useState(false);
  const [trash, setTrash] = useState(false);
  const isCurrent = useCallback(() => identity() === scope, [scope]);
  const [detail, setDetail] = useState<string | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [selectionMode, setSelectionMode] = useState(false);
  const anchor = useRef<string | null>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [moveFolder, setMoveFolder] = useState<AssetFolder | null>(null);
  const [menu, setMenu] = useState<{ file?: FileItem; folder?: AssetFolder; x: number; y: number } | null>(null);
  const [nameDialog, setNameDialog] = useState<{ id?: string; file?: FileItem; parentId?: string | null; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const refresh = useCallback(() => setRevision((previous) => previous + 1), []);
  useEffect(() => {
    const applied = () => { if (isCurrent()) refresh(); };
    window.addEventListener(MOBILE_SYNC_APPLIED_EVENT, applied);
    return () => window.removeEventListener(MOBILE_SYNC_APPLIED_EVENT, applied);
  }, [isCurrent, refresh]);
  const uploaded = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refresh, 200);
  }, [refresh]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  const queue = useFileUploadQueue(scope, uploaded, () => identity() === scope);
  const path = folderPath(folders, folderId);
  const title = smartFolder?.name || path.at(-1)?.name || t(`fileExplorer.${category}`);
  const currentFilters = useMemo(() => explorerAssetFilters(category, folderId, query, assetFilters), [category, folderId, query, assetFilters]);
  const pageSize = 60;
  const closeDetail = useCallback(() => setDetail(null), []);
  const clearSelection = () => { setSelected(new Set()); anchor.current = null; setSelectionMode(false); setBatchTags(false); };

  useEffect(() => registerMobileBackHandler("sheet", () => {
    if (similar || batchRename || aiMode) return false;
    if (nameDialog) { if (!saving) setNameDialog(null); return true; }
    if (moveIds || moveFolder) return false; // The move modal owns its pending operation.
    if (menu) { setMenu(null); return true; }
    if (detail) { setDetail(null); return true; }
    if (sidebar && window.innerWidth < 768) { setSidebar(false); return true; }
    if (folderId) {
      const parent = folders.find((folder) => folder.id === folderId)?.parentId || null;
      setFolderId(parent); setPage(1); setSelected(new Set()); return true;
    }
    return false;
  }), [detail, folderId, folders, menu, moveFolder, moveIds, nameDialog, saving, sidebar, similar, batchRename, aiMode]);

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(input.trim()); setPage(1); setSelected(new Set()); }, 250);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`nowen-assets-view:${scope}:${category}`);
      setView(saved === "grid" || saved === "list" || (saved === "masonry" && category === "image") ? saved : category === "document" ? "list" : "grid");
    } catch { setView(category === "document" ? "list" : "grid"); }
  }, [category, scope]);
  useEffect(() => {
    let stale = false;
    setLoading(true); setError("");
    const params: Parameters<typeof api.files.list>[0] = { ...currentFilters, page, pageSize, sort };
    api.files.list(params).then((result) => {
      if (stale || identity() !== scope) return;
      setItems(result.items); setTotal(result.total);
      setSelected((previous) => new Set([...previous].filter((id) => result.items.some((item) => item.id === id))));
      if (page > 1 && result.total <= (page - 1) * pageSize) setPage(Math.max(1, Math.ceil(result.total / pageSize)));
    }).catch((failure: unknown) => {
      if (!stale && identity() === scope) { setError(failure instanceof Error ? failure.message : String(failure)); setItems([]); }
    }).finally(() => { if (!stale && identity() === scope) setLoading(false); });
    return () => { stale = true; };
  }, [currentFilters, page, sort, revision, scope]);
  useEffect(() => {
    let stale = false;
    api.attachmentFolders.list().then((result) => {
      if (stale || identity() !== scope) return;
      setFolders(result.folders); setFolderSupport(result.supported !== false); setFolderError("");
      if (folderId && !result.folders.some(folder => folder.id === folderId)) setFolderId(null);
    }).catch((failure: unknown) => {
      if (!stale && identity() === scope) { setFolders([]); setFolderSupport(false); setFolderError(failure instanceof Error ? failure.message : String(failure)); }
    });
    return () => { stale = true; };
  }, [revision, scope, folderId]);

  useEffect(() => {
    let stale = false;
    api.files.organization.list().then((result) => {
      if (!stale && identity() === scope) { setOrganization(result); setOrganizationError(""); }
    }).catch((failure: unknown) => {
      if (!stale && identity() === scope) setOrganizationError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { stale = true; };
  }, [revision, scope]);
  const changeFilters = (filters: AssetFilters) => { setAssetFilters(filters); setPage(1); clearSelection(); setDetail(null); };
  const openSmartFolder = (folder: AssetSmartFolder) => {
    setSmartFolder(folder); setCategory("all"); setFolderId(folder.filters.folderId || null);
    setAssetFilters(folder.filters); setInput(folder.filters.q || ""); setQuery(folder.filters.q || "");
    setPage(1); clearSelection(); setDetail(null); setShowFilters(true); if (window.innerWidth < 768) setSidebar(false);
  };
  const saveSmartFolder = async (update = false) => {
    const name = update ? smartFolder?.name : await prompt({ title: t("assetOrganization.smartName") });
    if (!name?.trim() || identity() !== scope) return;
    try {
      const saved = await api.files.organization.saveSmartFolder(name.trim(), currentFilters, update ? smartFolder?.id : undefined);
      if (identity() !== scope) return;
      setSmartFolder(saved.smartFolder); refresh(); toast.success(t("assetOrganization.saved"));
    } catch (failure: unknown) { if (identity() === scope) toast.error(failure instanceof Error ? failure.message : String(failure)); }
  };

  const navigate = (nextCategory: AssetCategory, nextFolder: string | null = null) => {
    setAssetFilters({}); setSmartFolder(null); setShowFilters(false); setCategory(nextCategory); setFolderId(nextFolder); setPage(1); setInput(""); setQuery(""); clearSelection(); setDetail(null); if (window.innerWidth < 768) setSidebar(false); setMenu(null);
  };
  const chooseView = (next: AssetView) => {
    setView(next); try { localStorage.setItem(`nowen-assets-view:${scope}:${category}`, next); } catch { /* Preference storage can be unavailable. */ }
  };
  const jumpToNote = useCallback(async (id: string) => {
    try {
      const note = await api.getNote(id);
      if (!note || identity() !== scope) return;
      actions.setActiveNote(note); actions.setSelectedNotebook(note.notebookId); actions.setViewMode("all"); actions.setMobileView("editor");
    } catch (failure: unknown) { toast.error(failure instanceof Error ? failure.message : String(failure)); }
  }, [actions, scope]);
  const select = (item: FileItem, event: React.MouseEvent) => {
    const toggle = event.ctrlKey || event.metaKey || selectionMode;
    setSelected((previous) => selectFile(previous, items.map((file) => file.id), item.id, anchor.current, { toggle, range: event.shiftKey }));
    if (!event.shiftKey) anchor.current = item.id;
    if (!toggle && !event.shiftKey) setDetail(item.id);
  };
  const deleteFiles = async (ids: string[]) => {
    if (!await confirm({ title: t("assetTrash.move"), description: t("assetTrash.moveHint", { count: ids.length }), danger: true })) return;
    if (identity() !== scope) return;
    setSaving(true);
    try {
      const result = await api.files.batchRemove(ids);
      if (identity() !== scope) return;
      if (result.failed.length) toast.error(result.failed.map((failure) => failure.reason).join("; "));
      if (result.deleted) toast.success(t("assetTrash.moved", { count: result.deleted }));
      clearSelection(); setDetail(null); refresh();
    } catch (failure: unknown) { toast.error(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  };
  const saveName = async () => {
    if (!nameDialog?.name.trim()) return;
    setSaving(true);
    try {
      if (nameDialog.file) await api.files.rename(nameDialog.file.id, nameDialog.name.trim());
      else if (nameDialog.id) await api.attachmentFolders.rename(nameDialog.id, nameDialog.name.trim());
      else await api.attachmentFolders.create(nameDialog.name.trim(), nameDialog.parentId || undefined);
      if (identity() !== scope) return;
      toast.success(t("fileExplorer.saved")); setNameDialog(null); refresh();
    } catch (failure: unknown) { toast.error(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  };
  const showMenu = (event: React.MouseEvent, file?: FileItem, folder?: AssetFolder) => {
    event.preventDefault(); event.stopPropagation();
    setMenu({ file, folder, x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 290) });
  };
  const dropOnFolder = async (target: string, event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("application/x-nowen-assets")) return;
    event.preventDefault(); event.stopPropagation();
    try {
      const payload = JSON.parse(event.dataTransfer.getData("application/x-nowen-assets")) as { scope: string; ids: string[] };
      if (payload.scope !== scope || !Array.isArray(payload.ids) || payload.ids.some((id) => !items.some((item) => item.id === id))) return;
      await api.files.move(payload.ids, target, Object.fromEntries(items.filter((item) => payload.ids.includes(item.id)).map((item) => [item.id, item.folderId])));
      if (identity() !== scope) return;
      clearSelection(); refresh(); toast.success(t("fileManager.moved", { count: payload.ids.length }));
    } catch (failure: unknown) { toast.error(failure instanceof Error ? failure.message : String(failure)); }
  };

  if (trash) return <AssetTrash onBack={() => { setTrash(false); refresh(); }} isCurrent={isCurrent} />;
  if (advanced) return <div className="flex h-full min-h-0 flex-col"><button className="shrink-0 border-b border-app-border p-3 text-left text-sm text-accent-primary" onClick={() => { setAdvanced(false); refresh(); }}>{t("fileExplorer.backToFiles")}</button><div className="min-h-0 flex-1"><Suspense fallback={<Loader2 className="animate-spin" />}><Advanced /></Suspense></div></div>;
  const hasAssetFilters = Object.values(assetFilters).some((value) => value !== undefined && value !== false && (!Array.isArray(value) || value.length > 0));
  const childFolders = (category === "all" && !query && !smartFolder && !hasAssetFilters) ? folders.filter((folder) => folder.parentId === folderId) : [];
  const selection = items.filter((item) => selected.has(item.id));
  const canManageSelection = selection.length > 0 && selection.every((item) => item.canManage !== false);

  return <div ref={root} tabIndex={-1} className="relative flex h-full min-h-0 min-w-0 flex-1 bg-app-bg text-tx-primary" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    if (nameDialog || moveIds || moveFolder || similar || batchRename) return;
    if (menu) { setMenu(null); return; }
    if (detail) { setDetail(null); return; }
    clearSelection(); if (window.innerWidth < 768) setSidebar(false);
  }} onPaste={(event) => {
    if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length) { event.preventDefault(); queue.enqueue(files, folderId); }
  }}>
    {sidebar && <button aria-label={t("common.close")} className="absolute inset-0 z-20 bg-black/30 md:hidden" onClick={() => setSidebar(false)} />}
    <aside className={cn("flex w-56 shrink-0 flex-col border-r border-app-border bg-app-surface p-3", sidebar ? "absolute inset-y-0 left-0 z-30 md:static" : "hidden")} aria-label={t("fileExplorer.navigation")}>
      <h2 className="mb-3 px-2 text-sm font-semibold">{t("fileExplorer.myFiles")}</h2>
      {(["all", "recent", "image", "document"] as AssetCategory[]).map((value) => <button key={value} onClick={() => navigate(value)} className={cn("rounded-md px-3 py-2 text-left text-sm", category === value && !folderId ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}>{t(`fileExplorer.${value}`)}</button>)}
      <details className="mt-1"><summary className="cursor-pointer px-3 py-2 text-sm text-tx-secondary">{t("fileExplorer.more")}</summary>{(["video", "audio", "archive", "unorganized"] as AssetCategory[]).map((value) => <button key={value} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-app-hover" onClick={() => navigate(value)}>{t(`fileExplorer.${value}`)}</button>)}</details>
      <div className="mt-5 flex items-center justify-between px-2 text-xs font-medium text-tx-secondary"><span>{t("fileExplorer.myFolders")}</span><button aria-label={t("fileManager.newFolder")} disabled={!folderSupport} onClick={() => setNameDialog({ name: "", parentId: folderId })} className="p-1 disabled:opacity-30"><Plus size={15} /></button></div>
      <div className="mt-2 min-h-0 flex-1 overflow-auto"><FileFolderTree folders={folders} current={folderId} onOpen={(id) => navigate("all", id)} onMenu={(folder, event) => showMenu(event, undefined, folder)} onDrop={(target, event) => void dropOnFolder(target, event)} />
        {organization && <AssetOrganizationSidebar state={organization} activeTags={assetFilters.tagIds || []} activeSmart={smartFolder?.id || null} onTag={(id) => { navigate("all"); setAssetFilters({ tagIds: [id] }); setShowFilters(true); }} onSmart={openSmartFolder} onChanged={refresh} isCurrent={() => identity() === scope} />}
        {organizationError && <p role="alert" className="mt-3 text-xs text-red-500">{organizationError}<button onClick={refresh} className="ml-2 underline">{t("fileExplorer.retry")}</button></p>}
        {!folderSupport && <p className="px-2 py-3 text-xs leading-5 text-tx-tertiary">{folderError || t("fileExplorer.folderUnavailable")}</p>}
      </div>
      <button className="mt-3 rounded-md px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover" onClick={() => { clearSelection(); setDetail(null); setTrash(true); }}>{t("assetTrash.title")}</button>
      <button className="mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover" onClick={() => setAdvanced(true)}><MoreHorizontal size={16} />{t("fileExplorer.storageTools")}</button>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="shrink-0 space-y-2 border-b border-app-border px-3 py-2 md:space-y-3 md:px-4 md:py-3 max-md:max-h-[50dvh] max-md:overflow-y-auto">
        <div className="flex items-center gap-2"><button aria-label={t("fileExplorer.navigation")} aria-expanded={sidebar} className="p-1" onClick={() => setSidebar((previous) => !previous)}><Menu size={19} /></button><h1 className="min-w-0 flex-1 truncate text-sm md:text-lg font-semibold">{title}</h1><button className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent-primary px-2 py-2 text-xs md:gap-2 md:px-3 md:text-sm text-white" onClick={() => picker.current?.click()}><Upload size={15} />{t("fileManager.uploadFiles")}</button><button aria-label={t("fileManager.newFolder")} title={t("fileManager.newFolder")} className="rounded-lg border border-app-border p-2 disabled:opacity-30" disabled={!folderSupport} onClick={() => setNameDialog({ name: "", parentId: folderId })}><Plus size={18} /></button></div>
        <nav aria-label={t("fileExplorer.breadcrumb")} className="flex items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-tx-secondary"><button className="shrink-0" onClick={() => navigate("all")}>{t("fileExplorer.all")}</button>{path.map((folder) => <span key={folder.id} className="flex shrink-0 items-center gap-1"><ChevronRight size={12} /><button onClick={() => navigate("all", folder.id)}>{folder.name}</button></span>)}</nav>
        <div className="flex flex-wrap items-center gap-2"><label className="relative min-w-0 w-full flex-none md:w-auto md:flex-1"><Search size={15} className="absolute left-2.5 top-2.5 text-tx-tertiary" /><input aria-label={t("fileExplorer.search")} value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("fileExplorer.search")} className="h-9 w-full rounded-lg border border-app-border bg-app-surface pl-8 pr-3 text-sm outline-none focus:border-accent-primary" /></label>
          <select aria-label={t("fileExplorer.sort")} value={sort} onChange={(event) => { setSort(event.target.value as FileSortKey); setPage(1); clearSelection(); }} className="h-9 min-w-0 max-w-36 rounded-lg border border-app-border bg-app-surface px-2 text-xs">{sortKeys.map((value) => <option key={value} value={value}>{t(`fileExplorer.sortKeys.${value}`)}</option>)}</select>
          <div className="flex rounded-lg border border-app-border p-0.5">{(["grid", "list", ...(category === "image" ? ["masonry"] : [])] as AssetView[]).map((value) => { const Icon = value === "grid" ? LayoutGrid : value === "list" ? List : Columns3; return <button key={value} aria-label={t(`fileExplorer.views.${value}`)} aria-pressed={view === value} onClick={() => chooseView(value)} className={cn("rounded-md p-1.5", view === value && "bg-accent-primary/10 text-accent-primary")}><Icon size={17} /></button>; })}</div>
          <button className="text-xs text-tx-secondary" onClick={() => { setSelectionMode((previous) => !previous); setDetail(null); setSelected(new Set()); }}>{t("fileExplorer.select")}</button>
          {organization?.supported && <button aria-expanded={showFilters} className="text-xs text-accent-primary" onClick={() => setShowFilters((value) => !value)}>{t("assetOrganization.filters")}</button>}
          {!Capacitor.isNativePlatform() && <button onClick={() => setAIMode("search")} className="text-xs text-accent-primary">{t("assetAI.search")}</button>}
          {view === "masonry" && <input aria-label={t("fileExplorer.density")} type="range" min={130} max={260} step={10} value={density} onChange={(event) => setDensity(Number(event.target.value))} className="w-24" />}
        </div>
        {Capacitor.isNativePlatform() && <p className="text-xs text-tx-secondary">{t("assetAI.nativeUnavailable")}</p>}
        {showFilters && organization?.supported && <AssetFilterPanel filters={assetFilters} tags={organization.tags} onChange={changeFilters} onSave={() => void saveSmartFolder()} onUpdate={smartFolder ? () => void saveSmartFolder(true) : undefined} onClear={() => navigate("all")} />}
      </header>
      <input ref={picker} type="file" multiple className="hidden" onChange={(event) => { queue.enqueue(Array.from(event.target.files || []), folderId); event.target.value = ""; }} />
      <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); queue.enqueue(Array.from(event.dataTransfer.files), folderId); }}>
        {error ? <div role="alert" className="rounded-lg border border-red-500/30 p-4 text-sm text-red-500">{error}<button className="ml-3 underline" onClick={refresh}>{t("fileExplorer.retry")}</button></div> : loading ? <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-tx-secondary"><Loader2 size={18} className="animate-spin" />{t("fileExplorer.loading")}</div> : <>
          {!!childFolders.length && <div className="mb-3 grid grid-cols-2 gap-2 md:mb-4 md:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] md:gap-3">{childFolders.map((folder) => <button key={folder.id} className="flex items-center gap-2 rounded-lg border border-app-border bg-app-surface p-3 text-left text-sm hover:bg-app-hover" onClick={() => navigate("all", folder.id)} onContextMenu={(event) => showMenu(event, undefined, folder)} onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-nowen-assets")) event.preventDefault(); }} onDrop={(event) => void dropOnFolder(folder.id, event)}><Folder size={21} className="shrink-0 text-accent-primary" /><span className="min-w-0 truncate">{folder.name}</span></button>)}</div>}
          {!items.length && <div className="py-16 text-center text-sm text-tx-secondary"><Folder size={36} className="mx-auto mb-3 text-tx-tertiary" /><p>{t(query ? "fileExplorer.noResults" : "fileExplorer.empty")}</p><button className="mt-3 text-accent-primary" onClick={() => picker.current?.click()}>{t("fileManager.uploadFiles")}</button></div>}
          {view === "list" && !!items.length && <div className="mb-2 hidden items-center gap-3 px-3 text-xs text-tx-tertiary md:flex"><span className="w-12 shrink-0" /><span className="min-w-0 flex-1">{t("fileExplorer.columns.name")}</span><span className="w-20">{t("fileExplorer.columns.type")}</span><span className="w-20">{t("fileExplorer.columns.size")}</span><span className="hidden w-24 lg:block">{t("fileExplorer.columns.created")}</span><span className="w-28">{t("fileExplorer.columns.location")}</span><span className="w-7" /></div>}
          <div className={view === "grid" ? "grid grid-cols-2 gap-x-2 max-md:!grid-cols-2 md:gap-x-3" : view === "list" ? "space-y-2" : "gap-3"} style={view === "grid" ? { gridTemplateColumns: `repeat(auto-fill,minmax(min(100%,${density}px),1fr))` } : view === "masonry" ? { columnWidth: density, columnGap: 12 } : undefined}>
            {items.map((item) => <FileCard key={item.id} item={item} view={view} selected={selected.has(item.id)} onSelect={(event) => select(item, event)} onPreview={() => setDetail(item.id)} onMenu={(event) => showMenu(event, item)} onDrag={(event) => {
              const ids = selected.has(item.id) ? [...selected] : [item.id]; event.dataTransfer.setData("application/x-nowen-assets", JSON.stringify({ scope, ids })); event.dataTransfer.effectAllowed = "move";
            }} />)}
          </div>
        </>}
      </div>
      {selected.size > 0 && <div className="flex flex-wrap items-center gap-3 border-t border-app-border bg-app-elevated p-3 text-xs"><span>{t("fileExplorer.selected", { count: selected.size })}</span><button disabled={!folderSupport || !canManageSelection || saving} className="text-accent-primary disabled:opacity-30" onClick={() => setMoveIds([...selected])}>{t("fileManager.moveFiles")}</button><button onClick={async () => { try { for (const file of selection) await downloadAttachment(resolveAttachmentUrl(file.url), file.filename); } catch (failure: unknown) { toast.error(failure instanceof Error ? failure.message : String(failure)); } }}>{t("attachmentDetail.downloadFile")}</button><button className="text-red-500 disabled:opacity-30" disabled={!canManageSelection || saving} onClick={() => void deleteFiles([...selected])}>{t("assetTrash.move")}</button><button disabled={!organization?.supported || !canManageSelection || saving} className="text-accent-primary disabled:opacity-30" onClick={() => setBatchTags((value) => !value)}>{t("assetOrganization.batchTags")}</button><button disabled={!canManageSelection || saving} className="text-accent-primary disabled:opacity-30" onClick={() => setBatchRename(true)}>{t("assetTools.rename")}</button><button onClick={clearSelection}>{t("common.cancel")}</button></div>}
      {batchTags && selected.size > 0 && <div className="max-h-64 overflow-auto border-t border-app-border p-3"><AssetTagEditor ids={[...selected]} onChanged={refresh} /></div>}
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t border-app-border px-3 py-1 md:px-4 md:py-2 text-xs text-tx-secondary"><span>{t("fileExplorer.fileCount", { count: total })} · {t("fileExplorer.page", { page, total: Math.max(1, Math.ceil(total / pageSize)) })}</span><div className="flex gap-3"><button disabled={page === 1 || loading} className="disabled:opacity-30" onClick={() => { setPage((previous) => previous - 1); clearSelection(); }}>{t("fileExplorer.previous")}</button><button disabled={page * pageSize >= total || loading} className="disabled:opacity-30" onClick={() => { setPage((previous) => previous + 1); clearSelection(); }}>{t("fileExplorer.next")}</button></div></footer>
      <FileUploadQueue queue={queue} onView={setDetail} onMove={(id) => setMoveIds([id])} />
    </main>
    {detail && <AttachmentDetailDrawer embedded attachmentId={detail} onClose={closeDetail} onJumpToNote={jumpToNote} showDelete onAfterDelete={refresh} onAfterRename={refresh} onAfterMove={refresh} onAfterOrganize={refresh} onOpenAttachment={setDetail} onFindSimilar={setSimilar} />}
    {similar && <SimilarImages key={similar.id} source={similar} isCurrent={isCurrent} onClose={() => setSimilar(null)} onOpen={setDetail} />}
    {aiMode && <Suspense fallback={null}><AssetAIDialog mode={aiMode} files={(selection.length ? selection : items).filter(file => file.canManage !== false).slice(0,50)} isCurrent={isCurrent} onClose={() => setAIMode(null)} onApplied={() => { clearSelection(); refresh(); }} onOpen={setDetail} /></Suspense>}
    {batchRename && <BatchRenameDialog files={selection} isCurrent={isCurrent} onClose={() => setBatchRename(false)} onRenamed={() => { clearSelection(); refresh(); }} />}
    {(moveIds || moveFolder) && <FileMoveDialog ids={moveIds || []} folderToMove={moveFolder || undefined} expectedFolderIds={moveIds ? Object.fromEntries(items.filter((item) => moveIds.includes(item.id)).map((item) => [item.id, item.folderId])) : undefined} onClose={() => { setMoveIds(null); setMoveFolder(null); }} onMoved={() => { clearSelection(); refresh(); }} />}
    {nameDialog && <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4"><form role="dialog" aria-modal="true" aria-label={t(nameDialog.id || nameDialog.file ? "attachmentDetail.rename" : "fileManager.newFolder")} onSubmit={(event) => { event.preventDefault(); void saveName(); }} onKeyDown={(event) => { if (event.key === "Escape" && !saving) setNameDialog(null); }} className="w-full max-w-sm rounded-xl border border-app-border bg-app-elevated p-4 shadow-xl"><h2 className="text-sm font-semibold">{t(nameDialog.id || nameDialog.file ? "attachmentDetail.rename" : "fileManager.newFolder")}</h2><input autoFocus aria-label={t("fileManager.folderName")} value={nameDialog.name} maxLength={nameDialog.file ? 255 : 100} onChange={(event) => setNameDialog({ ...nameDialog, name: event.target.value })} className="mt-4 w-full rounded-lg border border-app-border bg-app-surface p-2 text-sm" /><div className="mt-4 flex justify-end gap-3 text-sm"><button type="button" disabled={saving} onClick={() => setNameDialog(null)}>{t("common.cancel")}</button><button type="submit" disabled={saving || !nameDialog.name.trim()} className="text-accent-primary disabled:opacity-30">{t("attachmentDetail.save")}</button></div></form></div>}
    {menu && <><button className="fixed inset-0 z-[110] cursor-default" aria-label={t("common.close")} onClick={() => setMenu(null)} /><div role="menu" className="fixed z-[111] w-52 rounded-lg border border-app-border bg-app-elevated p-1 text-sm shadow-xl" style={{ left: Math.max(4, menu.x), top: Math.max(4, menu.y) }}>
      {menu.file ? <>
        <MenuAction onClick={() => setDetail(menu.file!.id)} close={() => setMenu(null)}>{t("fileExplorer.preview")}</MenuAction>
        {menu.file.category === "image" && <MenuAction onClick={() => setSimilar(menu.file!)} close={() => setMenu(null)}>{t("assetTools.similar")}</MenuAction>}
        <MenuAction onClick={() => { void downloadAttachment(resolveAttachmentUrl(menu.file!.url), menu.file!.filename).catch((failure: unknown) => toast.error(failure instanceof Error ? failure.message : String(failure))); }} close={() => setMenu(null)}>{t("attachmentDetail.downloadFile")}</MenuAction>
        {menu.file.canManage !== false && <><MenuAction onClick={() => setNameDialog({ file: menu.file, name: menu.file!.filename })} close={() => setMenu(null)}>{t("attachmentDetail.rename")}</MenuAction><MenuAction disabled={!folderSupport} onClick={() => setMoveIds([menu.file!.id])} close={() => setMenu(null)}>{t("fileManager.moveFiles")}</MenuAction></>}
        <MenuAction onClick={async () => { const link = new URL(`${getBaseUrl().replace(/\/+$/, "")}/attachments/${encodeURIComponent(menu.file!.id)}`, window.location.href).href; if (await copyText(link)) toast.success(t("fileExplorer.privateLinkCopied")); }} close={() => setMenu(null)}>{t("fileExplorer.copyPrivateLink")}</MenuAction>
        <MenuAction onClick={() => setDetail(menu.file!.id)} close={() => setMenu(null)}>{t("attachmentDetail.referencedNotes")}</MenuAction>
        {menu.file.canManage !== false && <MenuAction danger onClick={() => void deleteFiles([menu.file!.id])} close={() => setMenu(null)}>{t("assetTrash.move")}</MenuAction>}
      </> : menu.folder && <>
        <MenuAction onClick={() => navigate("all", menu.folder!.id)} close={() => setMenu(null)}>{t("fileExplorer.open")}</MenuAction>
        <MenuAction onClick={() => setNameDialog({ name: "", parentId: menu.folder!.id })} close={() => setMenu(null)}>{t("fileExplorer.newSubfolder")}</MenuAction>
        <MenuAction onClick={() => setNameDialog({ id: menu.folder!.id, name: menu.folder!.name })} close={() => setMenu(null)}>{t("attachmentDetail.rename")}</MenuAction>
        <MenuAction onClick={() => setMoveFolder(menu.folder!)} close={() => setMenu(null)}>{t("fileManager.moveFiles")}</MenuAction>
        <MenuAction danger onClick={async () => { if (!await confirm({ title: t("fileExplorer.deleteFolder"), description: t("fileExplorer.emptyFolderOnly"), danger: true }) || identity() !== scope) return; try { await api.attachmentFolders.remove(menu.folder!.id); refresh(); } catch (failure: unknown) { toast.error(failure instanceof Error ? failure.message : String(failure)); } }} close={() => setMenu(null)}>{t("fileExplorer.deleteFolder")}</MenuAction>
      </>}
    </div></>}
  </div>;
}

function MenuAction({ children, onClick, close, danger, disabled }: { children: React.ReactNode; onClick: () => void; close: () => void; danger?: boolean; disabled?: boolean }) {
  return <button role="menuitem" disabled={disabled} className={cn("block w-full rounded px-3 py-2 text-left hover:bg-app-hover disabled:opacity-30", danger && "text-red-500")} onClick={() => { onClick(); close(); }}>{children}</button>;
}
