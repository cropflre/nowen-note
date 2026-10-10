import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, Upload, CheckCircle, Loader2, FileText, AlertCircle, Trash2, FileUp, FolderDown, AlertTriangle, Database, HardDrive, RefreshCw, Eraser, Minimize2, Save, ShieldAlert, Lock, X, ChevronRight, BookOpen, ExternalLink, ServerCog, Package, Smartphone, FolderOpen, Heart, ListTodo } from "lucide-react";
import { useTranslation } from "react-i18next";
import { exportAllNotes, ExportProgress } from "@/lib/exportService";
import {
  readMarkdownFiles, readMarkdownFromZipWithMeta, importNotes,
  ImportFileInfo, ImportProgress,
  type ImportTargetContentFormat,
  PDF_NO_TEXT_LAYER_FLAG, PDF_TOO_LARGE_FLAG, MAX_PDF_SIZE,
} from "@/lib/importService";
import { useApp, useAppActions } from "@/store/AppContext";
import { api, withSudo, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { toast } from "@/lib/toast";
import { storeAuthTokens } from "@/lib/authSession";
import { scheduleObjectUrlRevocation } from "@/lib/reliableExportDownloadBridge";
import {
  chooseDesktopDataDir,
  getAppInfo,
  getDesktopDataDirInfo,
  getDiagnosticsInfo,
  isDesktop as isDesktopApp,
  migrateDesktopDataDir,
  openDataDir,
  resetDesktopLocalAuth,
  type AppInfo,
  type DataDirInfo,
} from "@/lib/desktopBridge";
import { confirm as confirmDialog, prompt as promptDialog } from "@/components/ui/confirm";
import MiCloudImport from "@/components/MiCloudImport";
import OppoCloudImport from "@/components/OppoCloudImport";
import ICloudImport from "@/components/iCloudImport";
import YoudaoImport from "@/components/YoudaoImport";
import ObsidianImport from "@/components/ObsidianImport";
import YuqueFileImport from "@/components/YuqueFileImport";
import WeChatFavoritesImport from "@/components/WeChatFavoritesImport";
import UrlImport from "@/components/UrlImport";
import RemoteImageLocalizationPanel from "@/components/RemoteImageLocalizationPanel";
import {
  IMPORT_METHOD_GROUPS,
  persistImportMethod,
  readImportMethod,
  shouldResetSharedFileImport,
  type ImportMethod,
} from "@/lib/importHub";
import type { User, Workspace } from "@/types";
import { openTaskDataTransfer } from "@/lib/taskDataTransferBridge";
import BackupCenter from "./dataManagement/BackupCenter";
import DataTransferCenter from "./dataManagement/DataTransferCenter";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";

// Scope is selected only inside import/export workflows.
type Scope = "personal" | "workspace";
type SubTab = "export" | "import";
type MobileMemoMethod = "xiaomi" | "oppo" | "iphone";

const IMPORT_FORMAT_STORAGE = {
  siyuan: "nowen-import-format:siyuan",
  generic: "nowen-import-format:generic-markdown",
} as const;

function readImportFormat(
  key: string,
  fallback: ImportTargetContentFormat,
): ImportTargetContentFormat {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value === "markdown" || value === "tiptap-json" ? value : fallback;
  } catch {
    return fallback;
  }
}

function hasPersistedImportFormat(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const value = window.localStorage.getItem(key);
    return value === "markdown" || value === "tiptap-json";
  } catch {
    return false;
  }
}

function persistImportFormat(key: string, value: ImportTargetContentFormat): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, value); } catch { /* storage may be disabled */ }
}

function isMarkdownImportSource(source?: string): boolean {
  const value = String(source || "").toLowerCase();
  return !value || value === "md" || value === "markdown" || value === "siyuan";
}

function isSiyuanNativePackageFilename(filename: string): boolean {
  // 浏览器重复下载通常会把 foo.sy.zip 重命名为 foo.sy (1).zip。
  return /\.sy(?:\s*\(\d+\))?\.zip$/i.test(filename);
}

function DesktopDataSafetyCard({ currentUser }: { currentUser: Pick<User, "id" | "username"> | null }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [resetting, setResetting] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!isDesktopApp()) return;
    // SEC-ELECTRON-01-C: 分开获取安全信息和诊断信息
    getAppInfo().then(setInfo).catch(() => {});
    getDesktopDataDirInfo().then((dir) => {
      if (dir?.ok) setDataDirInfo(dir);
    }).catch(() => {});
    getDiagnosticsInfo().then((diag) => {
      if (diag) setInfo((prev) => prev ? { ...prev, ...diag } : prev);
    }).catch(() => { });
  }, []);

  if (!isDesktopApp() || !info) return null;

  const isFullLocal = (dataDirInfo?.mode ?? info.mode) !== "lite";
  const currentDataDir = dataDirInfo?.currentPath || info.userData || "";

  const handleOpenDataDir = async () => {
    const res = await openDataDir();
    if (!res.ok) setMessage(t("desktopSafety.openFailed"));
  };

  const formatMigrationError = (error?: string) => {
    const messages: Record<string, string> = {
      INVALID_PATH: t("desktopSafety.invalidPath"),
      TARGET_IS_CURRENT: t("desktopSafety.samePath"),
      TARGET_INSIDE_CURRENT: t("desktopSafety.insideCurrent"),
      TARGET_IS_ROOT: t("desktopSafety.rootPath"),
      TARGET_INSIDE_APP: t("desktopSafety.insideApp"),
      TARGET_NOT_DIRECTORY: t("desktopSafety.notFolder"),
      TARGET_NOT_EMPTY: t("desktopSafety.targetNotEmpty"),
      LITE_MODE: t("desktopSafety.liteMode"),
      CREATE_TARGET_FAILED: t("desktopSafety.createTargetFailed"),
    };
    return messages[error || ""] || error || "unknown";
  };

  const handleChangeDataDir = async () => {
    if (!isFullLocal) {
      setMessage(t("desktopSafety.liteInfo"));
      return;
    }

    const picked = await chooseDesktopDataDir();
    if (picked.canceled) return;
    if (!picked.ok || !picked.path) {
      setMessage(t("desktopSafety.chooseFailed", { error: formatMigrationError(picked.error) }));
      return;
    }

    const ok = await confirmDialog({
      title: t("desktopSafety.migrationTitle"),
      description: t("desktopSafety.migrationDescription", { path: picked.path }),
      confirmText: t("desktopSafety.migrateRestart"),
      cancelText: t("desktopSafety.cancel"),
      danger: true,
    });
    if (!ok) return;

    setMigrating(true);
    setMessage(t("desktopSafety.migrating"));
    const res = await migrateDesktopDataDir(picked.path);
    setMigrating(false);
    if (res.ok) {
      setMessage(t("desktopSafety.migrated"));
    } else {
      const restartHint = res.restartError ? t("desktopSafety.backendRestartFailed", { error: res.restartError }) : "";
      setMessage(t("desktopSafety.migrationFailed", { error: formatMigrationError(res.error), hint: restartHint }));
    }
  };

  const handleResetLocalAuth = async () => {
    if (!isFullLocal) return;
    setResetting(true);
    setMessage("");
    const res = await resetDesktopLocalAuth();
    setResetting(false);
    if (res.ok && res.token) {
      storeAuthTokens({ token: res.token, refreshToken: res.refreshToken ?? null });
      setMessage(t("desktopSafety.authRestored"));
      window.setTimeout(() => window.location.reload(), 400);
    } else {
      setMessage(t("desktopSafety.restoreFailed", { error: res.error || res.reason || "unknown" }));
    }
  };

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-800/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center">
            <HardDrive className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("desktopSafety.dataLocation")}</h4>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 break-all">{currentDataDir}</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
              {isFullLocal
                ? t("desktopSafety.dbAndLogs", { path: info.logDir })
                : t("desktopSafety.remoteLite")}
              {dataDirInfo?.isCustom ? t("desktopSafety.customDirectory") : ""}
            </p>
            {isFullLocal && currentUser && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 break-all">
                {t("desktopSafety.currentAccount", { username: currentUser.username, id: currentUser.id })}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleOpenDataDir}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {t("desktopSafety.openFolder")}
          </button>
          {isFullLocal && (
            <button
              type="button"
              onClick={handleChangeDataDir}
              disabled={migrating}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-900/50 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/10 disabled:opacity-60 transition-colors"
            >
              {migrating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderDown className="w-3.5 h-3.5" />}
              {t("desktopSafety.changeLocation")}
            </button>
          )}
          {isFullLocal && (
            <button
              type="button"
              onClick={handleResetLocalAuth}
              disabled={resetting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-900/50 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/10 disabled:opacity-60 transition-colors"
            >
              {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
              {t("desktopSafety.restoreLocalAuth")}
            </button>
          )}
        </div>
      </div>
      {message && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{message}</p>}
    </section>
  );
}

export default function DataManager() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  // -----------------------------------------------------------------
  // 入口闸门：拉一次 me 判断是否为系统管理员 + 读取 per-user 功能开关
  //   - admin：允许实例备份、维护和工作区迁移
  //   - 普通用户：仅展示 personal，且 personal 的导出/导入再叠加一层由管理员
  //     在「用户管理」里对该用户设置的开关（personalExport/Import Enabled）
  //     进行禁用或隐藏。
  //
  // 注：v6 起这两个开关从站点级 system_settings 下沉为 users 表 per-user 字段，
  // 这里直接从 /api/me 读最新值；老后端若不返回字段则按 true 兜底保持原行为。
  // -----------------------------------------------------------------
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [currentUser, setCurrentUser] = useState<Pick<User, "id" | "username"> | null>(null);
  const [personalExportAllowed, setPersonalExportAllowed] = useState(true);
  const [personalImportAllowed, setPersonalImportAllowed] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => {
        if (cancelled) return;
        setIsAdmin((u as any)?.role === "admin");
        setCurrentUser(u?.id && u?.username ? { id: u.id, username: u.username } : null);
        // 老后端可能不返回这两个字段——按 true 兜底，保持原行为。
        const exp = (u as any)?.personalExportEnabled;
        const imp = (u as any)?.personalImportEnabled;
        setPersonalExportAllowed(exp === undefined ? true : !!exp);
        setPersonalImportAllowed(imp === undefined ? true : !!imp);
      })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, []);

  // personal scope 导出/导入是否被管理员关闭。仅对非 admin 生效——管理员
  // 始终不受开关约束（管理员保有数据救援能力）。
  const personalExportLocked = isAdmin === false && !personalExportAllowed;
  const personalImportLocked = isAdmin === false && !personalImportAllowed;

  // -----------------------------------------------------------------
  // 导入/导出流程状态
  // -----------------------------------------------------------------
  const [scope, setScope] = useState<Scope>("personal");
  const [activeSubTab, setActiveSubTab] = useState<SubTab | null>(null);

  // -----------------------------------------------------------------
  // 工作区列表（仅在 scope=workspace 时使用，用于下拉选择目标工作区）
  // -----------------------------------------------------------------
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  useEffect(() => {
    if (scope !== "workspace") return;
    let cancelled = false;
    api.getWorkspaces()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(list || []);
        // 自动选中第一个工作区，避免空态
        if ((list?.length ?? 0) > 0 && !selectedWorkspaceId) {
          setSelectedWorkspaceId(list[0].id);
        }
      })
      .catch(() => { if (!cancelled) setWorkspaces([]); });
    return () => { cancelled = true; };
    // selectedWorkspaceId 不依赖：仅首次拉列表时尝试默认选中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  /** 当前 scope 实际要传给 export/import API 的 workspaceId 字符串：
   *   - personal → "personal"
   *   - workspace → 用户在下拉里选的工作区 id（未选时返回 "" 表示尚未就绪）
   */
  const effectiveWorkspaceId: string = useMemo(() => {
    if (scope === "personal") return "personal";
    if (scope === "workspace") return selectedWorkspaceId || "";
    return "";
  }, [scope, selectedWorkspaceId]);

  const selectedWorkspaceName = useMemo(() => {
    if (scope !== "workspace") return "";
    return workspaces.find((w) => w.id === selectedWorkspaceId)?.name ?? "";
  }, [scope, selectedWorkspaceId, workspaces]);

  // Export state
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingNowen, setIsExportingNowen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"markdown" | "nowen">("markdown");

  // Import state
  const [importFiles, setImportFiles] = useState<ImportFileInfo[]>([]);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [serverSiyuanFile, setServerSiyuanFile] = useState<File | null>(null);
  const [siyuanImportContentFormat, setSiyuanImportContentFormat] = useState<ImportTargetContentFormat>(
    () => readImportFormat(IMPORT_FORMAT_STORAGE.siyuan, "tiptap-json"),
  );
  const [genericImportContentFormat, setGenericImportContentFormat] = useState<ImportTargetContentFormat>(
    () => readImportFormat(IMPORT_FORMAT_STORAGE.generic, "markdown"),
  );
  // A persisted choice and an explicit click are authoritative. Package inspection may only
  // recommend a default before the user has selected a format.
  const siyuanImportFormatUserSelectedRef = useRef(
    hasPersistedImportFormat(IMPORT_FORMAT_STORAGE.siyuan),
  );
  const [activeImportMethod, setActiveImportMethod] = useState<ImportMethod>(() => readImportMethod());
  const [activeMobileMemoMethod, setActiveMobileMemoMethod] = useState<MobileMemoMethod>("xiaomi");
  const selectSiyuanImportContentFormat = useCallback((format: ImportTargetContentFormat) => {
    siyuanImportFormatUserSelectedRef.current = true;
    setSiyuanImportContentFormat(format);
  }, []);
  const recommendSiyuanImportContentFormat = useCallback((format: ImportTargetContentFormat) => {
    if (siyuanImportFormatUserSelectedRef.current) return;
    setSiyuanImportContentFormat(format);
  }, []);

  useEffect(() => persistImportMethod(activeImportMethod), [activeImportMethod]);
  useEffect(
    () => persistImportFormat(IMPORT_FORMAT_STORAGE.siyuan, siyuanImportContentFormat),
    [siyuanImportContentFormat],
  );
  useEffect(
    () => persistImportFormat(IMPORT_FORMAT_STORAGE.generic, genericImportContentFormat),
    [genericImportContentFormat],
  );
  // 记录"上一次导入实际落到的 workspaceId"和导入数量。
  //   - 当目标 ≠ 当前侧边栏 workspace 时，用于渲染"切到该工作区查看"的提示，
  //     避免出现"点完导入说成功、但侧边栏里看不到笔记"的体感（实际写入了别的空间）。
  //   - workspaceId 取值：'personal' 或 <uuid>，与 effectiveWorkspaceId 同语义。
  const [lastImportTarget, setLastImportTarget] = useState<{
    workspaceId: string;
    workspaceName: string;
    count: number;
  } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  // 笔记导入阶段的错误提示（例如 PDF 超过 50MB / PDF 无文本层 / 解析失败）。
  // 在 Dropzone 下方以红字展示，重新选文件或点击取消时清空。
  const [notesImportError, setNotesImportError] = useState<string>("");
  const [notesImportNotice, setNotesImportNotice] = useState<{
    kind: "siyuan" | "warning";
    messages: string[];
  } | null>(null);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string>("");
  // 新增：是否"为每个文件创建以文件名命名的外层笔记本"
  const [perFileNotebook, setPerFileNotebook] = useState(false);
  // 新增：同名笔记本处理策略 - "merge" 合并 / "unique" 自动编号
  const [duplicateStrategy, setDuplicateStrategy] = useState<"merge" | "unique">("merge");
  // 当前导入批次是否包含 zip（zip 本身按目录派生笔记本，不需要 perFile 开关）
  const [hasZip, setHasZip] = useState(false);
  // P1-2：nanowen-note 自家导出 zip 在 metadata.json 中会携带 rootNotebookId；
  // 如果当前工作区中仍有同 id 的笔记本，则自动预选，避免用户手动找一遍。
  // 未命中时也给个提示（例如“该备份来自另一个实例/工作区，仍会导入但不会自动选目标本”）。
  const [zipMetaHint, setZipMetaHint] = useState<
    | { kind: "matched"; notebookName: string }
    | { kind: "missing"; rootNotebookName?: string }
    | null
  >(null);
  // 导出时是否把图片内嵌为 base64（默认 false：外置到 assets/ 目录，体积小、可读性好）
  const [exportInlineImages, setExportInlineImages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 全量导出 —— 按当前 scope（个人空间 / 工作区）
  const handleExportAll = async () => {
    if (!effectiveWorkspaceId) return; // 工作区 scope 但未选中，按钮已禁用，这里再防御
    setIsExporting(true);
    setExportProgress(null);
    await exportAllNotes(
      (p) => setExportProgress(p),
      { inlineImages: exportInlineImages, workspaceId: effectiveWorkspaceId },
    );
    setIsExporting(false);
  };

  // Nowen 数据包导出
  const handleExportNowenPackage = async () => {
    setIsExportingNowen(true);
    try {
      if (!effectiveWorkspaceId) return;
      const { blob, filename } = await api.downloadNowenPackage({ workspaceId: effectiveWorkspaceId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      scheduleObjectUrlRevocation(url);
      toast.success(t('note.nowenPackageSuccess'));
    } catch (err: any) {
      console.error("[NowenPackageExport] Failed:", err);
      toast.error(t('note.nowenPackageFailed'));
    } finally {
      setIsExportingNowen(false);
    }
  };

  // 拖拽处理
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    await processFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(e.target.files);
    }
  };

  const getImportSourceLabel = (source?: string): string => {
    switch (source?.toLowerCase()) {
      case "siyuan-sy":
        return t("dataManager.importSourceSiyuanSy");
      case "siyuan":
        return t("dataManager.importSourceSiyuanMarkdown");
      case "md":
      case "markdown":
        return t("dataManager.importSourceMarkdown");
      case "html":
      case "htm":
        return t("dataManager.importSourceHtml");
      case "pdf":
        return t("dataManager.importSourcePdf");
      case "txt":
        return t("dataManager.importSourceTxt");
      default:
        return t("dataManager.importSourceGeneric");
    }
  };

  const getImportSourceTone = (source?: string): string => {
    switch (source?.toLowerCase()) {
      case "siyuan-sy":
        return "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/50 dark:bg-violet-500/10 dark:text-violet-300";
      case "siyuan":
        return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-300";
      case "md":
      case "markdown":
        return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-500/10 dark:text-sky-300";
      case "html":
      case "htm":
        return "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/50 dark:bg-orange-500/10 dark:text-orange-300";
      case "pdf":
        return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-300";
      case "txt":
        return "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300";
      default:
        return "border-zinc-200 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400";
    }
  };

  const getNotebookPathText = (file: ImportFileInfo): string =>
    file.notebookPath?.filter(Boolean).join(" / ") || "";

  const getSiyuanUnsupportedNodeLabel = (nodeType: string): string => {
    const key = `dataManager.siyuanUnsupportedNode.${nodeType}`;
    const translated = t(key);
    return translated === key ? nodeType : translated;
  };

  const formatUnsupportedNodesSummary = (unsupportedNodes: Record<string, number>): string => {
    const entries = Object.entries(unsupportedNodes)
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return "";
    const shown = entries.slice(0, 8);
    const summary = shown
      .map(([type, count]) => `${getSiyuanUnsupportedNodeLabel(type)} x${count}`)
      .join(", ");
    const remaining = entries.length - shown.length;
    return remaining > 0 ? `${summary} (+${remaining})` : summary;
  };

  const processFiles = async (files: FileList) => {
    setNotesImportError("");
    setNotesImportNotice(null);
    setServerSiyuanFile(null);
    let result: ImportFileInfo[] = [];
    const fileArray = Array.from(files);
    const zipFile = fileArray.find((f) => f.name.toLowerCase().endsWith(".zip"));

    try {
      if (zipFile) {
        const isSiyuanSyZip = isSiyuanNativePackageFilename(zipFile.name);
        if (activeImportMethod === "siyuan" && isSiyuanSyZip) {
          // .sy 是结构化块数据，富文本能保留更多结构，按来源切换推荐默认值。
          recommendSiyuanImportContentFormat("tiptap-json");
          setServerSiyuanFile(zipFile);
          result = [{
            name: zipFile.name,
            title: zipFile.name.replace(/\.zip$/i, ""),
            content: "",
            size: zipFile.size,
            selected: true,
            source: "siyuan-sy",
          }];
          setHasZip(true);
          setPerFileNotebook(false);
          setZipMetaHint(null);
          setNotesImportNotice({
            kind: "siyuan",
            messages: [
              t("dataManager.siyuanServerImportReady", { size: Math.round(zipFile.size / 1024 / 1024) }),
              t("dataManager.siyuanServerImportHint"),
            ],
          });
          setImportFiles(result);
          return;
        }
        let r: Awaited<ReturnType<typeof readMarkdownFromZipWithMeta>>;
        r = await readMarkdownFromZipWithMeta(zipFile);
        result = r.files;
        if (activeImportMethod === "siyuan") {
          // 思源 Markdown ZIP 的来源已经是 Markdown，默认原样保留。
          recommendSiyuanImportContentFormat("markdown");
        }
        setHasZip(true);
        // zip 由其内部目录/zip 文件名派生笔记本，关闭 per-file
        setPerFileNotebook(false);

        // P1-2：试图依据 meta.rootNotebookId 预选目标笔记本
        const scopeMatchesGlobal = effectiveWorkspaceId === getCurrentWorkspace();
        if (r.meta && r.meta.rootNotebookId && scopeMatchesGlobal) {
          const hit = state.notebooks.find((nb) => nb.id === r.meta!.rootNotebookId);
          if (hit) {
            setSelectedNotebookId(hit.id);
            setZipMetaHint({ kind: "matched", notebookName: hit.name });
          } else {
            setZipMetaHint({
              kind: "missing",
              rootNotebookName: r.meta.rootNotebookName,
            });
          }
        } else {
          setZipMetaHint(null);
        }
      } else {
        result = await readMarkdownFiles(files);
        if (activeImportMethod === "siyuan") {
          recommendSiyuanImportContentFormat("markdown");
        }
        setHasZip(false);
        setZipMetaHint(null);
        setNotesImportNotice(null);
        // 散文件默认开启 per-file：以文件名作为笔记本名，而非统一落到「导入的笔记」
        setPerFileNotebook(true);
      }
      if (result.length === 0) {
        throw new Error(
          activeImportMethod === "siyuan"
            ? t("dataManager.siyuanImportNoSupportedNotes")
            : t("dataManager.importNoSupportedNotes"),
        );
      }
    } catch (err: any) {
      // PDF 专用错误标志：超大 / 无文本层 / 其他解析失败
      const flag = err?.flag;
      const fileName: string = err?.fileName || "";
      if (flag === PDF_TOO_LARGE_FLAG) {
        setNotesImportError(
          t("dataManager.pdfTooLarge", {
            file: fileName,
            limit: Math.round(MAX_PDF_SIZE / 1024 / 1024),
          }),
        );
      } else if (flag === PDF_NO_TEXT_LAYER_FLAG) {
        setNotesImportError(
          t("dataManager.pdfNoTextLayer", { file: fileName }),
        );
      } else {
        setNotesImportError(
          t("dataManager.importReadFailed", {
            error: err?.message || String(err),
          }),
        );
      }
      setImportFiles([]);
      setNotesImportNotice(null);
      // 重置文件选择器，以便重选同名文件能触发 onChange
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setImportFiles(result);
  };
  const toggleFileSelection = (index: number) => {
    setImportFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, selected: !f.selected } : f))
    );
  };

  const toggleAll = () => {
    const allSelected = importFiles.every((f) => f.selected);
    setImportFiles((prev) => prev.map((f) => ({ ...f, selected: !allSelected })));
  };

  const handleImport = async () => {
    if (!effectiveWorkspaceId) return; // 工作区 scope 但未选中，按钮已禁用，这里再防御
    setIsImporting(true);
    setImportProgress(null);
    setLastImportTarget(null);
    // scope 匹配检查：state.notebooks 是侧边栏激活 ws 的，scope 不匹配时
    // 不允许把"侧边栏 ws 的笔记本 id"硬塞到目标 ws 的 import 里——只走自动创建。
    const scopeMatchesGlobal = effectiveWorkspaceId === getCurrentWorkspace();
    const safeNotebookId = scopeMatchesGlobal ? selectedNotebookId : "";
    // perFileNotebook 与 selectedNotebookId 互斥：只要选了具体笔记本，就不启用 per-file
    const usePerFile = !safeNotebookId && perFileNotebook;
    const selectedFiles = importFiles.filter((file) => file.selected);
    const genericMarkdownOnly =
      selectedFiles.length > 0 && selectedFiles.every((file) => isMarkdownImportSource(file.source));
    let result: { success: boolean; count: number };
    try {
      result = serverSiyuanFile
        ? await (async () => {
          setImportProgress({
            phase: "uploading",
            current: 0,
            total: 0,
            message: t("dataManager.uploadingProgress"),
          });
          const imported = await api.importSiyuanPackage(serverSiyuanFile, {
            targetNotebookId: safeNotebookId || undefined,
            workspaceId: effectiveWorkspaceId,
            contentFormat: siyuanImportContentFormat,
            onProgress: (job) => setImportProgress({
              phase: job.status === "completed"
                ? "done"
                : job.status === "failed"
                  ? "error"
                  : "uploading",
              current: job.progressCurrent ?? 0,
              total: job.progressTotal ?? 0,
              message: job.message,
            }),
          });
          const parsedNotes = imported.stats?.parsedNotes ?? imported.stats?.syFiles ?? 0;
          const createdNotes = imported.stats?.createdNotes ?? imported.count ?? 0;
          const createdFolders = imported.stats?.createdFolders ?? imported.createdFolderIds?.length ?? 0;
          const importedAssets = imported.stats?.createdAttachments ?? imported.stats?.importedAssets ?? 0;
          const failedNotes = imported.stats?.failedNotes ?? Math.max(0, parsedNotes - createdNotes);
          if (!imported.success || createdNotes <= 0 || createdNotes !== imported.count || failedNotes > 0) {
            throw new Error(
              `已成功解析 ${parsedNotes} 篇思源文档，但 ${createdNotes} 篇写入成功，${failedNotes} 篇失败`,
            );
          }
          setImportProgress({
            phase: "done",
            current: createdNotes,
            total: parsedNotes,
            message: t("dataManager.siyuanImportCompletedStats", {
              parsed: parsedNotes,
              created: createdNotes,
              folders: createdFolders,
              assets: importedAssets,
              failed: failedNotes,
            }),
          });
          const noticeMessages: string[] = [];
          if (imported.warnings?.length) {
            noticeMessages.push(...imported.warnings.slice(0, 6));
          }
          const unsupportedSummary = formatUnsupportedNodesSummary(imported.stats?.unsupportedNodes || {});
          if (unsupportedSummary) {
            noticeMessages.push(t("dataManager.siyuanUnsupportedNodesReport", { nodes: unsupportedSummary }));
            noticeMessages.push(t("dataManager.siyuanUnsupportedNodesHint"));
          }
          if (noticeMessages.length) {
            setNotesImportNotice({ kind: "siyuan", messages: noticeMessages });
          }
          return { success: imported.success, count: createdNotes };
        })()
        : await importNotes(
          importFiles,
          safeNotebookId || undefined,
          (p) => setImportProgress(p),
          {
            perFileNotebook: usePerFile,
            duplicateStrategy,
            workspaceId: effectiveWorkspaceId,
            targetContentFormat:
              activeImportMethod === "siyuan"
                ? siyuanImportContentFormat
                : activeImportMethod === "generic" && genericMarkdownOnly
                  ? genericImportContentFormat
                  : "tiptap-json",
          }
        );
    } catch (err: any) {
      result = { success: false, count: 0 };
      setImportProgress({
        phase: "error",
        current: 0,
        total: 1,
        message: t("dataManager.importFailed", { error: err?.message || String(err) }),
      });
    }
    setIsImporting(false);

    if (result.success) {
      // 记下"导入到了哪里"——用于成功横幅展示目标空间名及一键切换入口。
      // 用户最常踩的坑：从 A 工作区导出 → DataManager 选 B 导入 → 弹窗关闭后侧
      // 边栏还在 A，看不到笔记，误以为"显示成功但没导入"。
      const targetName =
        scope === "personal"
          ? t('dataManager.scope.personal')
          : (selectedWorkspaceName || t('dataManager.scope.workspace'));
      setLastImportTarget({
        workspaceId: effectiveWorkspaceId,
        workspaceName: targetName,
        count: result.count,
      });
      // 成功态对应的是目标空间中的真实持久化结果，因此完成后直接切到目标空间展示。
      if (!scopeMatchesGlobal) {
        setCurrentWorkspace(effectiveWorkspaceId);
        window.dispatchEvent(new CustomEvent("nowen:workspace-changed", {
          detail: { workspaceId: effectiveWorkspaceId },
        }));
      }
      api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      actions.refreshNotes();
      emitKnowledgeTreeRefresh("notes-imported-http");
      setTimeout(() => {
        setImportFiles([]);
        setImportProgress(null);
        setHasZip(false);
        setServerSiyuanFile(null);
        // 注意：lastImportTarget 不在这里清空——它要持续展示，直到用户主动
        // 关闭横幅或点击"切到该工作区查看"。
      }, 3000);
    }
  };

  /** 横幅"切到目标工作区查看"——切换全局 workspace，并关闭整个 SettingsModal 弹窗。 */
  const handleSwitchToImportTarget = () => {
    if (!lastImportTarget) return;
    setCurrentWorkspace(lastImportTarget.workspaceId);
    window.dispatchEvent(
      new CustomEvent("nowen:workspace-changed", {
        detail: { workspaceId: lastImportTarget.workspaceId },
      }),
    );
    setLastImportTarget(null);
    // 通过自定义事件请求关闭 SettingsModal（由父组件决定是否监听）。
    // 即便父组件未处理，工作区切换本身也会触发 App 顶层的"重置流程"。
    window.dispatchEvent(new CustomEvent("nowen:close-settings"));
  };

  const clearImportList = () => {
    setImportFiles([]);
    setImportProgress(null);
    setHasZip(false);
    setServerSiyuanFile(null);
    setNotesImportError("");
    setNotesImportNotice(null);
  };

  const handleImportMethodChange = (method: ImportMethod) => {
    if (method === activeImportMethod) return;
    if (shouldResetSharedFileImport(activeImportMethod, method)) clearImportList();
    setActiveImportMethod(method);
  };

  const selectedCount = importFiles.filter((f) => f.selected).length;
  const selectedFilesAreMarkdownOnly =
    selectedCount > 0 &&
    importFiles.filter((file) => file.selected).every((file) => isMarkdownImportSource(file.source));

  // Danger Zone state
  const [showResetModal, setShowResetModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const [shake, setShake] = useState(false);
  // H2: factory-reset 需要 sudo 二次验证，复用同一个弹窗让管理员输入当前密码
  const [sudoPwd, setSudoPwd] = useState("");

  const handleFactoryReset = async () => {
    if (confirmText !== "RESET") {
      setResetError(t('dataManager.incorrectVerification'));
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }
    if (!sudoPwd) {
      setResetError(t('dataManager.sudoPasswordRequired'));
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }

    setIsResetting(true);
    setResetError("");

    try {
      // 先用当前密码换 sudo token；失败会抛出（密码错 / 429）
      const out = await withSudo(
        (tk) => api.factoryReset(confirmText, tk),
        () => sudoPwd,
      );
      if (!out) {
        setIsResetting(false);
        return;
      }
      localStorage.clear();
      sessionStorage.clear();
      window.location.reload();
    } catch (err: any) {
      setResetError(err.message || t('dataManager.resetFailed'));
      setIsResetting(false);
    }
  };

  // 工作区 scope 但还没选中具体工作区时（如该用户没有任何协作工作区），
  // 导出/导入按钮应被禁用，避免发出 ?workspaceId= （后端会按个人空间错处理）
  const workspaceScopeNotReady = scope === "workspace" && !effectiveWorkspaceId;

  const importMethodConfigs: Record<ImportMethod, {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    desc: string;
    tag: string;
    iconClass: string;
  }> = {
    siyuan: {
      icon: BookOpen,
      label: t("dataManager.importMethodSiyuan"),
      desc: t("dataManager.importMethodSiyuanDesc"),
      tag: t("dataManager.importMethodSiyuanTag"),
      iconClass: "text-emerald-600 dark:text-emerald-400",
    },
    obsidian: {
      icon: FolderOpen,
      label: t("dataManager.importMethodObsidian"),
      desc: t("dataManager.importMethodObsidianDesc"),
      tag: t("dataManager.importMethodObsidianTag"),
      iconClass: "text-violet-600 dark:text-violet-400",
    },
    yuque: {
      icon: BookOpen,
      label: t("yuqueFileImport.source"),
      desc: t("yuqueFileImport.sourceDescription"),
      tag: t("yuqueFileImport.sourceTag"),
      iconClass: "text-emerald-600 dark:text-emerald-400",
    },
    "wechat-favorites": {
      icon: Heart,
      label: t("dataManager.importMethodWechatFavorites"),
      desc: t("dataManager.importMethodWechatFavoritesDesc"),
      tag: t("dataManager.importMethodWechatFavoritesTag"),
      iconClass: "text-emerald-600 dark:text-emerald-400",
    },
    youdao: {
      icon: BookOpen,
      label: t("dataManager.importMethodYoudao"),
      desc: t("dataManager.importMethodYoudaoDesc"),
      tag: t("dataManager.importMethodYoudaoTag"),
      iconClass: "text-rose-600 dark:text-rose-400",
    },
    "mobile-memo": {
      icon: Smartphone,
      label: t("dataManager.importMethodMobileMemo"),
      desc: t("dataManager.importMethodMobileMemoDesc"),
      tag: t("dataManager.importMethodMobileMemoTag"),
      iconClass: "text-orange-600 dark:text-orange-400",
    },
    generic: {
      icon: FileUp,
      label: t("dataManager.importMethodGeneric"),
      desc: t("dataManager.importMethodGenericDesc"),
      tag: t("dataManager.importMethodGenericTag"),
      iconClass: "text-indigo-600 dark:text-indigo-400",
    },
    url: {
      icon: ExternalLink,
      label: t("dataManager.importMethodUrl"),
      desc: t("dataManager.importMethodUrlDesc"),
      tag: t("dataManager.importMethodUrlTag"),
      iconClass: "text-blue-600 dark:text-blue-400",
    },
    nowen: {
      icon: Package,
      label: t("dataManager.importMethodNowen"),
      desc: t("dataManager.importMethodNowenDesc"),
      tag: t("dataManager.importMethodNowenTag"),
      iconClass: "text-violet-600 dark:text-violet-400",
    },
  };

  const importGroupCopy = {
    migration: {
      title: t("dataManager.importGroupMigration"),
      description: t("dataManager.importGroupMigrationDesc"),
    },
    general: {
      title: t("dataManager.importGroupGeneral"),
      description: t("dataManager.importGroupGeneralDesc"),
    },
    restore: {
      title: t("dataManager.importGroupRestore"),
      description: t("dataManager.importGroupRestoreDesc"),
    },
  } as const;

  const importMethodGroups = IMPORT_METHOD_GROUPS.map((group) => ({
    ...group,
    ...importGroupCopy[group.id],
    methods: group.methods.map((id) => ({ id, ...importMethodConfigs[id] })),
  }));

  const getImportMethodClass = (active: boolean): string =>
    active
      ? "border-indigo-400 bg-indigo-50/80 text-zinc-900 ring-2 ring-indigo-500/15 dark:border-indigo-600 dark:bg-indigo-500/10 dark:text-zinc-100"
      : "border-zinc-200 bg-white text-zinc-700 hover:border-indigo-200 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/60";

  // -----------------------------------------------------------------
  // 入口闸门
  //   - isAdmin === null：身份未拉到，渲染骨架占位（避免闪现拒绝页又秒变正常）
  //   - 管理员可维护整个实例，普通用户仅能迁移个人数据。
  //   - Android 独立本机空间不访问服务器的备份接口。
  // -----------------------------------------------------------------
  if (isAdmin === null) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-400 dark:text-zinc-600">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t('dataManager.title')}</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          {t('dataManager.description')}
        </p>

      </div>
      {activeSubTab === null ? (isAdmin && !isMobileLocalMode() ? (
        <BackupCenter
          migration={<DataTransferCenter onImport={() => setActiveSubTab("import")} onExport={() => setActiveSubTab("export")} />}
          advanced={<><DesktopDataSafetyCard currentUser={currentUser} /><RemoteImageLocalizationPanel /><DataFileSection />        <section className="mt-8 pt-6 border-t-2 border-dashed border-red-300/50 dark:border-red-900/40">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={18} className="text-red-500" />
            <h4 className="text-base font-bold text-red-600 dark:text-red-500">{t('dataManager.dangerZone')}</h4>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            {t('dataManager.dangerDescription')}
          </p>

          <button
            onClick={() => { setShowResetModal(true); setConfirmText(""); setResetError(""); setSudoPwd(""); }}
            className="px-4 py-2 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 font-medium rounded-lg transition-colors text-sm"
          >
            {t('dataManager.factoryReset')}
          </button>

          {/* 二次确认模态框 */}
          <AnimatePresence>
            {showResetModal && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm"
                  onClick={() => !isResetting && setShowResetModal(false)}
                />

                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ type: "spring", duration: 0.4, bounce: 0 }}
                  className="relative bg-white dark:bg-zinc-900 w-full max-w-md p-6 rounded-xl shadow-2xl border border-red-200 dark:border-red-900/50"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                      <AlertTriangle size={20} className="text-red-600 dark:text-red-500" />
                    </div>
                    <h4 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                      {t('dataManager.resetConfirmTitle')}
                    </h4>
                  </div>

                  <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-1">
                    {t('dataManager.resetConfirmDesc')}
                  </p>
                  <ul className="text-sm text-zinc-500 dark:text-zinc-400 mb-4 list-disc list-inside space-y-0.5">
                    <li>{t('dataManager.resetItem1')}</li>
                    <li>{t('dataManager.resetItem2')}</li>
                    <li>{t('dataManager.resetItem3')}</li>
                  </ul>

                  <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
                    {t('dataManager.resetInputHint')}
                  </p>

                  <motion.div
                    animate={shake ? { x: [-10, 10, -10, 10, 0] } : {}}
                    transition={{ duration: 0.4 }}
                  >
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => {
                        setConfirmText(e.target.value);
                        setResetError("");
                      }}
                      placeholder={t('dataManager.resetInputPlaceholder')}
                      className={`w-full px-3 py-2 border rounded-lg bg-transparent text-zinc-900 dark:text-zinc-100 outline-none font-mono text-sm transition-colors ${resetError
                        ? "border-red-500/50 focus:ring-2 focus:ring-red-500/30"
                        : "border-zinc-300 dark:border-zinc-700 focus:ring-2 focus:ring-red-500/30 focus:border-red-500"
                        }`}
                      autoFocus
                    />
                  </motion.div>

                  {resetError && (
                    <p className="text-sm text-red-500 mt-2">{resetError}</p>
                  )}

                  {/* H2: 二次密码验证（sudo） */}
                  <div className="mt-4">
                    <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
                      {t('dataManager.sudoPasswordLabel')}
                    </label>
                    <input
                      type="password"
                      value={sudoPwd}
                      onChange={(e) => {
                        setSudoPwd(e.target.value);
                        setResetError("");
                      }}
                      placeholder={t('dataManager.sudoPasswordPlaceholder')}
                      autoComplete="current-password"
                      className="w-full px-3 py-2 border rounded-lg bg-transparent text-zinc-900 dark:text-zinc-100 outline-none text-sm transition-colors border-zinc-300 dark:border-zinc-700 focus:ring-2 focus:ring-red-500/30 focus:border-red-500"
                    />
                    <p className="text-[11px] text-zinc-400 mt-1">
                      {t('dataManager.sudoPasswordHint')}
                    </p>
                  </div>

                  <div className="flex justify-end gap-3 mt-5">
                    <button
                      onClick={() => { setShowResetModal(false); setSudoPwd(""); }}
                      disabled={isResetting}
                      className="px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={handleFactoryReset}
                      disabled={isResetting || confirmText !== "RESET" || !sudoPwd}
                      className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg flex items-center transition-colors"
                    >
                      {isResetting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      {t('dataManager.confirmDestroy')}
                    </button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>
        </section></>}
        />
      ) : <DataTransferCenter onImport={() => setActiveSubTab("import")} onExport={() => setActiveSubTab("export")} />) : (
        <div className="space-y-3">
          <button type="button" onClick={() => setActiveSubTab(null)} disabled={isExporting || isExportingNowen || isImporting} className="text-xs text-indigo-600 dark:text-indigo-400">{t("dataManager.overview.back")}</button>
          {(activeSubTab === "export" || ["siyuan", "generic", "nowen", "yuque"].includes(activeImportMethod)) && <label className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            {t("dataManager.overview.scope")}
            <select aria-label={t("dataManager.overview.scope")} value={scope} onChange={(e) => setScope(e.target.value as Scope)} disabled={isExporting || isExportingNowen || isImporting} className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900">
              <option value="personal">{t("dataManager.scope.personal")}</option>
              {isAdmin && <option value="workspace">{t("dataManager.scope.workspace")}</option>}
            </select>
            {scope === "workspace" && <select aria-label={t("dataManager.scope.currentWorkspaceLabel")} value={selectedWorkspaceId} onChange={(e) => setSelectedWorkspaceId(e.target.value)} disabled={isExporting || isExportingNowen || isImporting} className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900">
              <option value="">{t("dataManager.scope.workspaceNeedSwitch")}</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>}
          </label>}
                  <section className="mb-4 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-800/30 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <ListTodo size={19} />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("dataManager.overview.tasks")}</h4>
              <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {t("dataManager.overview.taskHint")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={openTaskDataTransfer}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 shadow-sm transition-colors hover:border-indigo-300 hover:text-indigo-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-700 dark:hover:text-indigo-400"
          >
            {t("dataManager.overview.taskAction")}
            <ChevronRight size={14} />
          </button>
        </section>

        </div>
      )}

      {/* ===== 导出区域 ===== */}
      {activeSubTab === "export" && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <FolderDown size={18} className="text-indigo-500" />
            <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t("dataManager.overview.export")}</h4>
          </div>

          {/* 普通用户且管理员已关闭"个人空间导出"开关时：展示 lock 横幅并禁用下方按钮。
            不直接隐藏整个 section —— 让用户能看见"这里本来有导出，但被管理员关闭了"，
            比悄悄消失更透明、减少"我的设置是不是 bug"类困惑。 */}
          {personalExportLocked && (
            <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-500/5 text-xs text-amber-700 dark:text-amber-300">
              <ShieldAlert size={14} className="flex-shrink-0 mt-0.5" />
              <span>{t('dataManager.scope.personalExportDisabled')}</span>
            </div>
          )}

          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
              {t(exportFormat === "markdown" ? "dataManager.exportDescription" : "dataManager.overview.nowenHint")}
            </p>

            {exportProgress && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  {exportProgress.phase === "error" ? (
                    <AlertCircle size={16} className="text-red-500" />
                  ) : exportProgress.phase === "done" ? (
                    <CheckCircle size={16} className="text-green-500" />
                  ) : (
                    <Loader2 size={16} className="text-indigo-500 animate-spin" />
                  )}
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    {exportProgress.message}
                  </span>
                </div>
                {exportProgress.phase === "packing" && (
                  <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-1.5">
                    <motion.div
                      className="bg-indigo-500 h-1.5 rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${exportProgress.current}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                )}
              </div>
            )}

            <fieldset className="mb-4 space-y-2">
              <legend className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">{t("dataManager.overview.exportFormat")}</legend>
              {(["markdown", "nowen"] as const).map((format) => <label key={format} className="flex items-start gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                <input type="radio" name="data-export-format" value={format} checked={exportFormat === format} onChange={() => setExportFormat(format)} disabled={isExporting || isExportingNowen} className="mt-0.5 accent-indigo-600" />
                <span className="text-sm text-zinc-700 dark:text-zinc-300">{t(`dataManager.overview.${format}`)}<span className="mt-1 block text-xs text-zinc-500">{t(`dataManager.overview.${format}Hint`)}</span></span>
              </label>)}
            </fieldset>
            {exportFormat === "markdown" && <>
            {/* 导出选项：图片处理策略 */}
            <label className="flex items-start gap-2 mb-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={exportInlineImages}
                onChange={(e) => setExportInlineImages(e.target.checked)}
                disabled={isExporting}
                className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer"
              />
              <span className="text-sm">
                <span className="text-zinc-700 dark:text-zinc-300">
                  {t('dataManager.exportInlineImages')}
                </span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {t('dataManager.exportInlineImagesHint')}
                </span>
              </span>
            </label>

            <button
              onClick={handleExportAll}
              disabled={isExporting || workspaceScopeNotReady || personalExportLocked}
              className={`flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${isExporting || workspaceScopeNotReady || personalExportLocked
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                : exportProgress?.phase === "done"
                  ? "bg-green-500 hover:bg-green-600 text-white shadow-md"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg"
                }`}
            >
              {isExporting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('dataManager.exporting')}
                </>
              ) : exportProgress?.phase === "done" ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  {t('dataManager.exportSuccess')}
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  {t('dataManager.exportAsZip')}
                </>
              )}
            </button>

            </>}
            {exportFormat === "nowen" && <>
            {/* Nowen 数据包导出 */}
            <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-700">
              <div className="flex items-center gap-2 mb-2">
                <Package size={16} className="text-violet-500" />
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {t('note.nowenPackage')}
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
                {t('note.nowenPackageDesc')}
              </p>
              <button
                onClick={handleExportNowenPackage}
                disabled={isExportingNowen || workspaceScopeNotReady || personalExportLocked}
                className={`flex items-center justify-center w-full py-2 px-4 rounded-lg font-medium text-sm transition-all ${isExportingNowen || workspaceScopeNotReady || personalExportLocked
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                  : "bg-violet-600 hover:bg-violet-700 text-white shadow-md hover:shadow-lg"
                  }`}
              >
                {isExportingNowen ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t('note.nowenPackageExporting')}
                  </>
                ) : (
                  <>
                    <Package className="w-4 h-4 mr-2" />
                    {t('note.nowenPackage')}
                  </>
                )}
              </button>
            </div>
            </>}
          </div>
        </section>
      )}

      {/* ===== 导入区域：Import Hub ===== */}
      {activeSubTab === "import" && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <FileUp size={18} className="text-emerald-500" />
            <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('dataManager.importNotes')}</h4>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
            {t('dataManager.importDescription')}
          </p>

          {personalImportLocked && (
            <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-500/5 text-xs text-amber-700 dark:text-amber-300">
              <ShieldAlert size={14} className="flex-shrink-0 mt-0.5" />
              <span>{t('dataManager.scope.personalImportDisabled')}</span>
            </div>
          )}

          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-3 sm:p-4">
            <div className="mb-4">
              <h5 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                {t("dataManager.importHubTitle")}
              </h5>
              <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {t("dataManager.importHubDescription")}
              </p>
            </div>

            <div className="space-y-5">
              {importMethodGroups.map((group) => (
                <section key={group.id} aria-labelledby={`import-group-${group.id}`}>
                  <div className="mb-2">
                    <h6
                      id={`import-group-${group.id}`}
                      className="text-xs font-semibold text-zinc-700 dark:text-zinc-200"
                    >
                      {group.title}
                    </h6>
                    <p className="mt-0.5 text-[11px] leading-5 text-zinc-400 dark:text-zinc-500">
                      {group.description}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {group.methods.map((method) => {
                      const Icon = method.icon;
                      const active = activeImportMethod === method.id;
                      return (
                        <button
                          key={method.id}
                          type="button"
                          onClick={() => handleImportMethodChange(method.id)}
                          disabled={personalImportLocked || isImporting}
                          aria-pressed={active}
                          className={`min-h-[112px] rounded-xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${getImportMethodClass(active)}`}
                        >
                          <span className="flex items-start gap-2.5">
                            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100/80 dark:bg-zinc-950/40 ${method.iconClass}`}>
                              <Icon className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold">{method.label}</span>
                              <span className="mt-1 block text-xs leading-5 opacity-75">{method.desc}</span>
                              <span className="mt-2 inline-flex max-w-full rounded-md bg-zinc-100/80 px-1.5 py-0.5 text-[11px] font-medium dark:bg-zinc-950/40">
                                {method.tag}
                              </span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            <div key={activeImportMethod} className="mt-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-3 sm:p-4">
              {activeImportMethod === "yuque" && <YuqueFileImport
                key={`yuque-${effectiveWorkspaceId}`}
                workspaceId={effectiveWorkspaceId}
                workspaceName={scope === "personal" ? t("dataManager.scope.personal") : selectedWorkspaceName}
                userId={currentUser?.id || ""}
                disabled={personalImportLocked || workspaceScopeNotReady}
                onBusyChange={setIsImporting}
                onImported={() => {
                  if (effectiveWorkspaceId === (getCurrentWorkspace() || "personal")) {
                    void api.getNotebooks().then(actions.setNotebooks).catch(console.error);
                    actions.refreshNotes();
                    emitKnowledgeTreeRefresh("notes-imported-http");
                  }
                }}
                onView={async (result) => {
                  if (!result.firstNoteId) return;
                  if (effectiveWorkspaceId !== (getCurrentWorkspace() || "personal")) {
                    setCurrentWorkspace(effectiveWorkspaceId);
                    window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId: effectiveWorkspaceId } }));
                  }
                  const [notebooks, note] = await Promise.all([api.getNotebooks(effectiveWorkspaceId), api.getNote(result.firstNoteId)]);
                  actions.setNotebooks(notebooks);
                  actions.setSelectedNotebook(note.notebookId);
                  actions.setActiveNote(note);
                  actions.setViewMode("notebook");
                  actions.setMobileView("editor");
                  actions.refreshNotes();
                  emitKnowledgeTreeRefresh("notes-imported-http");
                  window.dispatchEvent(new CustomEvent("nowen:close-settings"));
                }}
              />}
              {(activeImportMethod === "siyuan" || activeImportMethod === "generic") && (
                <>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0">
                      <h5 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {activeImportMethod === "siyuan"
                          ? t('dataManager.siyuanImportPanelTitle')
                          : t('dataManager.genericImportPanelTitle')}
                      </h5>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                        {activeImportMethod === "siyuan"
                          ? t('dataManager.siyuanImportPanelDesc')
                          : t('dataManager.genericImportPanelDesc')}
                      </p>
                      {activeImportMethod === "siyuan" && (
                        <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">
                          {t('dataManager.siyuanImportPanelHint')}
                        </p>
                      )}
                      {activeImportMethod === "siyuan" && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                          {t('dataManager.siyuanImportPanelDowngradeHint')}
                        </p>
                      )}
                      {activeImportMethod === "siyuan" && (
                        <div className="mt-3">
                          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1.5">
                            {t('dataManager.siyuanImportFormatLabel')}
                          </p>
                          <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                            <button
                              type="button"
                              onClick={() => selectSiyuanImportContentFormat("tiptap-json")}
                              className={`px-3 py-1.5 text-xs font-medium transition-colors ${siyuanImportContentFormat === "tiptap-json"
                                ? "bg-emerald-600 text-white"
                                : "bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                }`}
                            >
                              {t('dataManager.siyuanImportFormatRichText')}
                            </button>
                            <button
                              type="button"
                              onClick={() => selectSiyuanImportContentFormat("markdown")}
                              className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-zinc-200 dark:border-zinc-700 ${siyuanImportContentFormat === "markdown"
                                ? "bg-emerald-600 text-white"
                                : "bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                }`}
                            >
                              {t('dataManager.siyuanImportFormatMarkdown')}
                            </button>
                          </div>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1.5">
                            {siyuanImportContentFormat === "tiptap-json"
                              ? t('dataManager.siyuanImportFormatRichTextHint')
                              : t('dataManager.siyuanImportFormatMarkdownHint')}
                          </p>
                        </div>
                      )}
                      {activeImportMethod === "generic" && selectedFilesAreMarkdownOnly && (
                        <div className="mt-3">
                          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1.5">
                            {t('dataManager.siyuanImportFormatLabel')}
                          </p>
                          <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                            <button
                              type="button"
                              onClick={() => setGenericImportContentFormat("markdown")}
                              className={`px-3 py-1.5 text-xs font-medium transition-colors ${genericImportContentFormat === "markdown"
                                ? "bg-indigo-600 text-white"
                                : "bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                }`}
                            >
                              {t('dataManager.siyuanImportFormatMarkdown')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setGenericImportContentFormat("tiptap-json")}
                              className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-zinc-200 dark:border-zinc-700 ${genericImportContentFormat === "tiptap-json"
                                ? "bg-indigo-600 text-white"
                                : "bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                                }`}
                            >
                              {t('dataManager.siyuanImportFormatRichText')}
                            </button>
                          </div>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1.5">
                            {genericImportContentFormat === "markdown"
                              ? t('dataManager.siyuanImportFormatMarkdownHint')
                              : t('dataManager.siyuanImportFormatRichTextHint')}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {importFiles.length === 0 && (
                    <div
                      onDragOver={personalImportLocked ? undefined : handleDragOver}
                      onDragLeave={personalImportLocked ? undefined : handleDragLeave}
                      onDrop={personalImportLocked ? undefined : handleDrop}
                      onClick={() => { if (!personalImportLocked) fileInputRef.current?.click(); }}
                      aria-disabled={personalImportLocked}
                      className={`relative border-2 border-dashed rounded-xl p-5 sm:p-6 text-center transition-all ${personalImportLocked
                        ? "border-zinc-200 dark:border-zinc-800 bg-zinc-50/30 dark:bg-zinc-800/20 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                        : isDragOver
                          ? "border-indigo-400 bg-indigo-50/50 dark:bg-indigo-500/5 dark:border-indigo-500 cursor-pointer"
                          : "border-zinc-300 dark:border-zinc-700 hover:border-indigo-300 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
                        }`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".md,.txt,.markdown,.html,.htm,.pdf,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp"
                        onChange={handleFileSelect}
                        disabled={personalImportLocked}
                        className="hidden"
                      />
                      <Upload
                        size={28}
                        className={`mx-auto mb-2.5 ${isDragOver ? "text-indigo-500" : "text-zinc-400 dark:text-zinc-500"
                          }`}
                      />
                      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                        {activeImportMethod === "siyuan"
                          ? t('dataManager.chooseSiyuanExport')
                          : t('dataManager.dropFilesHere')}
                      </p>
                      <p className="text-xs text-zinc-400 dark:text-zinc-600 mt-1">
                        {activeImportMethod === "siyuan"
                          ? t('dataManager.siyuanImportSupportedHint')
                          : t('dataManager.supportedFiles')}
                      </p>
                      {activeImportMethod === "generic" && (
                        <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">
                          {t('dataManager.siyuanImportSupportedHint')}
                        </p>
                      )}
                    </div>
                  )}

                  {notesImportError && importFiles.length === 0 && (
                    <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg border border-red-200/60 dark:border-red-900/40 bg-red-50/40 dark:bg-red-500/5 text-xs text-red-600 dark:text-red-400">
                      <span className="flex-shrink-0 mt-0.5">⚠</span>
                      <span className="flex-1 break-all">{notesImportError}</span>
                      <button
                        type="button"
                        onClick={() => setNotesImportError("")}
                        className="text-red-500/80 hover:text-red-600 dark:hover:text-red-300 ml-2 flex-shrink-0"
                        aria-label="close"
                      >
                        ×
                      </button>
                    </div>
                  )}

                  {notesImportNotice && (
                    <div
                      className={`mt-3 flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${notesImportNotice.kind === "siyuan"
                        ? "border-emerald-200/70 bg-emerald-50/50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-500/5 dark:text-emerald-300"
                        : "border-amber-200/70 bg-amber-50/50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-500/5 dark:text-amber-300"
                        }`}
                    >
                      {notesImportNotice.kind === "siyuan" ? (
                        <CheckCircle size={14} className="mt-0.5 flex-shrink-0" />
                      ) : (
                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold mb-1">
                          {notesImportNotice.kind === "siyuan"
                            ? t('dataManager.siyuanImportReportTitle')
                            : t('dataManager.importNoticeTitle')}
                        </div>
                        <div className="space-y-1">
                          {notesImportNotice.messages.map((message, index) => (
                            <p key={`${message}-${index}`} className="leading-relaxed">
                              {message}
                            </p>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {importFiles.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={toggleAll}
                            className="text-xs text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium"
                          >
                            {importFiles.every((f) => f.selected) ? t('dataManager.deselectAll') : t('dataManager.selectAll')}
                          </button>
                          <span className="text-xs text-zinc-400 dark:text-zinc-600">
                            {t('dataManager.selectedCount', { selected: selectedCount, total: importFiles.length })}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={clearImportList}
                          className="p-1 rounded text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      {(() => {
                        const currentGlobalWs = getCurrentWorkspace();
                        const scopeMatchesGlobal = effectiveWorkspaceId === currentGlobalWs;
                        return (
                          <div className="mb-3">
                            <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">{t('dataManager.importToNotebook')}</label>
                            <select
                              value={scopeMatchesGlobal ? selectedNotebookId : ""}
                              onChange={(e) => setSelectedNotebookId(e.target.value)}
                              disabled={!scopeMatchesGlobal}
                              className="w-full text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              <option value="">
                                {serverSiyuanFile
                                  ? t('dataManager.siyuanAutoRestoreStructure')
                                  : t('dataManager.autoCreateNotebook')}
                              </option>
                              {scopeMatchesGlobal && state.notebooks.map((nb) => (
                                <option key={nb.id} value={nb.id}>
                                  {nb.icon} {nb.name}
                                </option>
                              ))}
                            </select>
                            {serverSiyuanFile && (!scopeMatchesGlobal || !selectedNotebookId) && (
                              <p className="text-[11px] mt-1.5 leading-relaxed text-zinc-400 dark:text-zinc-500">
                                {t('dataManager.siyuanAutoRestoreStructureHint')}
                              </p>
                            )}
                            {hasZip && zipMetaHint && (
                              <p className="text-[11px] mt-1.5 leading-relaxed">
                                {zipMetaHint.kind === "matched" ? (
                                  <span className="text-emerald-600 dark:text-emerald-400">
                                    ✓ 已根据备份元数据自动选中原笔记本：
                                    <span className="font-semibold">{zipMetaHint.notebookName}</span>
                                  </span>
                                ) : (
                                  <span className="text-amber-600 dark:text-amber-400">
                                    ⓘ 备份来自其他实例或工作区
                                    {zipMetaHint.rootNotebookName ? (
                                      <>（原笔记本：<span className="font-semibold">{zipMetaHint.rootNotebookName}</span>）</>
                                    ) : null}
                                    ；当前空间未找到同 id 的笔记本，可手动选择目标或保持「自动创建」。
                                  </span>
                                )}
                              </p>
                            )}
                          </div>
                        );
                      })()}

                      {!hasZip && (
                        <div className="mb-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/40 p-3">
                          <label
                            className={`flex items-start gap-2.5 cursor-pointer ${selectedNotebookId ? "opacity-50 cursor-not-allowed" : ""
                              }`}
                          >
                            <input
                              type="checkbox"
                              checked={perFileNotebook && !selectedNotebookId}
                              disabled={!!selectedNotebookId}
                              onChange={(e) => setPerFileNotebook(e.target.checked)}
                              className="mt-0.5 w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-indigo-500 focus:ring-indigo-500/30"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-zinc-700 dark:text-zinc-300 font-medium">
                                {t('dataManager.perFileNotebook')}
                              </div>
                              <div className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                                {t('dataManager.perFileNotebookHint')}
                              </div>
                            </div>
                          </label>

                          {perFileNotebook && !selectedNotebookId && (
                            <div className="mt-2.5 pl-6 flex flex-col gap-1.5">
                              <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
                                <input
                                  type="radio"
                                  name="dup-strategy"
                                  value="merge"
                                  checked={duplicateStrategy === "merge"}
                                  onChange={() => setDuplicateStrategy("merge")}
                                  className="w-3.5 h-3.5 text-indigo-500 focus:ring-indigo-500/30"
                                />
                                {t('dataManager.duplicateMerge')}
                              </label>
                              <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
                                <input
                                  type="radio"
                                  name="dup-strategy"
                                  value="unique"
                                  checked={duplicateStrategy === "unique"}
                                  onChange={() => setDuplicateStrategy("unique")}
                                  className="w-3.5 h-3.5 text-indigo-500 focus:ring-indigo-500/30"
                                />
                                {t('dataManager.duplicateUnique')}
                              </label>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
                        {importFiles.map((file, idx) => {
                          const notebookPathText = getNotebookPathText(file);
                          return (
                            <label
                              key={idx}
                              className={`flex items-start gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${file.selected
                                ? "bg-indigo-50/50 dark:bg-indigo-500/5"
                                : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                                }`}
                            >
                              <input
                                type="checkbox"
                                checked={file.selected}
                                onChange={() => toggleFileSelection(idx)}
                                className="mt-0.5 w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-indigo-500 focus:ring-indigo-500/30 flex-shrink-0"
                              />
                              <FileText size={14} className="mt-0.5 text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2 min-w-0">
                                  <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate flex-1">
                                    {file.title}
                                  </span>
                                  <span className="text-xs text-zinc-400 dark:text-zinc-600 flex-shrink-0">
                                    {(file.size / 1024).toFixed(1)} KB
                                  </span>
                                </span>
                                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-5">
                                  <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium ${getImportSourceTone(file.source)}`}>
                                    {getImportSourceLabel(file.source)}
                                  </span>
                                  {notebookPathText && (
                                    <span
                                      title={notebookPathText}
                                      className="min-w-0 max-w-full break-all text-zinc-400 dark:text-zinc-500 sm:truncate sm:break-normal"
                                    >
                                      {notebookPathText}
                                    </span>
                                  )}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>

                      {importProgress && (
                        serverSiyuanFile ? (
                          <div
                            className={`mt-3 rounded-xl border p-3 ${importProgress.phase === "error"
                              ? "border-red-200/70 bg-red-50/50 dark:border-red-900/50 dark:bg-red-500/5"
                              : "border-emerald-200/70 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-500/5"
                              }`}
                            role="status"
                            aria-live="polite"
                          >
                            <div className="flex items-start gap-3">
                              {importProgress.phase === "error" ? (
                                <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-500" />
                              ) : importProgress.phase === "done" ? (
                                <CheckCircle size={18} className="mt-0.5 shrink-0 text-emerald-500" />
                              ) : (
                                <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-emerald-500" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                    {importProgress.message}
                                  </span>
                                  {importProgress.total > 0 && (
                                    <span className="shrink-0 text-xs font-medium tabular-nums text-zinc-500 dark:text-zinc-400">
                                      {importProgress.current} / {importProgress.total}
                                    </span>
                                  )}
                                </div>
                                <div
                                  className="mt-3 h-2 overflow-hidden rounded-full bg-white/80 dark:bg-zinc-800"
                                  role="progressbar"
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-valuenow={importProgress.total > 0
                                    ? Math.min(100, Math.round((importProgress.current / importProgress.total) * 100))
                                    : undefined}
                                >
                                  {importProgress.total > 0 ? (
                                    <div
                                      className={`h-full rounded-full transition-[width] duration-300 ${importProgress.phase === "error" ? "bg-red-500" : "bg-emerald-500"
                                        }`}
                                      style={{
                                        width: `${Math.min(100, Math.round((importProgress.current / importProgress.total) * 100))}%`,
                                      }}
                                    />
                                  ) : (
                                    <motion.div
                                      className="h-full w-2/5 rounded-full bg-emerald-500"
                                      initial={{ x: "-120%" }}
                                      animate={{ x: "300%" }}
                                      transition={{ duration: 1.25, ease: "easeInOut", repeat: Infinity }}
                                    />
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-3 flex items-center gap-2">
                            {importProgress.phase === "error" ? (
                              <AlertCircle size={14} className="text-red-500" />
                            ) : importProgress.phase === "done" ? (
                              <CheckCircle size={14} className="text-green-500" />
                            ) : (
                              <Loader2 size={14} className="animate-spin text-indigo-500" />
                            )}
                            <span className="text-sm text-zinc-600 dark:text-zinc-400">
                              {importProgress.message}
                            </span>
                          </div>
                        )
                      )}

                      {lastImportTarget && (
                        <div className="mt-3 p-3 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/70 dark:bg-emerald-500/10">
                          <div className="flex items-start gap-2">
                            <CheckCircle size={16} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                                {t('dataManager.importDoneTitle', { count: lastImportTarget.count })}
                              </div>
                              <div className="text-xs text-emerald-700/80 dark:text-emerald-300/80 mt-0.5 break-all">
                                {t('dataManager.importDoneTargetLabel')}
                                <span className="font-semibold">{lastImportTarget.workspaceName}</span>
                              </div>
                              {lastImportTarget.workspaceId !== getCurrentWorkspace() && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={handleSwitchToImportTarget}
                                    className="text-xs px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-colors"
                                  >
                                    {t('dataManager.importDoneSwitch')}
                                  </button>
                                  <div className="text-xs text-emerald-700/80 dark:text-emerald-300/80 self-center">
                                    {t('dataManager.importDoneSwitchHint')}
                                  </div>
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => setLastImportTarget(null)}
                              className="text-emerald-700/60 dark:text-emerald-300/60 hover:text-emerald-700 dark:hover:text-emerald-300 flex-shrink-0"
                              aria-label="dismiss"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={handleImport}
                        disabled={isImporting || selectedCount === 0 || workspaceScopeNotReady || personalImportLocked}
                        className={`mt-3 flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${isImporting || selectedCount === 0 || workspaceScopeNotReady || personalImportLocked
                          ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                          : importProgress?.phase === "done"
                            ? "bg-green-500 hover:bg-green-600 text-white shadow-md"
                            : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-md hover:shadow-lg"
                          }`}
                      >
                        {isImporting ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            {t('dataManager.importing')}
                          </>
                        ) : importProgress?.phase === "done" ? (
                          <>
                            <CheckCircle className="w-4 h-4 mr-2" />
                            {t('dataManager.importSuccess')}
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4 mr-2" />
                            {t('dataManager.importButton', { count: selectedCount })}
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </>
              )}

              {!personalImportLocked && activeImportMethod === "nowen" && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Package size={16} className="text-violet-500" />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {t('note.nowenPackageImport')}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
                    {t('note.nowenPackageImportDesc')}
                  </p>
                  <input
                    type="file"
                    accept=".nowen.zip,.zip"
                    className="hidden"
                    id="nowen-package-import-input"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file || workspaceScopeNotReady || personalImportLocked) return;
                      e.target.value = "";
                      setIsImporting(true);
                      try {
                        toast.info(t('note.nowenPackageImportDryRun'));
                        const dryResult = await api.dryRunNowenPackage(file, { workspaceId: effectiveWorkspaceId });

                        if (!dryResult.success) {
                          toast.error(dryResult.errors?.[0] || t('note.nowenPackageImportFailed'));
                          return;
                        }

                        const pkg = dryResult.package;
                        const confirmed = window.confirm(
                          t('note.nowenPackageImportConfirmTitle') + "\n\n" +
                          t('note.nowenPackageImportConfirmDesc', {
                            notes: pkg?.counts?.notes || 0,
                            attachments: pkg?.counts?.attachments || 0,
                          })
                        );

                        if (!confirmed) return;

                        toast.info(t('note.nowenPackageImportDryRun'));
                        const result = await api.importNowenPackage(file, { workspaceId: effectiveWorkspaceId });

                        if (result.success) {
                          const counts = result.counts;
                          toast.success(
                            t('note.nowenPackageImportSuccess') +
                            (counts ? ` (${counts.notes} notes, ${counts.attachments} attachments)` : "")
                          );
                          actions.refreshNotebooks();
                          actions.refreshNotes();
                        } else {
                          toast.error(result.errors?.[0] || t('note.nowenPackageImportFailed'));
                        }
                      } catch (err: any) {
                        console.error("[NowenPackageImport] Failed:", err);
                        toast.error(err.message || t('note.nowenPackageImportFailed'));
                      } finally {
                        setIsImporting(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => document.getElementById('nowen-package-import-input')?.click()}
                    disabled={isImporting || workspaceScopeNotReady || personalImportLocked}
                    className="flex items-center justify-center w-full py-2 px-4 rounded-lg font-medium text-sm bg-violet-600 hover:bg-violet-700 text-white shadow-md hover:shadow-lg disabled:opacity-50 transition-all"
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    {t('note.nowenPackageImport')}
                  </button>
                </div>
              )}

              {!personalImportLocked && activeImportMethod === "url" && <UrlImport />}

              {!personalImportLocked && activeImportMethod === "mobile-memo" && (
                <div>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {([
                      { id: "xiaomi", label: t('dataManager.mobileMemoXiaomi') },
                      { id: "oppo", label: t('dataManager.mobileMemoOppo') },
                      { id: "iphone", label: t('dataManager.mobileMemoIphone') },
                    ] as const).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setActiveMobileMemoMethod(item.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${activeMobileMemoMethod === item.id
                          ? "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-800/70 dark:bg-orange-500/10 dark:text-orange-300"
                          : "border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                          }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  {activeMobileMemoMethod === "xiaomi" && <MiCloudImport />}
                  {activeMobileMemoMethod === "oppo" && <OppoCloudImport />}
                  {activeMobileMemoMethod === "iphone" && <ICloudImport />}
                </div>
              )}

              {!personalImportLocked && activeImportMethod === "obsidian" && <ObsidianImport />}
              {!personalImportLocked && activeImportMethod === "wechat-favorites" && <WeChatFavoritesImport />}
              {!personalImportLocked && activeImportMethod === "youdao" && <YoudaoImport />}
            </div>
          </div>
        </section>
      )}


    </div>
  );
}

// ============================================================================
// 数据库文件（.data）管理子组件
// ----------------------------------------------------------------------------
// - 所有登录用户都能看"我的数据"和"系统合计"
// - 管理员额外看到 data 目录占用 + 导出 / 导入按钮
// - 导入前弹窗二次确认，且要求输入当前密码换 sudoToken
//
// 对外暴露：命名导出，便于 SettingsModal「存储与空间」独立面板直接复用——
// 该面板只想聚焦于磁盘占用 / 导入 / 导出 / 清理 / VACUUM，避免让用户在
// "数据管理"大 tab 里被导入器 / 备份等无关子页干扰。
// ============================================================================

type DataFileInfo = Awaited<ReturnType<typeof api.dataFile.getInfo>>;
type AttachmentHealthReport = Awaited<ReturnType<typeof api.attachmentsAdmin.scanHealth>>;
type AttachmentStorageStatus = Awaited<ReturnType<typeof api.attachmentsAdmin.getStorageStatus>>;
type AttachmentRemoteCheck = Awaited<ReturnType<typeof api.attachmentsAdmin.checkRemoteStorage>>;
type AttachmentStorageConfig = Awaited<ReturnType<typeof api.attachmentsAdmin.getStorageConfig>>;

/** 字节转人类可读 */
function fmtBytes(n: number | undefined | null): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function DataFileSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DataFileInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [infoError, setInfoError] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [storageStatus, setStorageStatus] = useState<AttachmentStorageStatus | null>(null);
  const [storageStatusLoading, setStorageStatusLoading] = useState(false);
  const [storageConfig, setStorageConfig] = useState<AttachmentStorageConfig | null>(null);
  const [storageSecret, setStorageSecret] = useState("");
  const [storageSudoToken, setStorageSudoToken] = useState<string | null>(null);
  const [storageConfigBusy, setStorageConfigBusy] = useState(false);
  const [storageConfigMsg, setStorageConfigMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [remoteCheck, setRemoteCheck] = useState<AttachmentRemoteCheck | null>(null);
  const [remoteCheckLoading, setRemoteCheckLoading] = useState(false);
  const [remoteCheckError, setRemoteCheckError] = useState("");

  // 导出
  const [isExporting, setIsExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 导入
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmPwd, setConfirmPwd] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  // 维护：清理孤儿附件 / 压缩数据库
  const [isCleaningOrphans, setIsCleaningOrphans] = useState(false);
  const [isVacuuming, setIsVacuuming] = useState(false);
  const [maintenanceMsg, setMaintenanceMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 扫描孤儿（仅管理员，"只看不删"的预览版）
  // —— 与 cleanupOrphans 不同：cleanupOrphans 是直接清理，scan 只返回数量+字节，
  //    用来在删除前显示"将释放 X MB"，避免一冲动一键清空。
  const [isScanningOrphans, setIsScanningOrphans] = useState(false);

  // 阶段 C：附件健康检查（裂图/404 定位）。
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [healthReport, setHealthReport] = useState<AttachmentHealthReport | null>(null);

  // 阶段 D：附件修复向导（上传替代文件 / 移除悬空引用）。
  const repairUploadRef = useRef<HTMLInputElement>(null);
  const [repairUploadTarget, setRepairUploadTarget] = useState<AttachmentHealthReport["missingPhysicalFiles"][number] | null>(null);
  const [isRepairingAttachment, setIsRepairingAttachment] = useState(false);

  const reload = useCallback(async () => {
    setLoadingInfo(true);
    setInfoError("");
    try {
      const data = await api.dataFile.getInfo();
      setInfo(data);
    } catch (err: any) {
      setInfoError(err.message || "加载失败");
    } finally {
      setLoadingInfo(false);
    }
  }, []);

  const loadStorageStatus = useCallback(async () => {
    setStorageStatusLoading(true);
    try {
      const [status, config] = await Promise.all([
        api.attachmentsAdmin.getStorageStatus(),
        api.attachmentsAdmin.getStorageConfig(),
      ]);
      setStorageStatus(status);
      setStorageConfig(config);
      setStorageSecret("");
    } catch {
      setStorageStatus(null);
      setStorageConfig(null);
    } finally {
      setStorageStatusLoading(false);
    }
  }, []);

  const askStorageSudoPassword = useCallback(
    () => promptDialog({
      title: "管理员验证",
      description: "保存或测试对象存储配置需要输入当前管理员密码。",
      type: "password",
      confirmText: "继续",
      cancelText: "取消",
      placeholder: "当前密码",
    }),
    [],
  );

  const handleSaveStorageConfig = async (testAfterSave = false) => {
    if (!storageConfig) return;
    setStorageConfigBusy(true);
    setStorageConfigMsg(null);
    try {
      const input = {
        enabled: storageConfig.enabled,
        endpoint: storageConfig.endpoint,
        region: storageConfig.region || "auto",
        bucket: storageConfig.bucket,
        accessKeyId: storageConfig.accessKeyId,
        secretAccessKey: storageSecret || undefined,
        prefix: storageConfig.prefix,
      };
      const saved = await withSudo(
        (sudoToken) => api.attachmentsAdmin.putStorageConfig(input, sudoToken),
        askStorageSudoPassword,
        storageSudoToken,
      );
      if (!saved) return;
      setStorageSudoToken(saved.sudoToken);
      setStorageConfig(saved.result);
      setStorageSecret("");
      await loadStorageStatus();
      if (testAfterSave) {
        const tested = await withSudo(
          (sudoToken) => api.attachmentsAdmin.testStorageConfig(sudoToken),
          askStorageSudoPassword,
          saved.sudoToken,
        );
        if (tested?.result.ok) {
          setStorageSudoToken(tested.sudoToken);
          setStorageConfigMsg({ type: "ok", text: "配置已保存，连接测试通过。" });
        } else if (tested) {
          setStorageSudoToken(tested.sudoToken);
          setStorageConfigMsg({ type: "err", text: tested.result.error || "连接测试失败" });
        }
      } else {
        setStorageConfigMsg({ type: "ok", text: "配置已保存。" });
      }
    } catch (err: any) {
      setStorageConfigMsg({ type: "err", text: err?.message || "保存失败" });
    } finally {
      setStorageConfigBusy(false);
    }
  };

  const handleResetStorageConfig = async () => {
    if (!storageConfig) return;
    const ok = await confirmDialog({
      title: "恢复附件存储默认来源",
      description: "这会删除保存在数据库里的对象存储配置。之后系统会重新使用环境变量配置；如果没有环境变量，则回到本地附件存储。",
      confirmText: "恢复默认来源",
      danger: true,
    });
    if (!ok) return;

    setStorageConfigBusy(true);
    setStorageConfigMsg(null);
    try {
      const deleted = await withSudo(
        (sudoToken) => api.attachmentsAdmin.deleteStorageConfig(sudoToken),
        askStorageSudoPassword,
        storageSudoToken,
      );
      if (!deleted) return;
      setStorageSudoToken(deleted.sudoToken);
      setStorageConfig(deleted.result);
      setStorageSecret("");
      await loadStorageStatus();
      setStorageConfigMsg({ type: "ok", text: "已恢复默认来源。当前会使用环境变量配置；未配置环境变量时使用本地存储。" });
    } catch (err: any) {
      setStorageConfigMsg({ type: "err", text: err?.message || "恢复默认来源失败" });
    } finally {
      setStorageConfigBusy(false);
    }
  };

  const handleRemoteStorageCheck = async () => {
    setRemoteCheckLoading(true);
    setRemoteCheckError("");
    try {
      setRemoteCheck(await api.attachmentsAdmin.checkRemoteStorage(50));
    } catch (err: any) {
      setRemoteCheckError(err?.message || "远端检查失败");
    } finally {
      setRemoteCheckLoading(false);
    }
  };

  useEffect(() => {
    // 拉取当前用户角色 —— 管理员才显示导出/导入
    api.getMe()
      .then((u) => {
        const admin = (u as any)?.role === "admin";
        setIsAdmin(admin);
        if (admin) void loadStorageStatus();
      })
      .catch(() => {
        setIsAdmin(false);
        setStorageStatus(null);
        setRemoteCheck(null);
        setRemoteCheckError("");
      });
    reload();
  }, [reload, loadStorageStatus]);

  const handleExport = async () => {
    setIsExporting(true);
    setExportMsg(null);
    try {
      const out = await api.dataFile.downloadExport();
      setExportMsg({ type: "ok", text: t("dataManager.dataFile.exportSuccess", { filename: out.filename, size: fmtBytes(out.size) }) });
    } catch (err: any) {
      setExportMsg({ type: "err", text: t("dataManager.dataFile.exportFailed", { error: err.message || "error" }) });
    } finally {
      setIsExporting(false);
    }
  };

  /** 校验选中文件是否是 SQLite（读前 16 字节） */
  const validateSqliteFile = async (file: File): Promise<boolean> => {
    if (file.size > 500 * 1024 * 1024) return false;
    try {
      const head = await file.slice(0, 16).arrayBuffer();
      const bytes = new Uint8Array(head);
      const expected = "SQLite format 3\u0000";
      for (let i = 0; i < 16; i++) {
        if (bytes[i] !== expected.charCodeAt(i)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const handlePickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError("");
    setImportSuccess(null);
    if (file.size > 500 * 1024 * 1024) {
      setImportError(t("dataManager.dataFile.importTooLarge"));
      setSelectedFile(null);
      e.target.value = "";
      return;
    }
    const ok = await validateSqliteFile(file);
    if (!ok) {
      setImportError(t("dataManager.dataFile.importNotSqlite"));
      setSelectedFile(null);
      e.target.value = "";
      return;
    }
    setSelectedFile(file);
  };

  const handleOpenConfirm = () => {
    if (!selectedFile) return;
    setConfirmPwd("");
    setImportError("");
    setShowConfirm(true);
  };

  const handleImport = async () => {
    if (!selectedFile || !confirmPwd) return;
    setIsImporting(true);
    setImportError("");
    try {
      // 先拿 sudoToken
      const { sudoToken } = await api.requestSudoToken(confirmPwd);
      // 真正上传
      const res = await api.dataFile.uploadImport(selectedFile, sudoToken);
      setImportSuccess(
        t("dataManager.dataFile.importSuccess", { backup: res.preImportBackup }),
      );
      setSelectedFile(null);
      setShowConfirm(false);
      setConfirmPwd("");
      // 立即刷新统计（虽然后端需要重启才真正生效，但允许读取当前 db 句柄内的 schema）
      reload();
    } catch (err: any) {
      setImportError(
        err.code === "SUDO_PASSWORD_INVALID" || err.code === "WRONG_PASSWORD"
          ? t("dataManager.sudoPasswordRequired")
          : t("dataManager.dataFile.importFailed", { error: err.message || "error" }),
      );
    } finally {
      setIsImporting(false);
    }
  };

  /** 清理孤儿附件（所有登录用户均可；管理员会顺带做磁盘全量扫描） */
  const handleCleanupOrphans = async () => {
    setIsCleaningOrphans(true);
    setMaintenanceMsg(null);
    try {
      const res = await api.dataFile.cleanupOrphans();
      setMaintenanceMsg({
        type: "ok",
        text: t("dataManager.dataFile.cleanupOrphansSuccess", {
          dbRows: res.dbOrphansRemoved,
          dbFiles: res.dbOrphanFilesRemoved,
          // 本次新增：内容孤儿（notes.content 不再引用的附件）
          contentRows: res.contentOrphansRemoved,
          contentFiles: res.contentOrphanFilesRemoved,
          diskFiles: res.diskOrphansRemoved,
          totalSize: fmtBytes(res.totalFreedBytes),
          diskSize: fmtBytes(res.diskOrphanBytes),
        }),
      });
      reload();
    } catch (err: any) {
      setMaintenanceMsg({
        type: "err",
        text: t("dataManager.dataFile.cleanupOrphansFailed", { error: err.message || "error" }),
      });
    } finally {
      setIsCleaningOrphans(false);
    }
  };

  /** 仅扫描孤儿附件（不删）—— 管理员预览"将释放多少空间" */
  const handleScanOrphans = async () => {
    setIsScanningOrphans(true);
    setMaintenanceMsg(null);
    try {
      const res = await api.attachmentsAdmin.scanOrphans(24);
      const dbCount = res.dbOrphans.length;
      const contentCount = res.contentOrphans.length;
      if (dbCount === 0 && contentCount === 0) {
        setMaintenanceMsg({
          type: "ok",
          text: t("dataManager.dataFile.scanOrphansEmpty", {
            total: fmtBytes(res.totalAttachmentBytes),
          }),
        });
      } else {
        setMaintenanceMsg({
          type: "ok",
          text: t("dataManager.dataFile.scanOrphansResult", {
            reclaimable: fmtBytes(res.reclaimableBytes),
            dbCount,
            contentCount,
            total: fmtBytes(res.totalAttachmentBytes),
          }),
        });
      }
    } catch (err: any) {
      setMaintenanceMsg({
        type: "err",
        text: t("dataManager.dataFile.scanOrphansFailed", { error: err.message || "error" }),
      });
    } finally {
      setIsScanningOrphans(false);
    }
  };

  /** 阶段 C：附件健康检查 —— 找出 DB 行存在但物理文件缺失、正文悬空引用等问题 */
  const handleCheckAttachmentHealth = async () => {
    setIsCheckingHealth(true);
    setMaintenanceMsg(null);
    try {
      const res = await api.attachmentsAdmin.scanHealth(24);
      setHealthReport(res);
      const missing = res.missingPhysicalFiles.length;
      const dangling = res.danglingReferences.length;
      if (res.ok) {
        setMaintenanceMsg({
          type: "ok",
          text: t("dataManager.dataFile.healthOk", {
            attachments: res.totalAttachments,
            files: res.totalPhysicalFiles,
            total: fmtBytes(res.totalAttachmentBytes),
          }),
        });
      } else {
        setMaintenanceMsg({
          type: "err",
          text: t("dataManager.dataFile.healthIssues", { missing, dangling }),
        });
      }
    } catch (err: any) {
      setMaintenanceMsg({
        type: "err",
        text: t("dataManager.dataFile.healthFailed", { error: err.message || "error" }),
      });
    } finally {
      setIsCheckingHealth(false);
    }
  };

  const requestRepairSudoToken = async (): Promise<string | null> => {
    const pwd = await promptDialog({
      title: t("dataManager.dataFile.repairSudoTitle"),
      description: t("dataManager.dataFile.repairSudoDesc"),
      type: "password",
      placeholder: t("dataManager.sudoPasswordPlaceholder"),
      confirmText: t("common.confirm"),
      danger: true,
    });
    if (!pwd) return null;
    const { sudoToken } = await api.requestSudoToken(pwd);
    return sudoToken;
  };

  const handlePickReplacementFile = (issue: AttachmentHealthReport["missingPhysicalFiles"][number]) => {
    setRepairUploadTarget(issue);
    if (repairUploadRef.current) repairUploadRef.current.value = "";
    repairUploadRef.current?.click();
  };

  const handleReplacementSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = repairUploadTarget;
    e.target.value = "";
    if (!file || !target) return;

    const ok = await confirmDialog({
      title: t("dataManager.dataFile.repairUploadConfirmTitle"),
      description: t("dataManager.dataFile.repairUploadConfirmDesc", {
        id: target.id,
        filename: target.filename,
        file: file.name,
        size: fmtBytes(file.size),
      }),
      confirmText: t("dataManager.dataFile.repairUploadConfirm"),
      danger: true,
    });
    if (!ok) return;

    setIsRepairingAttachment(true);
    setMaintenanceMsg(null);
    try {
      const sudoToken = await requestRepairSudoToken();
      if (!sudoToken) return;
      const res = await api.attachmentsAdmin.uploadMissingReplacement(target.id, file, sudoToken);
      setHealthReport(res.health);
      setMaintenanceMsg({
        type: "ok",
        text: t("dataManager.dataFile.repairUploadSuccess", {
          rows: res.repairedRows,
          size: fmtBytes(res.size),
        }),
      });
      reload();
    } catch (err: any) {
      setMaintenanceMsg({
        type: "err",
        text: t("dataManager.dataFile.repairUploadFailed", { error: err.message || "error" }),
      });
    } finally {
      setIsRepairingAttachment(false);
      setRepairUploadTarget(null);
    }
  };

  const handleRemoveDanglingReferences = async () => {
    if (!healthReport || healthReport.danglingReferences.length === 0) return;
    const ids = Array.from(new Set(healthReport.danglingReferences.map((x) => x.attachmentId)));
    const noteIds = Array.from(new Set(healthReport.danglingReferences.map((x) => x.noteId)));
    const ok = await confirmDialog({
      title: t("dataManager.dataFile.repairDanglingConfirmTitle"),
      description: t("dataManager.dataFile.repairDanglingConfirmDesc", {
        refs: healthReport.danglingReferences.length,
        notes: noteIds.length,
      }),
      confirmText: t("dataManager.dataFile.repairDanglingConfirm"),
      danger: true,
    });
    if (!ok) return;

    setIsRepairingAttachment(true);
    setMaintenanceMsg(null);
    try {
      const sudoToken = await requestRepairSudoToken();
      if (!sudoToken) return;
      const res = await api.attachmentsAdmin.removeDanglingReferences({ attachmentIds: ids, noteIds }, sudoToken);
      setHealthReport(res.health);
      setMaintenanceMsg({
        type: "ok",
        text: t("dataManager.dataFile.repairDanglingSuccess", {
          refs: res.referencesRemoved,
          notes: res.notesUpdated,
        }),
      });
      reload();
    } catch (err: any) {
      setMaintenanceMsg({
        type: "err",
        text: t("dataManager.dataFile.repairDanglingFailed", { error: err.message || "error" }),
      });
    } finally {
      setIsRepairingAttachment(false);
    }
  };

  /** 压缩数据库（管理员） */
  const handleVacuum = async () => {
    setIsVacuuming(true);
    setMaintenanceMsg(null);
    try {
      const res = await api.dataFile.vacuum();
      setMaintenanceMsg({
        type: "ok",
        text: t("dataManager.dataFile.vacuumSuccess", {
          before: fmtBytes(res.before.total),
          after: fmtBytes(res.after.total),
          freed: fmtBytes(res.freed),
        }),
      });
      reload();
    } catch (err: any) {
      setMaintenanceMsg({
        type: "err",
        text: t("dataManager.dataFile.vacuumFailed", { error: err.message || "error" }),
      });
    } finally {
      setIsVacuuming(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Database size={18} className="text-violet-500" />
        <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {t("dataManager.dataFile.title")}
        </h4>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 space-y-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("dataManager.dataFile.description")}
        </p>

        {/* ===== 占用统计卡片 ===== */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <HardDrive size={14} className="text-zinc-500" />
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                {t("dataManager.dataFile.usageSectionTitle")}
              </span>
            </div>
            <button
              onClick={() => {
                void reload();
                if (isAdmin) void loadStorageStatus();
              }}
              disabled={loadingInfo}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-indigo-500 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loadingInfo ? "animate-spin" : ""} />
              {loadingInfo ? t("dataManager.dataFile.refreshing") : t("dataManager.dataFile.refresh")}
            </button>
          </div>

          {infoError && (
            <div className="text-xs text-red-500 mb-2 flex items-center gap-1">
              <AlertCircle size={12} /> {infoError}
            </div>
          )}

          {info && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* 我的数据 */}
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-3">
                <div className="text-xs font-medium text-zinc-500 mb-2">
                  {t("dataManager.dataFile.myData")}
                </div>
                <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1.5">
                  {fmtBytes(info.user.totalBytes)}
                </div>
                <div className="space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <div className="flex justify-between">
                    <span>{t("dataManager.dataFile.myNotes")}</span>
                    <span className="font-mono">{info.user.notes.count} · {fmtBytes(info.user.notes.bytes)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("dataManager.dataFile.myAttachments")}</span>
                    <span className="font-mono">{info.user.attachments.count} · {fmtBytes(info.user.attachments.bytes)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("dataManager.dataFile.myNotebooks")}</span>
                    <span className="font-mono">{info.user.notebookCount}</span>
                  </div>
                </div>
              </div>

              {/* 系统合计 */}
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-3">
                <div className="text-xs font-medium text-zinc-500 mb-2">
                  {t("dataManager.dataFile.systemTotal")}
                </div>
                <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1.5">
                  {fmtBytes(info.dbFile.total)}
                </div>
                <div className="space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <div className="flex justify-between">
                    <span>{t("dataManager.dataFile.dbFileMain")}</span>
                    <span className="font-mono">{fmtBytes(info.dbFile.main)}</span>
                  </div>
                  {info.dbFile.wal > 0 && (
                    <div className="flex justify-between">
                      <span>{t("dataManager.dataFile.dbFileWal")}</span>
                      <span className="font-mono">{fmtBytes(info.dbFile.wal)}</span>
                    </div>
                  )}
                  {info.dbFile.shm > 0 && (
                    <div className="flex justify-between">
                      <span>{t("dataManager.dataFile.dbFileShm")}</span>
                      <span className="font-mono">{fmtBytes(info.dbFile.shm)}</span>
                    </div>
                  )}
                  {typeof info.system.dataDirBytes === "number" && (
                    <div className="flex justify-between">
                      <span>{t("dataManager.dataFile.dataDirSize")}</span>
                      <span className="font-mono">{fmtBytes(info.system.dataDirBytes)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>{t("dataManager.dataFile.noteCount")}</span>
                    <span className="font-mono">{info.system.noteCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("dataManager.dataFile.userCount")}</span>
                    <span className="font-mono">{info.system.userCount}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ===== 导出 ===== */}
        {isAdmin && (storageStatus || storageStatusLoading) && (
          <div className="pt-3 border-t border-zinc-200 dark:border-zinc-700">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <ServerCog size={14} className="text-sky-500" />
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  附件存储
                </span>
              </div>
              <button
                onClick={loadStorageStatus}
                disabled={storageStatusLoading}
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-sky-500 disabled:opacity-50"
              >
                <RefreshCw size={12} className={storageStatusLoading ? "animate-spin" : ""} />
                刷新
              </button>
            </div>

            {storageStatus ? (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-3 space-y-2 text-xs text-zinc-600 dark:text-zinc-400">
                <div className="flex justify-between gap-3">
                  <span>当前模式</span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {storageStatus.storage.driver === "s3" ? "对象存储" : "本地存储"}
                  </span>
                </div>
                {storageStatus.storage.driver === "s3" && (
                  <>
                    <div className="flex justify-between gap-3">
                      <span>Bucket</span>
                      <span className="font-mono text-right break-all">{storageStatus.storage.bucket || "-"}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>Endpoint</span>
                      <span className="font-mono text-right break-all">{storageStatus.storage.endpoint || "-"}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span>Prefix</span>
                      <span className="font-mono text-right break-all">{storageStatus.storage.prefix || "-"}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between gap-3">
                  <span>数据库附件</span>
                  <span className="font-mono">{storageStatus.db.rows} 个 · {fmtBytes(storageStatus.db.bytes)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>本地文件</span>
                  <span className="font-mono">{storageStatus.local.files} 个 · {fmtBytes(storageStatus.local.bytes)}</span>
                </div>
                <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
                  <div className="text-zinc-500 dark:text-zinc-400 mb-1">本地目录</div>
                  <div className="font-mono break-all text-zinc-700 dark:text-zinc-300">{storageStatus.local.dir}</div>
                </div>
                {storageConfig && (
                  <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-zinc-500 dark:text-zinc-400">对象存储配置</div>
                        <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                          来源：{storageConfig.source === "settings" ? "系统设置" : storageConfig.source === "env" ? "环境变量" : "默认本地"}
                        </div>
                      </div>
                      <label className="inline-flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={storageConfig.enabled}
                          onChange={(e) => setStorageConfig((s) => s ? { ...s, enabled: e.target.checked } : s)}
                        />
                        启用
                      </label>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        value={storageConfig.endpoint}
                        onChange={(e) => setStorageConfig((s) => s ? { ...s, endpoint: e.target.value } : s)}
                        placeholder="https://account.r2.cloudflarestorage.com"
                        className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs"
                      />
                      <input
                        value={storageConfig.bucket}
                        onChange={(e) => setStorageConfig((s) => s ? { ...s, bucket: e.target.value } : s)}
                        placeholder="bucket"
                        className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs"
                      />
                      <input
                        value={storageConfig.region}
                        onChange={(e) => setStorageConfig((s) => s ? { ...s, region: e.target.value } : s)}
                        placeholder="auto"
                        className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs"
                      />
                      <input
                        value={storageConfig.prefix}
                        onChange={(e) => setStorageConfig((s) => s ? { ...s, prefix: e.target.value } : s)}
                        placeholder="prefix"
                        className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs"
                      />
                      <input
                        value={storageConfig.accessKeyId}
                        onChange={(e) => setStorageConfig((s) => s ? { ...s, accessKeyId: e.target.value } : s)}
                        placeholder="Access Key ID"
                        className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs"
                      />
                      <input
                        value={storageSecret}
                        onChange={(e) => setStorageSecret(e.target.value)}
                        type="password"
                        placeholder={storageConfig.secretAccessKeySet ? "Secret 已保存，留空不修改" : "Secret Access Key"}
                        className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs"
                      />
                    </div>
                    {storageConfigMsg && (
                      <div className={`rounded-md px-2 py-1 text-[11px] ${storageConfigMsg.type === "ok"
                        ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-300"
                        }`}>
                        {storageConfigMsg.text}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void handleSaveStorageConfig(false)}
                        disabled={storageConfigBusy}
                        className="inline-flex items-center gap-1 rounded-md bg-sky-600 hover:bg-sky-700 text-white px-2 py-1 text-[11px] font-medium disabled:opacity-50"
                      >
                        {storageConfigBusy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        保存配置
                      </button>
                      <button
                        onClick={() => void handleSaveStorageConfig(true)}
                        disabled={storageConfigBusy}
                        className="inline-flex items-center gap-1 rounded-md border border-sky-200 dark:border-sky-900/50 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 disabled:opacity-50"
                      >
                        {storageConfigBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        保存并测试
                      </button>
                      {storageConfig.source === "settings" && (
                        <button
                          onClick={() => void handleResetStorageConfig()}
                          disabled={storageConfigBusy}
                          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                        >
                          {storageConfigBusy ? <Loader2 size={12} className="animate-spin" /> : <Eraser size={12} />}
                          恢复默认来源
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {storageStatus.migrationCommand && (
                  <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    <div className="text-zinc-500 dark:text-zinc-400 mb-1">迁移检查</div>
                    <code className="block rounded-md bg-zinc-100 dark:bg-zinc-950 px-2 py-1 text-[11px] text-zinc-700 dark:text-zinc-300 overflow-x-auto">
                      {storageStatus.migrationCommand}
                    </code>
                  </div>
                )}
                {storageStatus.storage.driver === "s3" && (
                  <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-zinc-500 dark:text-zinc-400">远端对象检查</div>
                        <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                          默认抽样检查 50 个数据库附件路径
                        </div>
                      </div>
                      <button
                        onClick={handleRemoteStorageCheck}
                        disabled={remoteCheckLoading}
                        className="inline-flex items-center gap-1 rounded-md border border-sky-200 dark:border-sky-900/50 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 disabled:opacity-50"
                      >
                        {remoteCheckLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        检查远端
                      </button>
                    </div>
                    {remoteCheckError && (
                      <div className="rounded-md bg-red-50 dark:bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-300">
                        {remoteCheckError}
                      </div>
                    )}
                    {remoteCheck && (
                      <div className={`rounded-md px-2 py-1 text-[11px] ${remoteCheck.ok
                        ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        }`}>
                        <div>
                          已检查 {remoteCheck.checked}/{remoteCheck.total} 个，存在 {remoteCheck.exists} 个，缺失 {remoteCheck.missing.length} 个，错误 {remoteCheck.errors.length} 个
                        </div>
                        {remoteCheck.missing.slice(0, 5).map((x) => (
                          <div key={`missing-${x.path}`} className="mt-1 font-mono break-all">
                            缺失: {x.path}
                          </div>
                        ))}
                        {remoteCheck.errors.slice(0, 5).map((x) => (
                          <div key={`error-${x.path}`} className="mt-1 font-mono break-all">
                            错误: {x.path} {x.status ? `(${x.status})` : ""} {x.error}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-3 text-xs text-zinc-500">
                正在读取附件存储状态...
              </div>
            )}
          </div>
        )}

        {isAdmin && (
          <div className="pt-3 border-t border-zinc-200 dark:border-zinc-700">
            <div className="flex items-center gap-2 mb-2">
              <FolderDown size={14} className="text-indigo-500" />
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                {t("dataManager.dataFile.exportSectionTitle")}
              </span>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
              {t("dataManager.dataFile.exportDescription")}
            </p>
            {exportMsg && (
              <div className={`text-xs mb-2 flex items-start gap-1 ${exportMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
                {exportMsg.type === "ok" ? <CheckCircle size={12} className="mt-0.5" /> : <AlertCircle size={12} className="mt-0.5" />}
                <span>{exportMsg.text}</span>
              </div>
            )}
            <button
              onClick={handleExport}
              disabled={isExporting}
              className={`flex items-center justify-center w-full py-2 px-3 rounded-lg font-medium text-sm transition-all ${isExporting
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                : "bg-violet-600 hover:bg-violet-700 text-white shadow-sm"
                }`}
            >
              {isExporting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t("dataManager.dataFile.exporting")}
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  {t("dataManager.dataFile.exportButton")}
                </>
              )}
            </button>
          </div>
        )}

        {/* ===== 导入 ===== */}
        {isAdmin && (
          <div className="pt-3 border-t border-zinc-200 dark:border-zinc-700">
            <div className="flex items-center gap-2 mb-2">
              <FileUp size={14} className="text-amber-500" />
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                {t("dataManager.dataFile.importSectionTitle")}
              </span>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
              {t("dataManager.dataFile.importDescription")}
            </p>

            {importSuccess && (
              <div className="text-xs text-green-600 mb-2 flex items-start gap-1">
                <CheckCircle size={12} className="mt-0.5" />
                <span>{importSuccess}</span>
              </div>
            )}
            {importError && !showConfirm && (
              <div className="text-xs text-red-500 mb-2 flex items-start gap-1">
                <AlertCircle size={12} className="mt-0.5" />
                <span>{importError}</span>
              </div>
            )}

            <input
              ref={fileRef}
              type="file"
              accept=".data,.db,.sqlite,.sqlite3,application/octet-stream"
              onChange={handlePickFile}
              className="hidden"
            />

            {!selectedFile ? (
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center justify-center w-full py-2 px-3 rounded-lg font-medium text-sm border border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-amber-400 hover:text-amber-600 transition-colors"
              >
                <Upload className="w-4 h-4 mr-2" />
                {t("dataManager.dataFile.importButton")}
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-700/30">
                  <FileText size={14} className="text-amber-600 flex-shrink-0" />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate flex-1">
                    {t("dataManager.dataFile.importSelected", {
                      name: selectedFile.name,
                      size: fmtBytes(selectedFile.size),
                    })}
                  </span>
                  <button
                    onClick={() => { setSelectedFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                    className="text-xs text-zinc-500 hover:text-red-500"
                  >
                    {t("dataManager.dataFile.importChange")}
                  </button>
                </div>
                <button
                  onClick={handleOpenConfirm}
                  className="flex items-center justify-center w-full py-2 px-3 rounded-lg font-medium text-sm bg-amber-600 hover:bg-amber-700 text-white shadow-sm"
                >
                  <AlertTriangle className="w-4 h-4 mr-2" />
                  {t("dataManager.dataFile.importConfirm")}
                </button>
              </div>
            )}
          </div>
        )}

        {!isAdmin && (
          <div className="pt-3 border-t border-zinc-200 dark:border-zinc-700 text-xs text-zinc-400">
            {t("dataManager.dataFile.adminOnly")}
          </div>
        )}

        {/* ===== 维护：清理孤儿附件 / 压缩数据库 ===== */}
        <div className="pt-3 border-t border-zinc-200 dark:border-zinc-700">
          <div className="flex items-center gap-2 mb-2">
            <Eraser size={14} className="text-rose-500" />
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              {t("dataManager.dataFile.maintenanceSectionTitle")}
            </span>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            {t("dataManager.dataFile.maintenanceDescription")}
          </p>

          {maintenanceMsg && (
            <div className={`text-xs mb-2 flex items-start gap-1 ${maintenanceMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
              {maintenanceMsg.type === "ok" ? <CheckCircle size={12} className="mt-0.5" /> : <AlertCircle size={12} className="mt-0.5" />}
              <span>{maintenanceMsg.text}</span>
            </div>
          )}

          <input
            ref={repairUploadRef}
            type="file"
            className="hidden"
            onChange={handleReplacementSelected}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {isAdmin && (
              <button
                onClick={handleCheckAttachmentHealth}
                disabled={isRepairingAttachment || isCheckingHealth || isScanningOrphans || isCleaningOrphans || isVacuuming}
                className={`flex items-center justify-center py-2 px-3 rounded-lg font-medium text-sm transition-all ${isRepairingAttachment || isCheckingHealth || isScanningOrphans || isCleaningOrphans || isVacuuming
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                  : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
                  }`}
              >
                {isCheckingHealth ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t("dataManager.dataFile.checkingHealth")}
                  </>
                ) : (
                  <>
                    <ShieldAlert className="w-4 h-4 mr-2" />
                    {t("dataManager.dataFile.healthCheckButton")}
                  </>
                )}
              </button>
            )}

            {isAdmin && (
              <button
                onClick={handleScanOrphans}
                disabled={isRepairingAttachment || isCheckingHealth || isScanningOrphans || isCleaningOrphans || isVacuuming}
                className={`flex items-center justify-center py-2 px-3 rounded-lg font-medium text-sm transition-all ${isRepairingAttachment || isCheckingHealth || isScanningOrphans || isCleaningOrphans || isVacuuming
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                  : "bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700"
                  }`}
              >
                {isScanningOrphans ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t("dataManager.dataFile.scanningOrphans")}
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    {t("dataManager.dataFile.scanOrphansButton")}
                  </>
                )}
              </button>
            )}

            <button
              onClick={handleCleanupOrphans}
              disabled={isCheckingHealth || isCleaningOrphans || isVacuuming || isScanningOrphans}
              className={`flex items-center justify-center py-2 px-3 rounded-lg font-medium text-sm transition-all ${isCheckingHealth || isCleaningOrphans || isVacuuming || isScanningOrphans
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                : "bg-rose-600 hover:bg-rose-700 text-white shadow-sm"
                }`}
            >
              {isCleaningOrphans ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t("dataManager.dataFile.cleaningOrphans")}
                </>
              ) : (
                <>
                  <Eraser className="w-4 h-4 mr-2" />
                  {t("dataManager.dataFile.cleanupOrphansButton")}
                </>
              )}
            </button>

            {isAdmin && (
              <button
                onClick={handleVacuum}
                disabled={isRepairingAttachment || isCheckingHealth || isVacuuming || isCleaningOrphans || isScanningOrphans}
                className={`flex items-center justify-center py-2 px-3 rounded-lg font-medium text-sm transition-all ${isRepairingAttachment || isCheckingHealth || isVacuuming || isCleaningOrphans || isScanningOrphans
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
                  }`}
              >
                {isVacuuming ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t("dataManager.dataFile.vacuuming")}
                  </>
                ) : (
                  <>
                    <Minimize2 className="w-4 h-4 mr-2" />
                    {t("dataManager.dataFile.vacuumButton")}
                  </>
                )}
              </button>
            )}
          </div>

          {isAdmin && healthReport && (
            <div className="mt-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-900/40 p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {healthReport.ok ? (
                    <CheckCircle size={16} className="text-emerald-500" />
                  ) : (
                    <AlertTriangle size={16} className="text-amber-500" />
                  )}
                  <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                    {t("dataManager.dataFile.healthReportTitle")}
                  </span>
                </div>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {new Date(healthReport.checkedAt).toLocaleString()}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="rounded-md bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-2">
                  <div className="text-zinc-500 dark:text-zinc-400">{t("dataManager.dataFile.healthMissingFiles")}</div>
                  <div className="mt-1 font-semibold text-zinc-900 dark:text-zinc-100">{healthReport.missingPhysicalFiles.length}</div>
                </div>
                <div className="rounded-md bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-2">
                  <div className="text-zinc-500 dark:text-zinc-400">{t("dataManager.dataFile.healthDanglingRefs")}</div>
                  <div className="mt-1 font-semibold text-zinc-900 dark:text-zinc-100">{healthReport.danglingReferences.length}</div>
                </div>
                <div className="rounded-md bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-2">
                  <div className="text-zinc-500 dark:text-zinc-400">{t("dataManager.dataFile.healthSharedFiles")}</div>
                  <div className="mt-1 font-semibold text-zinc-900 dark:text-zinc-100">{healthReport.sharedPhysicalFiles.length}</div>
                </div>
                <div className="rounded-md bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-2">
                  <div className="text-zinc-500 dark:text-zinc-400">{t("dataManager.dataFile.healthReclaimable")}</div>
                  <div className="mt-1 font-semibold text-zinc-900 dark:text-zinc-100">{fmtBytes(healthReport.orphans.reclaimableBytes)}</div>
                </div>
              </div>

              {healthReport.missingPhysicalFiles.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    {t("dataManager.dataFile.healthMissingFilesTitle")}
                  </div>
                  <div className="max-h-36 overflow-auto rounded-md border border-amber-200/60 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-500/5 divide-y divide-amber-200/50 dark:divide-amber-900/40">
                    {healthReport.missingPhysicalFiles.slice(0, 8).map((x) => (
                      <div key={x.id} className="px-2 py-1.5 text-[11px] text-amber-900 dark:text-amber-100 flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-mono truncate">{x.id}</div>
                          <div className="truncate opacity-80">
                            {x.noteTitle || x.noteId} · {x.filename} · {fmtBytes(x.size)} · {t("dataManager.dataFile.healthReferencedBy", { count: x.referencedBy })}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={isRepairingAttachment}
                          onClick={() => handlePickReplacementFile(x)}
                          className="shrink-0 px-2 py-1 rounded border border-amber-300/70 dark:border-amber-700/60 bg-white/70 dark:bg-zinc-950/60 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50"
                        >
                          {t("dataManager.dataFile.repairUploadButton")}
                        </button>
                      </div>
                    ))}
                    {healthReport.missingPhysicalFiles.length > 8 && (
                      <div className="px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                        {t("dataManager.dataFile.healthMore", { count: healthReport.missingPhysicalFiles.length - 8 })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {healthReport.danglingReferences.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-red-700 dark:text-red-300">
                      {t("dataManager.dataFile.healthDanglingRefsTitle")}
                    </div>
                    <button
                      type="button"
                      disabled={isRepairingAttachment}
                      onClick={handleRemoveDanglingReferences}
                      className="text-[11px] px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                    >
                      {isRepairingAttachment ? t("dataManager.dataFile.repairing") : t("dataManager.dataFile.repairDanglingButton")}
                    </button>
                  </div>
                  <div className="max-h-32 overflow-auto rounded-md border border-red-200/60 dark:border-red-900/50 bg-red-50/40 dark:bg-red-500/5 divide-y divide-red-200/50 dark:divide-red-900/40">
                    {healthReport.danglingReferences.slice(0, 8).map((x, idx) => (
                      <div key={`${x.noteId}-${x.attachmentId}-${idx}`} className="px-2 py-1.5 text-[11px] text-red-900 dark:text-red-100">
                        <div className="font-mono truncate">{x.attachmentId}</div>
                        <div className="truncate opacity-80">{x.noteTitle || x.noteId}</div>
                      </div>
                    ))}
                    {healthReport.danglingReferences.length > 8 && (
                      <div className="px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">
                        {t("dataManager.dataFile.healthMore", { count: healthReport.danglingReferences.length - 8 })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {t("dataManager.dataFile.healthHint")}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 导入二次确认弹窗 */}
      <AnimatePresence>
        {showConfirm && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm"
              onClick={() => !isImporting && setShowConfirm(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: "spring", duration: 0.4, bounce: 0 }}
              className="relative bg-white dark:bg-zinc-900 w-full max-w-md p-6 rounded-xl shadow-2xl border border-amber-200 dark:border-amber-900/50"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={20} className="text-amber-600 dark:text-amber-500" />
                </div>
                <h4 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                  {t("dataManager.dataFile.importConfirmTitle")}
                </h4>
              </div>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
                {t("dataManager.dataFile.importConfirmDesc")}
              </p>

              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
                {t("dataManager.sudoPasswordLabel")}
              </label>
              <input
                type="password"
                value={confirmPwd}
                onChange={(e) => { setConfirmPwd(e.target.value); setImportError(""); }}
                placeholder={t("dataManager.sudoPasswordPlaceholder")}
                autoComplete="current-password"
                className="w-full px-3 py-2 border rounded-lg bg-transparent text-zinc-900 dark:text-zinc-100 outline-none text-sm transition-colors border-zinc-300 dark:border-zinc-700 focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
                autoFocus
              />

              {importError && (
                <p className="text-sm text-red-500 mt-2">{importError}</p>
              )}

              <div className="flex justify-end gap-3 mt-5">
                <button
                  onClick={() => { setShowConfirm(false); setConfirmPwd(""); }}
                  disabled={isImporting}
                  className="px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={handleImport}
                  disabled={isImporting || !confirmPwd}
                  className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg flex items-center transition-colors"
                >
                  {isImporting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {isImporting ? t("dataManager.dataFile.importing") : t("dataManager.dataFile.importConfirm")}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </section>
  );
}
