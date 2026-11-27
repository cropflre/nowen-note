import AssetTrash from "./AssetTrash";
import { Capacitor } from "@capacitor/core";
import SimilarImages from "./SimilarImages";
import BatchRenameDialog from "./BatchRenameDialog";
import { MOBILE_SYNC_APPLIED_EVENT } from "@/lib/mobileSyncStatus";
import { explorerAssetFilters } from "@/lib/assetFilters";
import AssetTagEditor from "./AssetTagEditor";
import AssetFilterPanel from "./AssetFilterPanel";
import AssetOrganizationSidebar from "./AssetOrganizationSidebar";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import {
  Archive,
  CheckSquare,
  ChevronRight,
  Clock,
  Columns3,
  FileText,
  Files,
  Film,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Image as ImageIcon,
  Inbox,
  LayoutGrid,
  List,
  Loader2,
  Menu,
  Music,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, getBaseUrl, getServerUrl, getCurrentWorkspace, resolveAttachmentUrl } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import { FILE_BATCH_CHUNK_LIMIT, FILE_SELECT_ALL_MATCHES_LIMIT, folderPath, type AssetCategory, type AssetFolder, type AssetView } from "@/lib/fileExplorerModel";
import { useFileSelection } from "@/hooks/useFileSelection";
import { runChunkedBatchRemove } from "@/lib/fileBatchActions";
import { useFileUploadQueue } from "@/hooks/useFileUploadQueue";
import { MOTION_EASE, MOTION_SPRING } from "@/lib/motion";
import { useAppActions } from "@/store/AppContext";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { confirm, prompt } from "@/components/ui/confirm";
import { downloadAttachment } from "@/lib/downloadFile";
import { copyText } from "@/lib/clipboard";
import { createStableFileShareUrl } from "@/lib/fileShareClipboard";
import { formatImageHostSnippet, type ImageHostFormat } from "@/lib/imageHostFormats";
import { useAIConnectionAvailable } from "@/lib/aiConnection";
import type { FileItem, FileSortKey, AssetFilters, AssetOrganization, AssetSmartFolder } from "@/types";
import AttachmentDetailDrawer from "@/components/attachmentDetail/AttachmentDetailDrawer";
import FileMoveDialog from "@/components/FileMoveDialog";
import FileFolderTree from "./FileFolderTree";
import FileCard from "./FileCard";
import FileUploadQueue from "./FileUploadQueue";
import ImageHostView from "./ImageHostView";
import StorageToolsView from "./StorageToolsView";

const AssetAIDialog = lazy(() => import("./AssetAIDialog"));
type FilePageView = "files" | "imageHost" | "storage";
const pageViews: FilePageView[] = ["files", "imageHost", "storage"];
const identity = () => `${getOfflineQueueStorageKey()}:${getServerUrl()}:${getCurrentWorkspace()}`;
const sortKeys: FileSortKey[] = ["created_desc", "created_asc", "name_asc", "name_desc", "size_asc", "size_desc"];

const CATEGORY_META: Record<AssetCategory, { icon: typeof Folder; colorClass: string }> = {
  all: { icon: Files, colorClass: "text-sky-500 dark:text-sky-400" },
  recent: { icon: Clock, colorClass: "text-amber-500 dark:text-amber-400" },
  image: { icon: ImageIcon, colorClass: "text-rose-500 dark:text-rose-400" },
  document: { icon: FileText, colorClass: "text-indigo-500 dark:text-indigo-400" },
  video: { icon: Film, colorClass: "text-violet-500 dark:text-violet-400" },
  audio: { icon: Music, colorClass: "text-emerald-500 dark:text-emerald-400" },
  archive: { icon: Archive, colorClass: "text-orange-500 dark:text-orange-400" },
  unorganized: { icon: Inbox, colorClass: "text-slate-500 dark:text-slate-400" },
};

const FOLDER_CARD_TINTS = [
  "bg-amber-500/14 text-amber-600 ring-1 ring-amber-500/25 dark:bg-amber-400/16 dark:text-amber-300",
  "bg-sky-500/14 text-sky-600 ring-1 ring-sky-500/22 dark:bg-sky-400/16 dark:text-sky-300",
  "bg-violet-500/14 text-violet-600 ring-1 ring-violet-500/22 dark:bg-violet-400/16 dark:text-violet-300",
  "bg-emerald-500/14 text-emerald-600 ring-1 ring-emerald-500/22 dark:bg-emerald-400/16 dark:text-emerald-300",
  "bg-rose-500/14 text-rose-600 ring-1 ring-rose-500/22 dark:bg-rose-400/16 dark:text-rose-300",
];

function pickFolderTint(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return FOLDER_CARD_TINTS[Math.abs(hash) % FOLDER_CARD_TINTS.length];
}

const FILE_CLOUD_BOOP_LINES = [
  "直接拖文件进来就能秒收进口袋哦 ✨",
  "也可以按 ⌘+V / Ctrl+V 把截图直接贴进来 📸",
  "图片、PDF、录屏、压缩包都能安心住在这里 🎒",
];

/** 俏皮拟人化「口袋文件夹」空状态插画：悬停微晃，点击开心弹跳。 */
function PlayfulFileCloud({ onBoop }: { onBoop: () => void }) {
  const [boops, setBoops] = useState(0);

  return (
    <motion.button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={() => {
        setBoops((count) => count + 1);
        onBoop();
      }}
      className="group relative mx-auto mb-4 flex h-32 w-32 cursor-pointer items-center justify-center rounded-full focus:outline-none"
      whileHover={{ scale: 1.07 }}
      whileTap={{ scale: 0.93 }}
      animate={boops > 0 ? { y: [0, -12, 0], rotate: [0, -7, 7, 0] } : { y: [0, -4, 0] }}
      transition={boops > 0
        ? { duration: 0.45, ease: MOTION_EASE.enter }
        : { duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
    >
      <span className="pointer-events-none absolute inset-1.5 rounded-full bg-gradient-to-tr from-sky-400/22 via-amber-400/18 to-violet-400/22 blur-xl" />

      <motion.span
        className="pointer-events-none absolute right-2 top-3 text-amber-400 dark:text-amber-300"
        animate={{ y: [0, -5, 0], rotate: [0, 16, 0], opacity: [0.65, 1, 0.65] }}
        transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
      >
        <Sparkles size={16} />
      </motion.span>
      <motion.span
        className="pointer-events-none absolute left-2 top-6 h-2.5 w-2.5 rounded-full bg-sky-400/60"
        animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0.95, 0.5] }}
        transition={{ duration: 2.3, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.span
        className="pointer-events-none absolute bottom-4 right-3 h-2 w-2 rounded-full bg-rose-400/60"
        animate={{ y: [0, 4, 0], opacity: [0.45, 0.9, 0.45] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut", delay: 0.35 }}
      />

      <svg viewBox="0 0 112 112" className="relative h-24 w-24 drop-shadow-sm" fill="none">
        {/* 文件夹背板 */}
        <path
          d="M18 40C18 34.5 22.5 30 28 30H44L52 38H84C89.5 38 94 42.5 94 48V78C94 83.5 89.5 88 84 88H28C22.5 88 18 83.5 18 78V40Z"
          className="fill-amber-400/20 stroke-amber-500/70 dark:fill-amber-400/18 dark:stroke-amber-300/70"
          strokeWidth="2.4"
        />
        {/* 探头的小卡片纸片 */}
        <rect
          x="32"
          y="26"
          width="48"
          height="26"
          rx="8"
          className="fill-app-elevated stroke-sky-400/60 transition-transform duration-300 group-hover:-translate-y-1.5"
          strokeWidth="2"
        />
        <rect x="41" y="34" width="22" height="4" rx="2" className="fill-sky-400/60 transition-transform duration-300 group-hover:-translate-y-1.5" />
        <rect x="41" y="42" width="14" height="3.5" rx="1.75" className="fill-violet-400/50 transition-transform duration-300 group-hover:-translate-y-1.5" />
        {/* 文件夹前盖 */}
        <rect
          x="18"
          y="46"
          width="76"
          height="42"
          rx="12"
          className="fill-app-elevated stroke-amber-500/70 dark:stroke-amber-300/70"
          strokeWidth="2.4"
        />
        {/* 笑眯眯小表情 */}
        <circle cx="46" cy="64" r="2.6" className="fill-tx-primary/75" />
        <circle cx="66" cy="64" r="2.6" className="fill-tx-primary/75" />
        <path
          d="M51 69.5C53.2 72.5 58.8 72.5 61 69.5"
          className="stroke-tx-primary/75"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <circle cx="40.5" cy="68" r="3" className="fill-rose-400/40" />
        <circle cx="71.5" cy="68" r="3" className="fill-rose-400/40" />
      </svg>
    </motion.button>
  );
}

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
  const aiAvailable = useAIConnectionAvailable();
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
  const [density, setDensity] = useState(178);
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 768);
  const [boopIndex, setBoopIndex] = useState<number | null>(null);
  const [draggingExternalFiles, setDraggingExternalFiles] = useState(false);
  // Files is the default view. It stays mounted while hidden so its folder, search, filters
  // and scroll position are intact on return; Image hosting keeps its own filters the same way.
  const [pageView, setPageView] = useState<FilePageView>("files");
  const [visitedHost, setVisitedHost] = useState(false);
  const [hostRevision, setHostRevision] = useState(0);
  const filesScroll = useRef<HTMLDivElement>(null);
  const savedScroll = useRef<number | null>(null);
  const [trash, setTrash] = useState(false);
  const isCurrent = useCallback(() => identity() === scope, [scope]);
  const [detail, setDetail] = useState<string | null>(null);
  const {
    selectedIds: selected,
    selectedList: selection,
    selectionMode,
    selectingAll,
    allPageSelected,
    somePageSelected,
    clearSelection,
    syncPageItems,
    toggleSelectionMode,
    handleSelectItem,
    togglePage: toggleSelectPage,
    selectAllMatching,
  } = useFileSelection(items);
  const listSelectAllRef = useRef<HTMLInputElement>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [moveExpectedFolderIds, setMoveExpectedFolderIds] = useState<Record<string, string | null> | undefined>(undefined);
  const [moveFolder, setMoveFolder] = useState<AssetFolder | null>(null);
  const [menu, setMenu] = useState<{ file?: FileItem; folder?: AssetFolder; x: number; y: number } | null>(null);
  const [nameDialog, setNameDialog] = useState<{ id?: string; file?: FileItem; parentId?: string | null; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
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
  const handleClearSelection = useCallback(() => { clearSelection(); setBatchTags(false); }, [clearSelection]);

  useEffect(() => {
    if (listSelectAllRef.current) {
      listSelectAllRef.current.indeterminate = somePageSelected && !allPageSelected;
    }
  }, [allPageSelected, somePageSelected]);

  useEffect(() => {
    if (!aiAvailable) setAIMode(null);
  }, [aiAvailable]);

  useEffect(() => registerMobileBackHandler("sheet", () => {
    if (similar || batchRename || aiMode) return false;
    if (nameDialog) { if (!saving) setNameDialog(null); return true; }
    if (moveIds || moveFolder) return false; // The move modal owns its pending operation.
    if (menu) { setMenu(null); return true; }
    if (detail) { setDetail(null); return true; }
    if (sidebar && window.innerWidth < 768) { setSidebar(false); return true; }
    if (pageView !== "files") { setPageView("files"); return true; }
    if (folderId) {
      const parent = folders.find((folder) => folder.id === folderId)?.parentId || null;
      setFolderId(parent); setPage(1); handleClearSelection(); return true;
    }
    return false;
  }), [detail, folderId, folders, handleClearSelection, menu, moveFolder, moveIds, nameDialog, pageView, saving, sidebar, similar, batchRename, aiMode]);
  useLayoutEffect(() => {
    // Restore after the list has rendered; a refresh while hidden is awaited before scrolling.
    if (pageView !== "files" || loading || savedScroll.current === null || !filesScroll.current) return;
    filesScroll.current.scrollTop = savedScroll.current;
    savedScroll.current = null;
  }, [pageView, loading]);

  useEffect(() => {
    const trimmed = input.trim();
    if (trimmed === query) return;
    const timer = setTimeout(() => { setQuery(trimmed); setPage(1); handleClearSelection(); }, 250);
    return () => clearTimeout(timer);
  }, [input, query, handleClearSelection]);
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
      syncPageItems(result.items);
      if (page > 1 && result.total <= (page - 1) * pageSize) setPage(Math.max(1, Math.ceil(result.total / pageSize)));
    }).catch((failure: unknown) => {
      if (!stale && identity() === scope) { setError(failure instanceof Error ? failure.message : String(failure)); setItems([]); }
    }).finally(() => { if (!stale && identity() === scope) setLoading(false); });
    return () => { stale = true; };
  }, [currentFilters, page, sort, revision, scope, syncPageItems]);
  useEffect(() => {
    let stale = false;
    api.attachmentFolders.list().then((result) => {
      if (stale || identity() !== scope) return;
      setFolders(result.folders); setFolderSupport(result.supported !== false); setFolderError("");
      if (folderId && !result.folders.some((folder) => folder.id === folderId)) setFolderId(null);
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
  const changeFilters = (filters: AssetFilters) => { setAssetFilters(filters); setPage(1); handleClearSelection(); setDetail(null); };
  const openSmartFolder = (folder: AssetSmartFolder) => {
    savedScroll.current = null; setPageView("files");
    setSmartFolder(folder); setCategory("all"); setFolderId(folder.filters.folderId || null);
    setAssetFilters(folder.filters); setInput(folder.filters.q || ""); setQuery(folder.filters.q || "");
    setPage(1); handleClearSelection(); setDetail(null); setShowFilters(true); if (window.innerWidth < 768) setSidebar(false);
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
    savedScroll.current = null; setPageView("files");
    setAssetFilters({}); setSmartFolder(null); setShowFilters(false); setCategory(nextCategory); setFolderId(nextFolder); setPage(1); setInput(""); setQuery(""); handleClearSelection(); setDetail(null); if (window.innerWidth < 768) setSidebar(false); setMenu(null);
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
  const select = (item: FileItem, event: React.MouseEvent | React.KeyboardEvent, explicitToggle = false) => {
    const { openedDetail } = handleSelectItem(item, {
      toggle: explicitToggle || event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
    if (openedDetail) setDetail(item.id);
  };
  const deleteFiles = async (ids: string[]) => {
    if (identity() !== scope || saving) return;
    setSaving(true);
    try {
      const result = await runChunkedBatchRemove({ ids, isCurrent: () => identity() === scope, t });
      if (!result.confirmed || identity() !== scope) return;
      handleClearSelection(); setDetail(null); refresh();
    } catch (failure: unknown) {
      if (identity() === scope) toast.error(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (identity() === scope) setSaving(false);
    }
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
  // Only an explicit copy creates the server-issued public link; private URLs are never copied as a fallback.
  const copyPublicImageLink = async (file: FileItem, format: ImageHostFormat): Promise<boolean> => {
    if (!isCurrent()) return false;
    try {
      const url = await createStableFileShareUrl(file.id);
      if (!isCurrent()) return false;
      if (!/^https?:\/\//i.test(url) || !await copyText(formatImageHostSnippet(format, url, file.filename))) {
        if (isCurrent()) toast.error(t("attachmentDetail.copyFailed"));
        return false;
      }
      if (!isCurrent()) return false;
      toast.success(t(file.category === "image" ? "fileExplorer.publicImageLinkCopied" : "fileExplorer.imageHost.copied"));
      return true;
    } catch (failure: unknown) {
      if (isCurrent()) toast.error(failure instanceof Error ? failure.message : t("attachmentDetail.copyFailed"));
      return false;
    }
  };
  const bumpHostLinks = useCallback(() => setHostRevision((value) => value + 1), []);
  const copyQueuedLink = (file: FileItem) => { void copyPublicImageLink(file, "url").then((copied) => { if (copied) bumpHostLinks(); }); };
  const downloadFile = (file: FileItem) => {
    void downloadAttachment(resolveAttachmentUrl(file.url), file.filename).catch((failure: unknown) => toast.error(failure instanceof Error ? failure.message : String(failure)));
  };
  const switchView = (next: FilePageView) => {
    if (next === pageView) return;
    if (pageView === "files") savedScroll.current = filesScroll.current?.scrollTop ?? 0;
    if (next === "imageHost") setVisitedHost(true);
    setMenu(null); setDetail(null); setPageView(next);
  };
  const uploadFolder = pageView === "files" ? folderId : null;
  const showMenu = (event: React.MouseEvent, file?: FileItem, folder?: AssetFolder) => {
    event.preventDefault(); event.stopPropagation();
    setMenu({ file, folder, x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - (file?.category === "image" ? 340 : 290)) });
  };
  const dropOnFolder = async (target: string, event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("application/x-nowen-assets")) return;
    event.preventDefault(); event.stopPropagation();
    try {
      const payload = JSON.parse(event.dataTransfer.getData("application/x-nowen-assets")) as { scope: string; ids: string[] };
      if (payload.scope !== scope || !Array.isArray(payload.ids) || payload.ids.some((id) => !items.some((item) => item.id === id))) return;
      await api.files.move(payload.ids, target, Object.fromEntries(items.filter((item) => payload.ids.includes(item.id)).map((item) => [item.id, item.folderId])));
      if (identity() !== scope) return;
      handleClearSelection(); refresh(); toast.success(t("fileManager.moved", { count: payload.ids.length }));
    } catch (failure: unknown) { toast.error(failure instanceof Error ? failure.message : String(failure)); }
  };

  if (trash) return <AssetTrash onBack={() => { setTrash(false); refresh(); }} isCurrent={isCurrent} />;
  const hasAssetFilters = Object.values(assetFilters).some((value) => value !== undefined && value !== false && (!Array.isArray(value) || value.length > 0));
  const childFolders = (category === "all" && !query && !smartFolder && !hasAssetFilters) ? folders.filter((folder) => folder.parentId === folderId) : [];
  const canManageSelection = selection.length > 0 && selection.every((item) => item.canManage !== false);
  const ActiveHeaderIcon = pageView === "imageHost" ? ImageIcon : pageView === "storage" ? HardDrive : folderId ? FolderOpen : CATEGORY_META[category].icon;

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="relative flex h-full min-h-0 min-w-0 flex-1 bg-app-bg text-tx-primary"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (nameDialog || moveIds || moveFolder || similar || batchRename) return;
        if (menu) { setMenu(null); return; }
        if (detail) { setDetail(null); return; }
        handleClearSelection(); if (window.innerWidth < 768) setSidebar(false);
      }}
      onPaste={(event) => {
        if (pageView === "storage" || (event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
        const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        if (files.length) { event.preventDefault(); queue.enqueue(files, uploadFolder); }
      }}
    >
      {sidebar && (
        <button
          aria-label={t("common.close")}
          className="absolute inset-0 z-20 bg-black/30 backdrop-blur-[2px] md:hidden"
          onClick={() => setSidebar(false)}
        />
      )}

      {/* 左侧轻盈磨砂导览栏 */}
      <aside
        className={cn(
          "flex w-60 shrink-0 flex-col border-r border-app-border/75 bg-app-surface/85 p-3 backdrop-blur-md",
          sidebar ? "absolute inset-y-0 left-0 z-30 shadow-xl md:static md:shadow-none" : "hidden",
        )}
        aria-label={t("fileExplorer.navigation")}
      >
        <div className="mb-3 flex items-center gap-2.5 px-1.5">
          <motion.span
            whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
            transition={{ duration: 0.4 }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/20 via-indigo-400/18 to-violet-500/20 text-sky-600 ring-1 ring-sky-500/20 dark:text-sky-300"
          >
            <FolderOpen size={16} />
          </motion.span>
          <h2 className="text-sm font-bold tracking-tight text-tx-primary">{t("fileExplorer.myFiles")}</h2>
        </div>

        <div className="space-y-0.5">
          {(["all", "recent", "image", "document"] as AssetCategory[]).map((value) => {
            const Icon = CATEGORY_META[value].icon;
            const active = category === value && !folderId && !smartFolder && pageView === "files";
            return (
              <button
                key={value}
                onClick={() => navigate(value)}
                className={cn(
                  "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                  active ? "font-semibold text-accent-primary" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="file-category-pill"
                    transition={MOTION_SPRING.snappy}
                    className="absolute inset-0 rounded-xl bg-accent-primary/10 ring-1 ring-accent-primary/20"
                  />
                )}
                <Icon size={15} className={cn("relative z-10 shrink-0", active ? "text-accent-primary" : CATEGORY_META[value].colorClass)} />
                <span className="relative z-10 truncate">{t(`fileExplorer.${value}`)}</span>
              </button>
            );
          })}
        </div>

        <details className="group/more mt-1.5">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-tx-secondary transition-colors hover:bg-app-hover/70 hover:text-tx-primary">
            <ChevronRight size={13} className="transition-transform duration-200 group-open/more:rotate-90" />
            <span>{t("fileExplorer.more")}</span>
          </summary>
          <div className="mt-0.5 space-y-0.5 pl-2">
            {(["video", "audio", "archive", "unorganized"] as AssetCategory[]).map((value) => {
              const Icon = CATEGORY_META[value].icon;
              const active = category === value && !folderId && !smartFolder && pageView === "files";
              return (
                <button
                  key={value}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm transition-colors",
                    active ? "bg-accent-primary/10 font-medium text-accent-primary" : "text-tx-secondary hover:bg-app-hover/75 hover:text-tx-primary",
                  )}
                  onClick={() => navigate(value)}
                >
                  <Icon size={14} className={cn("shrink-0", active ? "text-accent-primary" : CATEGORY_META[value].colorClass)} />
                  <span className="truncate">{t(`fileExplorer.${value}`)}</span>
                </button>
              );
            })}
          </div>
        </details>

        <div className="mt-5 flex items-center justify-between px-2 text-xs font-semibold text-tx-secondary">
          <span className="flex items-center gap-1.5">
            <Folder size={12} className="text-amber-500 dark:text-amber-400" />
            {t("fileExplorer.myFolders")}
          </span>
          <button
            aria-label={t("fileManager.newFolder")}
            disabled={!folderSupport}
            onClick={() => setNameDialog({ name: "", parentId: folderId })}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-tx-secondary transition-all hover:rotate-90 hover:bg-app-hover hover:text-accent-primary disabled:opacity-30"
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-auto pr-0.5">
          <FileFolderTree
            folders={folders}
            current={folderId}
            onOpen={(id) => navigate("all", id)}
            onMenu={(folder, event) => showMenu(event, undefined, folder)}
            onDrop={(target, event) => void dropOnFolder(target, event)}
          />
          {organization && (
            <AssetOrganizationSidebar
              state={organization}
              activeTags={assetFilters.tagIds || []}
              activeSmart={smartFolder?.id || null}
              onTag={(id) => { navigate("all"); setAssetFilters({ tagIds: [id] }); setShowFilters(true); }}
              onSmart={openSmartFolder}
              onChanged={refresh}
              isCurrent={() => identity() === scope}
            />
          )}
          {organizationError && (
            <p role="alert" className="mt-3 rounded-xl bg-rose-500/10 px-2.5 py-2 text-xs text-rose-600 dark:text-rose-300">
              {organizationError}
              <button onClick={refresh} className="ml-2 underline">{t("fileExplorer.retry")}</button>
            </p>
          )}
          {!folderSupport && (
            <p className="px-2 py-3 text-xs leading-5 text-tx-tertiary">{folderError || t("fileExplorer.folderUnavailable")}</p>
          )}
        </div>

        <button
          className="mt-3 flex items-center gap-2 rounded-xl border border-app-border/65 bg-app-elevated/70 px-3 py-2 text-left text-xs font-medium text-tx-secondary transition-all hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-600 active:scale-[0.98] dark:hover:text-rose-300"
          onClick={() => { handleClearSelection(); setDetail(null); setTrash(true); }}
        >
          <Trash2 size={14} />
          <span>{t("assetTrash.title")}</span>
        </button>
      </aside>

      {/* 右侧主内容区 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 柔和极光背景装饰 */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-60 overflow-hidden">
          <div className="absolute -top-24 left-1/4 h-56 w-80 rounded-full bg-sky-400/10 blur-3xl dark:bg-sky-500/12" />
          <div className="absolute -top-16 right-1/4 h-52 w-72 rounded-full bg-violet-400/10 blur-3xl dark:bg-violet-500/12" />
          <div className="absolute top-6 right-12 h-36 w-52 rounded-full bg-amber-400/8 blur-3xl dark:bg-amber-500/8" />
        </div>

        <header
          className={cn(
            "relative z-10 shrink-0 space-y-2.5 border-b border-app-border/75 bg-app-bg/70 px-3 py-3 backdrop-blur-md md:space-y-3 md:px-5 md:py-3.5",
            pageView === "files" && "max-md:max-h-[50dvh] max-md:overflow-y-auto",
          )}
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              aria-label={t("fileExplorer.navigation")}
              aria-expanded={sidebar}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-app-border/75 bg-app-elevated/80 text-tx-secondary transition-all hover:border-accent-primary/35 hover:bg-app-surface hover:text-tx-primary active:scale-95"
              onClick={() => setSidebar((previous) => !previous)}
            >
              <Menu size={17} />
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <motion.span
                whileHover={{ rotate: [0, -8, 8, 0], scale: 1.07 }}
                transition={{ duration: 0.4 }}
                className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/18 via-indigo-400/15 to-violet-500/18 text-sky-600 ring-1 ring-sky-500/20 sm:flex dark:text-sky-300"
              >
                <ActiveHeaderIcon size={17} />
              </motion.span>
              <h1 className="min-w-0 truncate text-base font-bold tracking-tight text-tx-primary md:text-lg">
                {pageView === "files" ? title : t(`fileExplorer.pageViews.${pageView}`)}
              </h1>
              {pageView === "files" && !loading && (
                <span className="hidden shrink-0 rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium tabular-nums text-sky-700 sm:inline-flex dark:border-sky-400/25 dark:bg-sky-400/15 dark:text-sky-300">
                  {total}
                </span>
              )}
            </div>

            <PageViewTabs value={pageView} onChange={switchView} className="order-last w-full md:order-none md:w-auto" />

            {pageView !== "storage" && (
              <motion.button
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.96 }}
                className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-3.5 text-xs font-semibold text-white shadow-sm shadow-sky-500/25 transition-all hover:from-sky-400 hover:to-indigo-400 md:gap-2 md:text-sm"
                onClick={() => picker.current?.click()}
              >
                <Upload size={15} />
                {t("fileManager.uploadFiles")}
              </motion.button>
            )}

            {pageView === "files" && (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.94 }}
                aria-label={t("fileManager.newFolder")}
                title={t("fileManager.newFolder")}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-app-border/80 bg-app-elevated/85 text-tx-secondary shadow-xs transition-colors hover:border-accent-primary/40 hover:bg-app-surface hover:text-accent-primary disabled:opacity-30"
                disabled={!folderSupport}
                onClick={() => setNameDialog({ name: "", parentId: folderId })}
              >
                <Plus size={17} />
              </motion.button>
            )}
          </div>

          {pageView === "files" && (
            <>
              {/* 面包屑路径胶囊 */}
              <nav aria-label={t("fileExplorer.breadcrumb")} className="flex items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-tx-secondary">
                <button
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-app-hover hover:text-tx-primary"
                  onClick={() => navigate("all")}
                >
                  <Home size={12} className="text-sky-500 dark:text-sky-400" />
                  {t("fileExplorer.all")}
                </button>
                {path.map((folder) => (
                  <span key={folder.id} className="flex shrink-0 items-center gap-1">
                    <ChevronRight size={12} className="text-tx-tertiary" />
                    <button
                      className="rounded-lg px-2 py-1 transition-colors hover:bg-app-hover hover:text-tx-primary"
                      onClick={() => navigate("all", folder.id)}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </nav>

              {/* 磨砂工具条 */}
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-app-border/75 bg-app-elevated/70 p-2 shadow-xs backdrop-blur-sm">
                <label className="relative w-full min-w-0 flex-none md:w-auto md:flex-1">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tx-tertiary" />
                  <input
                    aria-label={t("fileExplorer.search")}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder={t("fileExplorer.search")}
                    className="h-9 w-full rounded-xl border border-app-border/75 bg-app-surface/90 pl-8.5 pr-8 text-sm outline-none transition-all focus:border-accent-primary/60 focus:bg-app-surface focus:ring-2 focus:ring-accent-primary/15"
                  />
                  {input && (
                    <button
                      type="button"
                      aria-label={t("common.clear")}
                      onClick={() => { setInput(""); setQuery(""); setPage(1); }}
                      className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                    >
                      <X size={12} />
                    </button>
                  )}
                </label>

                <select
                  aria-label={t("fileExplorer.sort")}
                  value={sort}
                  onChange={(event) => { setSort(event.target.value as FileSortKey); setPage(1); handleClearSelection(); }}
                  className="h-9 min-w-0 max-w-40 cursor-pointer rounded-xl border border-app-border/75 bg-app-surface/90 px-2.5 text-xs font-medium text-tx-secondary outline-none transition-colors hover:border-accent-primary/35 hover:text-tx-primary focus:border-accent-primary"
                >
                  {sortKeys.map((value) => (
                    <option key={value} value={value}>{t(`fileExplorer.sortKeys.${value}`)}</option>
                  ))}
                </select>

                <div className="flex rounded-xl border border-app-border/75 bg-app-bg/60 p-0.5">
                  {(["grid", "list", ...(category === "image" ? ["masonry"] : [])] as AssetView[]).map((value) => {
                    const Icon = value === "grid" ? LayoutGrid : value === "list" ? List : Columns3;
                    const active = view === value;
                    return (
                      <button
                        key={value}
                        aria-label={t(`fileExplorer.views.${value}`)}
                        aria-pressed={active}
                        onClick={() => chooseView(value)}
                        className={cn(
                          "relative rounded-lg p-1.5 transition-colors",
                          active ? "text-accent-primary" : "text-tx-tertiary hover:text-tx-primary",
                        )}
                      >
                        {active && (
                          <motion.span
                            layoutId="file-view-mode-pill"
                            transition={MOTION_SPRING.snappy}
                            className="absolute inset-0 rounded-lg bg-app-surface shadow-xs ring-1 ring-app-border/70"
                          />
                        )}
                        <Icon size={16} className="relative z-10" />
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  aria-pressed={selectionMode}
                  className={cn(
                    "flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition-all active:scale-95",
                    selectionMode
                      ? "border-accent-primary/40 bg-accent-primary/12 text-accent-primary"
                      : "border-app-border/75 bg-app-surface/85 text-tx-secondary hover:border-accent-primary/35 hover:text-tx-primary",
                  )}
                  onClick={() => { toggleSelectionMode(); setDetail(null); setBatchTags(false); }}
                >
                  <CheckSquare size={14} />
                  {t(selectionMode ? "fileExplorer.exitSelect" : "fileExplorer.select")}
                </button>

                {!!items.length && (
                  <button
                    type="button"
                    className="h-9 rounded-xl border border-app-border/75 bg-app-surface/85 px-2.5 text-xs font-medium text-accent-primary transition-all hover:border-accent-primary/40 hover:bg-accent-primary/10 active:scale-95"
                    onClick={() => { setDetail(null); toggleSelectPage(); }}
                  >
                    {t(allPageSelected ? "fileExplorer.deselectPage" : "fileExplorer.selectAllPage")}
                  </button>
                )}

                {organization?.supported && (
                  <button
                    aria-expanded={showFilters}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition-all active:scale-95",
                      showFilters || hasAssetFilters
                        ? "border-accent-primary/40 bg-accent-primary/12 text-accent-primary"
                        : "border-app-border/75 bg-app-surface/85 text-tx-secondary hover:border-accent-primary/35 hover:text-tx-primary",
                    )}
                    onClick={() => setShowFilters((value) => !value)}
                  >
                    <SlidersHorizontal size={13} />
                    {t("assetOrganization.filters")}
                    {hasAssetFilters && <span className="h-1.5 w-1.5 rounded-full bg-accent-primary" />}
                  </button>
                )}

                {aiAvailable && !Capacitor.isNativePlatform() && (
                  <button
                    onClick={() => setAIMode("search")}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-violet-500/30 bg-violet-500/10 px-2.5 text-xs font-medium text-violet-600 transition-all hover:bg-violet-500/18 active:scale-95 dark:text-violet-300"
                  >
                    <Sparkles size={13} />
                    {t("assetAI.search")}
                  </button>
                )}

                {view === "masonry" && (
                  <input
                    aria-label={t("fileExplorer.density")}
                    type="range"
                    min={130}
                    max={260}
                    step={10}
                    value={density}
                    onChange={(event) => setDensity(Number(event.target.value))}
                    className="w-24 accent-accent-primary"
                  />
                )}
              </div>

              {aiAvailable && Capacitor.isNativePlatform() && (
                <p className="text-xs text-tx-secondary">{t("assetAI.nativeUnavailable")}</p>
              )}
              {showFilters && organization?.supported && (
                <AssetFilterPanel
                  filters={assetFilters}
                  tags={organization.tags}
                  onChange={changeFilters}
                  onSave={() => void saveSmartFolder()}
                  onUpdate={smartFolder ? () => void saveSmartFolder(true) : undefined}
                  onClear={() => navigate("all")}
                />
              )}
            </>
          )}
        </header>

        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => { queue.enqueue(Array.from(event.target.files || []), uploadFolder); event.target.value = ""; }}
        />

        {/* 文件主面板：保持 firstElementChild 为 filesScroll 滚动容器 */}
        <div
          id="file-page-panel-files"
          role="tabpanel"
          aria-labelledby="file-page-tab-files"
          className={cn("relative z-10 flex min-h-0 flex-1 flex-col", pageView !== "files" && "hidden")}
        >
          <div
            ref={filesScroll}
            className={cn(
              "min-h-0 flex-1 overflow-auto p-3.5 transition-colors md:p-5",
              draggingExternalFiles && "bg-sky-500/[0.06] ring-2 ring-inset ring-sky-400/50",
            )}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                if (!draggingExternalFiles) setDraggingExternalFiles(true);
              }
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDraggingExternalFiles(false);
            }}
            onDrop={(event) => {
              setDraggingExternalFiles(false);
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              queue.enqueue(Array.from(event.dataTransfer.files), folderId);
            }}
          >
            {error ? (
              <div role="alert" className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-rose-500/35 bg-rose-500/[0.05] px-6 py-12 text-center text-sm text-rose-600 dark:text-rose-300">
                <p>{error}</p>
                <button
                  className="mt-3 rounded-xl border border-rose-500/35 bg-app-elevated px-3.5 py-1.5 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-500/10 dark:text-rose-300"
                  onClick={refresh}
                >
                  {t("fileExplorer.retry")}
                </button>
              </div>
            ) : loading ? (
              <div role="status" className="space-y-4">
                <div className="flex items-center gap-2 text-xs text-tx-secondary">
                  <Loader2 size={14} className="animate-spin text-accent-primary" />
                  <span>{t("fileExplorer.loading")}</span>
                </div>
                <div
                  className={view === "list" ? "space-y-2.5" : "grid grid-cols-2 gap-3 md:grid-cols-4"}
                >
                  {[0, 1, 2, 3].map((index) => (
                    <div
                      key={index}
                      className={cn(
                        "animate-pulse rounded-2xl border border-app-border/70 bg-app-elevated/70",
                        view === "list" ? "flex items-center gap-3 p-3" : "overflow-hidden",
                      )}
                    >
                      <div className={view === "list" ? "h-10 w-10 rounded-xl bg-app-hover/80" : "h-32 w-full bg-app-hover/70"} />
                      <div className={view === "list" ? "flex-1 space-y-2" : "space-y-2 p-3"}>
                        <div className="h-3.5 w-3/4 rounded-md bg-app-hover/85" />
                        <div className="h-2.5 w-1/2 rounded-md bg-app-hover/60" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {!!childFolders.length && (
                  <div className="mb-4 grid grid-cols-2 gap-2.5 md:mb-5 md:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] md:gap-3">
                    {childFolders.map((folder) => (
                      <button
                        key={folder.id}
                        className="group flex items-center gap-2.5 rounded-2xl border border-app-border/80 bg-app-elevated/85 p-3 text-left text-sm font-medium shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-primary/40 hover:bg-app-surface hover:shadow-md active:scale-[0.98]"
                        onClick={() => navigate("all", folder.id)}
                        onContextMenu={(event) => showMenu(event, undefined, folder)}
                        onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-nowen-assets")) event.preventDefault(); }}
                        onDrop={(event) => void dropOnFolder(folder.id, event)}
                      >
                        <span
                          className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-105",
                            pickFolderTint(folder.id),
                          )}
                        >
                          <Folder size={18} />
                        </span>
                        <span className="min-w-0 truncate text-tx-primary transition-colors group-hover:text-accent-primary">{folder.name}</span>
                      </button>
                    ))}
                  </div>
                )}

                {!items.length && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.28, ease: MOTION_EASE.enter }}
                    className="flex min-h-72 flex-col items-center justify-center rounded-3xl border border-dashed border-app-border/80 bg-app-elevated/60 px-6 py-12 text-center backdrop-blur-sm"
                  >
                    <PlayfulFileCloud
                      onBoop={() => setBoopIndex((prev) => (prev === null ? 0 : (prev + 1) % FILE_CLOUD_BOOP_LINES.length))}
                    />
                    <p className="text-sm font-semibold text-tx-primary">{t(query ? "fileExplorer.noResults" : "fileExplorer.empty")}</p>
                    <p className="mt-1.5 max-w-md text-xs text-tx-secondary">
                      {boopIndex !== null
                        ? FILE_CLOUD_BOOP_LINES[boopIndex]
                        : "拖拽文件到这里，或点击下方按钮立即收入囊中 ✨"}
                    </p>
                    <motion.button
                      whileHover={{ y: -1, scale: 1.02 }}
                      whileTap={{ scale: 0.96 }}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-sky-500/25 transition-all hover:from-sky-400 hover:to-indigo-400"
                      onClick={() => picker.current?.click()}
                    >
                      <Upload size={14} />
                      {t("fileManager.uploadFiles")}
                    </motion.button>
                  </motion.div>
                )}

                {view === "list" && !!items.length && (
                  <div className="mb-2 hidden items-center gap-3 rounded-xl bg-app-elevated/65 px-3 py-2 text-xs font-medium text-tx-tertiary md:flex">
                    <input
                      ref={listSelectAllRef}
                      type="checkbox"
                      aria-label={t(allPageSelected ? "fileExplorer.deselectPage" : "fileExplorer.selectAllPage")}
                      checked={allPageSelected}
                      onChange={toggleSelectPage}
                      className="h-4 w-4 shrink-0 cursor-pointer accent-accent-primary"
                    />
                    <span className="w-10 shrink-0" />
                    <span className="min-w-0 flex-1">{t("fileExplorer.columns.name")}</span>
                    <span className="w-20">{t("fileExplorer.columns.type")}</span>
                    <span className="w-20">{t("fileExplorer.columns.size")}</span>
                    <span className="hidden w-24 lg:block">{t("fileExplorer.columns.created")}</span>
                    <span className="w-28">{t("fileExplorer.columns.location")}</span>
                    <span className="w-7" />
                  </div>
                )}

                <div
                  className={view === "grid" ? "grid grid-cols-2 gap-x-2.5 max-md:!grid-cols-2 md:gap-x-3.5" : view === "list" ? "space-y-2" : "gap-3.5"}
                  style={view === "grid" ? { gridTemplateColumns: `repeat(auto-fill,minmax(min(100%,${density}px),1fr))` } : view === "masonry" ? { columnWidth: density, columnGap: 14 } : undefined}
                >
                  {items.map((item) => (
                    <FileCard
                      key={item.id}
                      item={item}
                      view={view}
                      selected={selected.has(item.id)}
                      selectionMode={selectionMode}
                      hasSelection={selected.size > 0}
                      onSelect={(event) => select(item, event)}
                      onToggleSelect={(event) => select(item, event, true)}
                      onPreview={() => setDetail(item.id)}
                      onMenu={(event) => showMenu(event, item)}
                      onDrag={(event) => {
                        const ids = selected.has(item.id) ? [...selected] : [item.id];
                        event.dataTransfer.setData("application/x-nowen-assets", JSON.stringify({ scope, ids }));
                        event.dataTransfer.effectAllowed = "move";
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* 灵动批量操作浮条 */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-app-border/80 bg-app-elevated/95 px-4 py-2.5 text-xs shadow-sm backdrop-blur-md">
              <span className="inline-flex items-center rounded-full bg-accent-primary/12 px-2.5 py-1 font-semibold text-accent-primary tabular-nums">
                {t("fileExplorer.selected", { count: selected.size })}
              </span>
              {allPageSelected && total > selected.size && (total <= FILE_SELECT_ALL_MATCHES_LIMIT
                ? (
                  <button
                    type="button"
                    disabled={selectingAll || saving}
                    className="rounded-xl bg-sky-500/10 px-2.5 py-1 font-medium text-sky-600 transition-colors hover:bg-sky-500/18 disabled:opacity-40 dark:text-sky-300"
                    onClick={() => void selectAllMatching((targetPage, targetSize) => api.files.list({ ...currentFilters, page: targetPage, pageSize: targetSize, sort }), isCurrent)}
                  >
                    {selectingAll ? t("fileExplorer.loading") : t("fileExplorer.selectAllMatching", { count: total })}
                  </button>
                )
                : <span className="text-tx-tertiary">{t("fileExplorer.selectAllTooMany", { max: FILE_SELECT_ALL_MATCHES_LIMIT })}</span>)}
              <button
                disabled={!folderSupport || !canManageSelection || saving}
                className="rounded-xl border border-app-border/75 bg-app-surface px-2.5 py-1 font-medium text-accent-primary transition-colors hover:bg-accent-primary/10 disabled:opacity-30"
                onClick={() => { setMoveExpectedFolderIds(undefined); setMoveIds([...selected]); }}
              >
                {t("fileManager.moveFiles")}
              </button>
              <button
                className="rounded-xl border border-app-border/75 bg-app-surface px-2.5 py-1 font-medium text-tx-primary transition-colors hover:bg-app-hover"
                onClick={async () => {
                  try {
                    for (const file of selection) await downloadAttachment(resolveAttachmentUrl(file.url), file.filename);
                  } catch (failure: unknown) {
                    toast.error(failure instanceof Error ? failure.message : String(failure));
                  }
                }}
              >
                {t("attachmentDetail.downloadFile")}
              </button>
              <button
                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 font-medium text-rose-600 transition-colors hover:bg-rose-500/18 disabled:opacity-30 dark:text-rose-300"
                disabled={!canManageSelection || saving}
                onClick={() => void deleteFiles([...selected])}
              >
                {t("assetTrash.move")}
              </button>
              <button
                disabled={!organization?.supported || !canManageSelection || saving}
                className="rounded-xl border border-app-border/75 bg-app-surface px-2.5 py-1 font-medium text-accent-primary transition-colors hover:bg-accent-primary/10 disabled:opacity-30"
                onClick={() => setBatchTags((value) => !value)}
              >
                {t("assetOrganization.batchTags")}
              </button>
              <button
                disabled={!canManageSelection || saving || selection.length > FILE_BATCH_CHUNK_LIMIT}
                title={selection.length > FILE_BATCH_CHUNK_LIMIT ? t("fileExplorer.batchLimitHint", { max: FILE_BATCH_CHUNK_LIMIT }) : undefined}
                className="rounded-xl border border-app-border/75 bg-app-surface px-2.5 py-1 font-medium text-accent-primary transition-colors hover:bg-accent-primary/10 disabled:opacity-30"
                onClick={() => setBatchRename(true)}
              >
                {t("assetTools.rename")}
              </button>
              <button
                className="ml-auto rounded-xl px-2.5 py-1 text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
                onClick={handleClearSelection}
              >
                {t("common.cancel")}
              </button>
            </div>
          )}

          {batchTags && selected.size > 0 && (
            <div className="max-h-64 overflow-auto border-t border-app-border/80 bg-app-surface/90 p-3">
              <AssetTagEditor ids={[...selected]} onChanged={refresh} />
            </div>
          )}

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-app-border/75 bg-app-elevated/60 px-4 py-2 text-xs text-tx-secondary backdrop-blur-sm">
            <span className="tabular-nums">
              {t("fileExplorer.fileCount", { count: total })} · {t("fileExplorer.page", { page, total: Math.max(1, Math.ceil(total / pageSize)) })}
            </span>
            <div className="flex items-center gap-2">
              <button
                disabled={page === 1 || loading}
                className="rounded-xl border border-app-border/75 bg-app-surface/85 px-3 py-1 font-medium transition-colors hover:border-accent-primary/35 hover:text-tx-primary disabled:opacity-35"
                onClick={() => setPage((previous) => previous - 1)}
              >
                {t("fileExplorer.previous")}
              </button>
              <button
                disabled={page * pageSize >= total || loading}
                className="rounded-xl border border-app-border/75 bg-app-surface/85 px-3 py-1 font-medium transition-colors hover:border-accent-primary/35 hover:text-tx-primary disabled:opacity-35"
                onClick={() => setPage((previous) => previous + 1)}
              >
                {t("fileExplorer.next")}
              </button>
            </div>
          </footer>
        </div>

        {visitedHost && (
          <div id="file-page-panel-imageHost" role="tabpanel" aria-labelledby="file-page-tab-imageHost" className={cn("relative z-10 flex min-h-0 flex-1 flex-col", pageView !== "imageHost" && "hidden")}>
            <ImageHostView
              active={pageView === "imageHost"}
              refreshKey={`${revision}:${hostRevision}`}
              isCurrent={isCurrent}
              onUpload={() => picker.current?.click()}
              onDropFiles={(files) => queue.enqueue(files, null)}
              onOpen={setDetail}
              onCopyLink={copyPublicImageLink}
              onDownload={downloadFile}
              onDeleted={refresh}
              onMoveFiles={folderSupport ? (ids, expected) => { setMoveExpectedFolderIds(expected); setMoveIds(ids); } : undefined}
            />
          </div>
        )}

        {pageView === "storage" && (
          <div id="file-page-panel-storage" role="tabpanel" aria-labelledby="file-page-tab-storage" className="relative z-10 flex min-h-0 flex-1 flex-col">
            <StorageToolsView refreshKey={revision} isCurrent={isCurrent} onCleaned={refresh} onGo={switchView} />
          </div>
        )}

        <FileUploadQueue
          queue={queue}
          onView={setDetail}
          onMove={(id) => { setMoveExpectedFolderIds(undefined); setMoveIds([id]); }}
          onCopyLink={pageView === "imageHost" ? copyQueuedLink : undefined}
        />
      </main>

      {detail && (
        <AttachmentDetailDrawer
          embedded
          attachmentId={detail}
          onClose={closeDetail}
          onJumpToNote={jumpToNote}
          showDelete
          onAfterDelete={refresh}
          onAfterRename={refresh}
          onAfterMove={refresh}
          onAfterOrganize={refresh}
          onOpenAttachment={setDetail}
          onFindSimilar={setSimilar}
          isImageHostMode={pageView === "imageHost"}
          onAfterLinkChange={bumpHostLinks}
        />
      )}
      {similar && <SimilarImages key={similar.id} source={similar} isCurrent={isCurrent} onClose={() => setSimilar(null)} onOpen={setDetail} />}
      {aiAvailable && aiMode && (
        <Suspense fallback={null}>
          <AssetAIDialog
            mode={aiMode}
            files={(selection.length ? selection : items).filter((file) => file.canManage !== false).slice(0, 50)}
            isCurrent={isCurrent}
            onClose={() => setAIMode(null)}
            onApplied={() => { handleClearSelection(); refresh(); }}
            onOpen={setDetail}
          />
        </Suspense>
      )}
      {batchRename && <BatchRenameDialog files={selection} isCurrent={isCurrent} onClose={() => setBatchRename(false)} onRenamed={() => { handleClearSelection(); refresh(); }} />}
      {(moveIds || moveFolder) && (
        <FileMoveDialog
          ids={moveIds || []}
          folderToMove={moveFolder || undefined}
          expectedFolderIds={moveIds ? (moveExpectedFolderIds ?? Object.fromEntries(selection.concat(items).filter((item) => moveIds.includes(item.id)).map((item) => [item.id, item.folderId]))) : undefined}
          onClose={() => { setMoveIds(null); setMoveExpectedFolderIds(undefined); setMoveFolder(null); }}
          onMoved={() => { handleClearSelection(); refresh(); }}
        />
      )}
      {nameDialog && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4 backdrop-blur-xs">
          <form
            role="dialog"
            aria-modal="true"
            aria-label={t(nameDialog.id || nameDialog.file ? "attachmentDetail.rename" : "fileManager.newFolder")}
            onSubmit={(event) => { event.preventDefault(); void saveName(); }}
            onKeyDown={(event) => { if (event.key === "Escape" && !saving) setNameDialog(null); }}
            className="w-full max-w-sm rounded-2xl border border-app-border/80 bg-app-elevated/95 p-5 shadow-2xl backdrop-blur-xl"
          >
            <h2 className="text-sm font-semibold text-tx-primary">{t(nameDialog.id || nameDialog.file ? "attachmentDetail.rename" : "fileManager.newFolder")}</h2>
            <input
              autoFocus
              aria-label={t("fileManager.folderName")}
              value={nameDialog.name}
              maxLength={nameDialog.file ? 255 : 100}
              onChange={(event) => setNameDialog({ ...nameDialog, name: event.target.value })}
              className="mt-4 w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm outline-none focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/15"
            />
            <div className="mt-4 flex justify-end gap-2 text-xs font-medium">
              <button
                type="button"
                disabled={saving}
                className="rounded-xl px-3 py-2 text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
                onClick={() => setNameDialog(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={saving || !nameDialog.name.trim()}
                className="rounded-xl bg-accent-primary px-4 py-2 text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-35"
              >
                {t("attachmentDetail.save")}
              </button>
            </div>
          </form>
        </div>
      )}
      {menu && (
        <>
          <button className="fixed inset-0 z-[110] cursor-default" aria-label={t("common.close")} onClick={() => setMenu(null)} />
          <div
            role="menu"
            className="fixed z-[111] w-52 overflow-y-auto rounded-2xl border border-app-border/80 bg-app-elevated/95 p-1.5 text-sm shadow-2xl backdrop-blur-xl"
            style={{ left: Math.max(4, menu.x), top: Math.max(4, menu.y), maxHeight: window.innerHeight - Math.max(4, menu.y) - 4 }}
          >
            {menu.file ? (
              <>
                <MenuAction onClick={() => setDetail(menu.file!.id)} close={() => setMenu(null)}>{t("fileExplorer.preview")}</MenuAction>
                {menu.file.category === "image" && <MenuAction onClick={() => setSimilar(menu.file!)} close={() => setMenu(null)}>{t("assetTools.similar")}</MenuAction>}
                <MenuAction onClick={() => { void downloadAttachment(resolveAttachmentUrl(menu.file!.url), menu.file!.filename).catch((failure: unknown) => toast.error(failure instanceof Error ? failure.message : String(failure))); }} close={() => setMenu(null)}>{t("attachmentDetail.downloadFile")}</MenuAction>
                {menu.file.canManage !== false && (
                  <>
                    <MenuAction onClick={() => setNameDialog({ file: menu.file, name: menu.file!.filename })} close={() => setMenu(null)}>{t("attachmentDetail.rename")}</MenuAction>
                    <MenuAction disabled={!folderSupport} onClick={() => setMoveIds([menu.file!.id])} close={() => setMenu(null)}>{t("fileManager.moveFiles")}</MenuAction>
                  </>
                )}
                <MenuAction onClick={async () => { const link = new URL(`${getBaseUrl().replace(/\/+$/, "")}/attachments/${encodeURIComponent(menu.file!.id)}`, window.location.href).href; if (await copyText(link)) toast.success(t("fileExplorer.privateLinkCopied")); }} close={() => setMenu(null)}>{t("fileExplorer.copyPrivateLink")}</MenuAction>
                {menu.file.category === "image" && (
                  <>
                    <MenuAction onClick={() => void copyPublicImageLink(menu.file!, "markdown")} close={() => setMenu(null)}>{t("fileExplorer.copyPublicMarkdownLink")}</MenuAction>
                    <MenuAction onClick={() => void copyPublicImageLink(menu.file!, "url")} close={() => setMenu(null)}>{t("fileExplorer.copyPublicAbsoluteLink")}</MenuAction>
                  </>
                )}
                <MenuAction onClick={() => setDetail(menu.file!.id)} close={() => setMenu(null)}>{t("attachmentDetail.referencedNotes")}</MenuAction>
                {menu.file.canManage !== false && <MenuAction danger onClick={() => void deleteFiles([menu.file!.id])} close={() => setMenu(null)}>{t("assetTrash.move")}</MenuAction>}
              </>
            ) : menu.folder && (
              <>
                <MenuAction onClick={() => navigate("all", menu.folder!.id)} close={() => setMenu(null)}>{t("fileExplorer.open")}</MenuAction>
                <MenuAction onClick={() => setNameDialog({ name: "", parentId: menu.folder!.id })} close={() => setMenu(null)}>{t("fileExplorer.newSubfolder")}</MenuAction>
                <MenuAction onClick={() => setNameDialog({ id: menu.folder!.id, name: menu.folder!.name })} close={() => setMenu(null)}>{t("attachmentDetail.rename")}</MenuAction>
                <MenuAction onClick={() => setMoveFolder(menu.folder!)} close={() => setMenu(null)}>{t("fileManager.moveFiles")}</MenuAction>
                <MenuAction danger onClick={async () => { if (!await confirm({ title: t("fileExplorer.deleteFolder"), description: t("fileExplorer.emptyFolderOnly"), danger: true }) || identity() !== scope) return; try { await api.attachmentFolders.remove(menu.folder!.id); refresh(); } catch (failure: unknown) { toast.error(failure instanceof Error ? failure.message : String(failure)); } }} close={() => setMenu(null)}>{t("fileExplorer.deleteFolder")}</MenuAction>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const PAGE_VIEW_ICONS: Record<FilePageView, typeof Files> = {
  files: Files,
  imageHost: ImageIcon,
  storage: HardDrive,
};

function PageViewTabs({ value, onChange, className }: { value: FilePageView; onChange: (view: FilePageView) => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t("fileExplorer.pageViews.label")}
      className={cn("flex rounded-xl border border-app-border/80 bg-app-elevated/80 p-0.5 shadow-xs backdrop-blur-sm", className)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = pageViews[(pageViews.indexOf(value) + (event.key === "ArrowRight" ? 1 : pageViews.length - 1)) % pageViews.length];
        onChange(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`#file-page-tab-${next}`)?.focus();
      }}
    >
      {pageViews.map((view) => {
        const active = value === view;
        const Icon = PAGE_VIEW_ICONS[view];
        return (
          <button
            key={view}
            type="button"
            role="tab"
            id={`file-page-tab-${view}`}
            aria-selected={active}
            aria-controls={active ? `file-page-panel-${view}` : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(view)}
            className={cn(
              "relative flex min-h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs transition-colors md:flex-none md:text-sm",
              active ? "font-semibold text-accent-primary" : "text-tx-secondary hover:text-tx-primary",
            )}
          >
            {active && (
              <motion.span
                layoutId="file-page-view-pill"
                transition={MOTION_SPRING.snappy}
                className="absolute inset-0 rounded-lg bg-app-surface shadow-xs ring-1 ring-app-border/75"
              />
            )}
            <Icon size={14} className="relative z-10 shrink-0" />
            <span className="relative z-10">{t(`fileExplorer.pageViews.${view}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

function MenuAction({ children, onClick, close, danger, disabled }: { children: React.ReactNode; onClick: () => void; close: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      className={cn(
        "block w-full rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors disabled:opacity-30",
        danger ? "text-rose-600 hover:bg-rose-500/10 dark:text-rose-400" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
      )}
      onClick={() => { onClick(); close(); }}
    >
      {children}
    </button>
  );
}
