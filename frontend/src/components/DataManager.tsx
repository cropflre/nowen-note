import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download, Upload, CheckCircle, Loader2, FileText,
  AlertCircle, Trash2, FileUp, FolderDown, AlertTriangle,
  Database, HardDrive, RefreshCw, Eraser, Minimize2,
  Save, ShieldAlert, Clock, Server,
  Lock, Eye, EyeOff, X,
  Mail, Send, Settings as SettingsIcon, ChevronDown, ChevronRight,
  BookOpen, ExternalLink,
  User as UserIcon, Users, ServerCog,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { exportAllNotes, ExportProgress } from "@/lib/exportService";
import {
  readMarkdownFiles, readMarkdownFromZipWithMeta, importNotes,
  ImportFileInfo, ImportProgress
} from "@/lib/importService";
import { useApp, useAppActions } from "@/store/AppContext";
import { api, withSudo, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import MiCloudImport from "@/components/MiCloudImport";
import OppoCloudImport from "@/components/OppoCloudImport";
import ICloudImport from "@/components/iCloudImport";
import YoudaoImport from "@/components/YoudaoImport";
import type { Workspace } from "@/types";

// ============================================================================
// 一级 Tab：scope —— 个人空间 / 工作区 / 系统
// ----------------------------------------------------------------------------
// 拆分动机：
//   - 个人空间 / 工作区：导出/导入是真正"按数据范围隔离"的——后端 export 路由
//     已支持 ?workspaceId= 过滤（personal=NULL）。两个 Tab 各自带自己的 scope，
//     不依赖侧边栏当前选中的 workspace（避免在弹窗里改 currentWorkspace
//     触发 App 顶层的"工作区切换重置流程"）。
//   - 系统：数据库 / 备份 / 危险区在后端是 SQLite 文件级 / 全库范围操作，
//     本质上和"哪个工作区"无关，单独一栏并显著标注"全库范围"，避免误导。
//
// 入口闸门：整个 DataManager 仅系统管理员（User.role === "admin"）可访问；
//   外层 SettingsModal 已用 isAdmin 控制 tab 可见性，这里再加一层防御性闸门。
// ============================================================================

type Scope = "personal" | "workspace" | "system";
type SubTab = "export" | "import" | "database" | "backup" | "danger";

/** 各 scope 下允许的二级 Tab 集合（顺序即展示顺序） */
const SUBTABS_BY_SCOPE: Record<Scope, ReadonlyArray<SubTab>> = {
  personal: ["export", "import"],
  workspace: ["export", "import"],
  system: ["database", "backup", "danger"],
};

export default function DataManager() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  // -----------------------------------------------------------------
  // 入口闸门：拉一次 me 判断是否为系统管理员 + 读取 per-user 功能开关
  //   - admin：展示完整三个 scope（personal / workspace / system）
  //   - 普通用户：仅展示 personal，且 personal 的导出/导入再叠加一层由管理员
  //     在「用户管理」里对该用户设置的开关（personalExport/Import Enabled）
  //     进行禁用或隐藏。
  //
  // 注：v6 起这两个开关从站点级 system_settings 下沉为 users 表 per-user 字段，
  // 这里直接从 /api/me 读最新值；老后端若不返回字段则按 true 兜底保持原行为。
  // -----------------------------------------------------------------
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [personalExportAllowed, setPersonalExportAllowed] = useState(true);
  const [personalImportAllowed, setPersonalImportAllowed] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => {
        if (cancelled) return;
        setIsAdmin((u as any)?.role === "admin");
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
  // 一级 / 二级 tab 状态
  // -----------------------------------------------------------------
  const [scope, setScope] = useState<Scope>("personal");
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("export");

  // 切换一级 tab 时，把二级 tab 自动重置到该 scope 下的首项，避免出现
  // "工作区 Tab 但激活的是 database"这种非法组合。
  useEffect(() => {
    const allowed = SUBTABS_BY_SCOPE[scope];
    if (!allowed.includes(activeSubTab)) {
      setActiveSubTab(allowed[0]);
    }
  }, [scope, activeSubTab]);

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
   *   - system → 不参与
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

  // Import state
  const [importFiles, setImportFiles] = useState<ImportFileInfo[]>([]);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [isImporting, setIsImporting] = useState(false);
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

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    await processFiles(files);
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(e.target.files);
    }
  };

  const processFiles = async (files: FileList) => {
    let result: ImportFileInfo[] = [];
    const fileArray = Array.from(files);
    const zipFile = fileArray.find((f) => f.name.endsWith(".zip"));

    if (zipFile) {
      const r = await readMarkdownFromZipWithMeta(zipFile);
      result = r.files;
      setHasZip(true);
      // zip 由其内部目录/zip 文件名派生笔记本，关闭 per-file
      setPerFileNotebook(false);

      // P1-2：试图依据 meta.rootNotebookId 预选目标笔记本
      // 仅当 scope 与侧边栏匹配且 rootNotebookId 在当前笔记本列表里仍存在时才预选，
      // 避免传递 "看不见的 id" 到后端造成导入到错误位置。
      // 注：scopeMatchesGlobal 在 handleImport 里也算了一次（同语义），这里独立局部
      // 计算一份，避免提升引用 / 闭包绑定问题（TS 也不允许引用还未声明的常量）。
      const scopeMatchesGlobal = effectiveWorkspaceId === getCurrentWorkspace();
      if (r.meta && r.meta.rootNotebookId && scopeMatchesGlobal) {
        const hit = state.notebooks.find((nb) => nb.id === r.meta!.rootNotebookId);
        if (hit) {
          setSelectedNotebookId(hit.id);
          setZipMetaHint({ kind: "matched", notebookName: hit.name });
        } else {
          // 未命中：不覆盖用户上次选择，仅提示
          setZipMetaHint({
            kind: "missing",
            rootNotebookName: r.meta.rootNotebookName,
          });
        }
      } else {
        // 不是 nowen-note 导出的 zip，或 scope 不匹配：清理上一轮 hint
        setZipMetaHint(null);
      }
    } else {
      result = await readMarkdownFiles(files);
      setHasZip(false);
      setZipMetaHint(null);
      // 散文件默认开启 per-file：以文件名作为笔记本名，而非统一落到"导入的笔记"
      setPerFileNotebook(true);
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
    const result = await importNotes(
      importFiles,
      safeNotebookId || undefined,
      (p) => setImportProgress(p),
      {
        perFileNotebook: usePerFile,
        duplicateStrategy,
        workspaceId: effectiveWorkspaceId,
      }
    );
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
      // 仅当目标 scope 与全局一致时，才需要刷新侧边栏的笔记本列表（否则
      // refresh 拿到的还是侧边栏 ws 的，不会看到导入的笔记本）。
      if (scopeMatchesGlobal) {
        api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      }
      setTimeout(() => {
        setImportFiles([]);
        setImportProgress(null);
        setHasZip(false);
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
  };

  const selectedCount = importFiles.filter((f) => f.selected).length;

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

  // -----------------------------------------------------------------
  // 入口闸门
  //   - isAdmin === null：身份未拉到，渲染骨架占位（避免闪现拒绝页又秒变正常）
  //   - isAdmin === true：完整三 scope（personal/workspace/system）
  //   - isAdmin === false：仅展示 personal scope 的导出/导入；workspace/system
  //     scope 在下方 tab 渲染时直接从可选项中移除，且 personal 内部还会按
  //     personalExport/Import Locked 进一步禁用按钮。
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

        {/* ===== 一级 Tab：scope（个人空间 / 工作区 / 系统） =====
            把"导出/导入/数据库/备份/危险区"按数据范围拆开：
              - 个人空间：你自己的数据（notes.workspaceId IS NULL）
              - 工作区：当前选中的协作工作区数据
              - 系统：SQLite 文件级 / 全库范围操作（与具体工作区无关）
            选中后，下方的二级 tab 会按 SUBTABS_BY_SCOPE 自动过滤。 */}
        <div
          role="tablist"
          aria-label="data scope"
          className="flex flex-wrap gap-1 p-1 mb-3 rounded-lg bg-zinc-100/70 dark:bg-zinc-800/50 border border-zinc-200/60 dark:border-zinc-800"
        >
          {([
            { id: "personal",  icon: UserIcon,  label: t('dataManager.scope.personal'), adminOnly: false },
            { id: "workspace", icon: Users,     label: t('dataManager.scope.workspace'), adminOnly: true  },
            { id: "system",    icon: ServerCog, label: t('dataManager.scope.system'),   adminOnly: true  },
          ] as const)
            // 非管理员：只保留 personal。workspace/system 涉及跨用户/全库操作，
            // 严格 admin-only —— 不仅隐藏按钮，连 tab 都不渲染，避免被看见。
            .filter((s) => isAdmin || !s.adminOnly)
            .map((s) => {
            const active = scope === s.id;
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                role="tab"
                aria-selected={active}
                onClick={() => setScope(s.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm"
                    : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-white/60 dark:hover:bg-zinc-900/40"
                }`}
              >
                <Icon size={14} />
                {s.label}
              </button>
            );
          })}
        </div>

        {/* ===== 当前 scope 提示横幅 =====
            明确告诉用户当前正在操作哪部分数据；workspace scope 还要让用户选具体工作区。 */}
        {scope === "personal" && (
          <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg border border-indigo-200/60 dark:border-indigo-900/40 bg-indigo-50/40 dark:bg-indigo-500/5 text-xs text-indigo-700 dark:text-indigo-300">
            <UserIcon size={14} className="flex-shrink-0 mt-0.5" />
            <span>{t('dataManager.scope.personalHint')}</span>
          </div>
        )}
        {scope === "workspace" && (
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                {t('dataManager.scope.currentWorkspaceLabel')}
              </span>
              {workspaces.length === 0 ? (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  {t('dataManager.scope.workspaceNeedSwitch')}
                </span>
              ) : (
                <select
                  value={selectedWorkspaceId}
                  onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                  className="text-xs rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-2 py-1 outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500"
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              )}
            </div>
            {selectedWorkspaceName && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-500/5 text-xs text-emerald-700 dark:text-emerald-300">
                <Users size={14} className="flex-shrink-0 mt-0.5" />
                <span>{t('dataManager.scope.workspaceHint', { name: selectedWorkspaceName })}</span>
              </div>
            )}
          </div>
        )}
        {scope === "system" && (
          <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-500/5 text-xs text-amber-700 dark:text-amber-300">
            <ServerCog size={14} className="flex-shrink-0 mt-0.5" />
            <span>{t('dataManager.scope.systemHint')}</span>
          </div>
        )}

        {/* ===== 二级 Tab 切换 =====
            按当前 scope 过滤可见项：personal/workspace 只显示导出/导入；
            system 显示数据库/备份/危险区。 */}
        <div
          role="tablist"
          aria-label={t('dataManager.title')}
          className="flex flex-wrap gap-1 p-1 rounded-lg bg-zinc-100/70 dark:bg-zinc-800/50 border border-zinc-200/60 dark:border-zinc-800"
        >
          {([
            { id: "export",   icon: FolderDown,      label: t('dataManager.tabs.export'),   tone: "indigo"  },
            { id: "import",   icon: FileUp,          label: t('dataManager.tabs.import'),   tone: "emerald" },
            { id: "database", icon: Database,        label: t('dataManager.tabs.database'), tone: "sky"     },
            { id: "backup",   icon: Save,            label: t('dataManager.tabs.backup'),   tone: "violet"  },
            { id: "danger",   icon: AlertTriangle,   label: t('dataManager.tabs.danger'),   tone: "red"     },
          ] as const).filter((tab) => SUBTABS_BY_SCOPE[scope].includes(tab.id)).map((tab) => {
            const active = activeSubTab === tab.id;
            const Icon = tab.icon;
            const activeToneClass =
              tab.tone === "red"
                ? "bg-white dark:bg-zinc-900 text-red-600 dark:text-red-400 shadow-sm"
                : "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm";
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                onClick={() => setActiveSubTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? activeToneClass
                    : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-white/60 dark:hover:bg-zinc-900/40"
                }`}
              >
                <Icon size={14} className={active && tab.tone === "red" ? "text-red-500" : undefined} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ===== 导出区域 ===== */}
      {activeSubTab === "export" && (
      <section>
        <div className="flex items-center gap-2 mb-3">
          <FolderDown size={18} className="text-indigo-500" />
          <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('dataManager.exportBackup')}</h4>
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
            {t('dataManager.exportDescription')}
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
            className={`flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
              isExporting || workspaceScopeNotReady || personalExportLocked
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
        </div>
      </section>
      )}

      {/* ===== 导入区域（含第三方导入入口） ===== */}
      {activeSubTab === "import" && (
      <>
      <section>
        <div className="flex items-center gap-2 mb-3">
          <FileUp size={18} className="text-emerald-500" />
          <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('dataManager.importNotes')}</h4>
        </div>

        {/* 与 export 区对称：管理员关闭"个人空间导入"时，对普通用户展示 lock 横幅
            并禁用下方入口（第三方导入也一并隐藏，避免绕过主入口从小米云/OPPO 云
            等途径导入）。 */}
        {personalImportLocked && (
          <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-500/5 text-xs text-amber-700 dark:text-amber-300">
            <ShieldAlert size={14} className="flex-shrink-0 mt-0.5" />
            <span>{t('dataManager.scope.personalImportDisabled')}</span>
          </div>
        )}

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            {t('dataManager.importDescription')}
          </p>

          {/* Dropzone */}
          {importFiles.length === 0 && (
            <div
              onDragOver={personalImportLocked ? undefined : handleDragOver}
              onDragLeave={personalImportLocked ? undefined : handleDragLeave}
              onDrop={personalImportLocked ? undefined : handleDrop}
              onClick={() => { if (!personalImportLocked) fileInputRef.current?.click(); }}
              aria-disabled={personalImportLocked}
              className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                personalImportLocked
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
                accept=".md,.txt,.markdown,.html,.htm,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp"
                onChange={handleFileSelect}
                disabled={personalImportLocked}
                className="hidden"
              />
              <Upload
                size={32}
                className={`mx-auto mb-3 ${
                  isDragOver ? "text-indigo-500" : "text-zinc-400 dark:text-zinc-500"
                }`}
              />
              <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                {t('dataManager.dropFilesHere')}
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-600 mt-1">
                {t('dataManager.supportedFiles')}
              </p>
            </div>
          )}

          {/* 文件预览列表 */}
          {importFiles.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <button
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
                  onClick={clearImportList}
                  className="p-1 rounded text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* 目标笔记本选择
                  state.notebooks 是"侧边栏当前激活工作区"的笔记本列表。如果用户
                  在 DataManager 里选的 scope 与侧边栏激活 scope 不一致，列表中的
                  笔记本 id 不属于目标 workspace，硬塞进 import 会产生跨空间脏数据。
                  这里加一道"scope 匹配"判断：不匹配时只允许"自动创建"，并提示原因。 */}
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
                      <option value="">{t('dataManager.autoCreateNotebook')}</option>
                      {scopeMatchesGlobal && state.notebooks.map((nb) => (
                        <option key={nb.id} value={nb.id}>
                          {nb.icon} {nb.name}
                        </option>
                      ))}
                    </select>
                    {/* P1-2：zip 内 metadata.json 提供了原笔记本信息时的提示。
                        - matched：当前空间里存在同 id 的笔记本，已自动预选；
                        - missing：metadata 提到的 rootNotebookId 在当前空间不存在，
                          常见于跨实例 / 跨工作区的迁移场景。 */}
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

              {/* 按文件名建笔记本 —— 仅对散文件生效 */}
              {!hasZip && (
                <div className="mb-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/40 p-3">
                  <label
                    className={`flex items-start gap-2.5 cursor-pointer ${
                      selectedNotebookId ? "opacity-50 cursor-not-allowed" : ""
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

                  {/* 同名处理策略 —— 只有启用 perFile 时才显示 */}
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
                {importFiles.map((file, idx) => (
                  <label
                    key={idx}
                    className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                      file.selected
                        ? "bg-indigo-50/50 dark:bg-indigo-500/5"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={file.selected}
                      onChange={() => toggleFileSelection(idx)}
                      className="w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-indigo-500 focus:ring-indigo-500/30"
                    />
                    <FileText size={14} className="text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
                    <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate flex-1">
                      {file.title}
                    </span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-600 flex-shrink-0">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </label>
                ))}
              </div>

              {/* 导入进度 */}
              {importProgress && (
                <div className="mt-3 flex items-center gap-2">
                  {importProgress.phase === "error" ? (
                    <AlertCircle size={14} className="text-red-500" />
                  ) : importProgress.phase === "done" ? (
                    <CheckCircle size={14} className="text-green-500" />
                  ) : (
                    <Loader2 size={14} className="text-indigo-500 animate-spin" />
                  )}
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    {importProgress.message}
                  </span>
                </div>
              )}

              {/* 导入完成横幅
                  明确告诉用户笔记导入到了哪个空间，并在目标 ≠ 当前侧边栏空间时
                  提供一键切换入口；解决"显示成功但看不到笔记"的核心体感问题。 */}
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
                      onClick={() => setLastImportTarget(null)}
                      className="text-emerald-700/60 dark:text-emerald-300/60 hover:text-emerald-700 dark:hover:text-emerald-300 flex-shrink-0"
                      aria-label="dismiss"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}

              {/* 导入按钮 */}
              <button
                onClick={handleImport}
                disabled={isImporting || selectedCount === 0 || workspaceScopeNotReady || personalImportLocked}
                className={`mt-3 flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
                  isImporting || selectedCount === 0 || workspaceScopeNotReady || personalImportLocked
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
        </div>
      </section>

      {/* 第三方云/备忘录导入：同样受 personalImport 开关约束。
          管理员关闭开关时，不应存在"主入口禁用但 MiCloud / OPPO / iCloud / 有道
          还能用"的绕过漏洞；对普通用户 lock 时直接整体隐藏。 */}
      {!personalImportLocked && (
        <>
          {/* ===== 小米云服务导入 ===== */}
          <MiCloudImport />

          {/* ===== OPPO 云便签导入 ===== */}
          <OppoCloudImport />

          {/* ===== iPhone 备忘录导入 ===== */}
          <ICloudImport />

          {/* ===== 有道云笔记导入 ===== */}
          <YoudaoImport />
        </>
      )}
      </>
      )}

      {/* ===== 数据库文件 (.data) 导出/导入/占用统计 ===== */}
      {activeSubTab === "database" && (
      <DataFileSection />
      )}

      {/* ===== 备份与灾备（B 系列） ===== */}
      {activeSubTab === "backup" && (
      <BackupSection />
      )}

      {/* ===== 危险区域 (Danger Zone) ===== */}
      {activeSubTab === "danger" && (
      <section className="mt-8 pt-6 border-t-2 border-dashed border-red-300/50 dark:border-red-900/40">
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
                    className={`w-full px-3 py-2 border rounded-lg bg-transparent text-zinc-900 dark:text-zinc-100 outline-none font-mono text-sm transition-colors ${
                      resetError
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

  useEffect(() => {
    // 拉取当前用户角色 —— 管理员才显示导出/导入
    api.getMe()
      .then((u) => setIsAdmin((u as any)?.role === "admin"))
      .catch(() => setIsAdmin(false));
    reload();
  }, [reload]);

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
              onClick={reload}
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
              className={`flex items-center justify-center w-full py-2 px-3 rounded-lg font-medium text-sm transition-all ${
                isExporting
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {isAdmin && (
              <button
                onClick={handleScanOrphans}
                disabled={isScanningOrphans || isCleaningOrphans || isVacuuming}
                className={`flex items-center justify-center py-2 px-3 rounded-lg font-medium text-sm transition-all ${
                  isScanningOrphans || isCleaningOrphans || isVacuuming
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
              disabled={isCleaningOrphans || isVacuuming || isScanningOrphans}
              className={`flex items-center justify-center py-2 px-3 rounded-lg font-medium text-sm transition-all ${
                isCleaningOrphans || isVacuuming || isScanningOrphans
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
                disabled={isVacuuming || isCleaningOrphans || isScanningOrphans}
                className={`flex items-center justify-center py-2 px-3 rounded-lg font-medium text-sm transition-all ${
                  isVacuuming || isCleaningOrphans || isScanningOrphans
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

// ============================================================================
// 备份 / 灾备 子组件 —— 消费 /api/backups + /api/backups/status
// ----------------------------------------------------------------------------
// 设计要点：
//  1. 顶部健康徽章：根据 status 字段（degraded / sameVolume / backupDirWritable）
//     渲染 0~N 条横幅，从严重到轻量排列，便于运维一眼定位问题；
//  2. "上次成功 X 小时前" 由后端 hoursSinceLastSuccess 直接提供，避免前端时区差；
//  3. **自动备份配置区**：开/关 + 间隔 滑杆，调用 setAuto 即时生效并持久化到
//     system_settings；与 ENV 兜底配合（ENV 仅在 settings 还没值时生效）；
//  4. **恢复 UI**：每条备份带恢复按钮，点开后走两步对话框：
//        Step 1: 调 dryRun=true，把"将清空 N 行 / 插入 M 行 / K 个附件"
//                和"格式版本"展示给管理员；
//        Step 2: 输入当前密码 → withSudo → restore（dryRun=false）；
//     成功后大概率需要重启进程（DB 文件已被替换），UI 提示并刷新页面。
//  5. 所有破坏性操作（create/setAuto/remove/restore-real）都走 withSudo；
//     sudoToken 在 BackupSection 内部缓存复用，5 分钟内的连续操作只需输一次密码。
// ============================================================================
type BackupStatus = Awaited<ReturnType<typeof api.backup.status>>;
type BackupRow = Awaited<ReturnType<typeof api.backup.list>>[number];
type RestoreDryRun = NonNullable<Awaited<ReturnType<typeof api.backup.restore>>["dryRun"]>;

function BackupSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"db-only" | "full" | null>(null);
  const [createMsg, setCreateMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 「导入外部 .bak/.zip」状态独立于 create：它不生成新备份，而是把用户硬盘上
  // 的文件搬进 backupDir 再补 .meta.json。独立 importing 让按钮 loading 态
  // 不会卡住"立即备份"那两个按钮，UI 上也能并行显示。
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 当前用户角色/邮箱：
  //   - isAdmin 决定是否渲染「邮件通道（SMTP）」配置折叠区——SMTP 含凭证，非管理员看不到；
  //   - currentEmail 作为发邮件对话框的默认值，省去管理员手输，降低误发风险。
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentEmail, setCurrentEmail] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => {
        if (cancelled) return;
        setIsAdmin((u as any)?.role === "admin");
        setCurrentEmail((u as any)?.email || "");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 「发送到邮箱」目标备份与对话框状态
  const [sendEmailTarget, setSendEmailTarget] = useState<BackupRow | null>(null);

  // sudoToken 缓存：withSudo 在 SUDO_REQUIRED 时会重新询问密码，
  // 缓存让"备份 → 删除 → 改间隔" 这串连续操作只需输一次密码。
  const sudoTokenRef = useRef<string | null>(null);

  // 自动备份配置区本地状态：避免每次拖滑杆都打 status；只在 status 重载时同步。
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoIntervalHours, setAutoIntervalHours] = useState(24);
  // 调度模式：interval=按间隔小时；daily=每天 HH:mm。默认 interval（兼容旧行为）。
  const [autoMode, setAutoMode] = useState<"interval" | "daily">("interval");
  const [autoDailyAt, setAutoDailyAt] = useState("03:00");
  // 自动清理保留数量（仅 db-only），默认 15，范围 1~100。
  const [autoKeepCount, setAutoKeepCount] = useState(15);
  // 自动备份成功后是否发邮件 + 收件人。默认 false；启用时邮箱必填。
  const [autoEmailOnSuccess, setAutoEmailOnSuccess] = useState(false);
  const [autoEmailTo, setAutoEmailTo] = useState("");
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoMsg, setAutoMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 恢复对话框：选中要恢复的备份 + dryRun 预览结果
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 并行拿状态 + 列表，减少首屏等待
      const [s, list] = await Promise.all([api.backup.status(), api.backup.list()]);
      setStatus(s);
      setBackups(list);
      // 同步自动备份本地编辑值
      setAutoEnabled(s.autoBackupRunning);
      setAutoIntervalHours(s.autoBackupIntervalHours);
      // 新字段：旧后端不返回这些字段时回退默认值，避免 UI 闪烁
      setAutoMode(s.autoBackupMode === "daily" ? "daily" : "interval");
      setAutoDailyAt(s.autoBackupDailyAt || "03:00");
      setAutoKeepCount(typeof s.autoBackupKeepCount === "number" ? s.autoBackupKeepCount : 15);
      setAutoEmailOnSuccess(s.autoBackupEmailOnSuccess === true);
      setAutoEmailTo(s.autoBackupEmailTo || "");
    } catch (err: any) {
      setError(err.message || "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * 询问密码弹窗 —— 自定义 Modal（替代浏览器原生 prompt，统一深浅色与产品视觉）。
   *
   * 设计要点：
   *  - askPassword() 返回 Promise<string | null>：
   *      点确定 -> resolve(密码字符串)；点取消/关闭 -> resolve(null)。
   *      withSudo 拿到 null 会直接返回 null，调用方根据 null 判定"用户取消"。
   *  - 状态只放 setSudoAsk（包含 resolve 闭包），密码本身放 sudoPwd state。
   *      关闭时立即清空密码，避免 React state 里残留明文。
   *  - 不在这里调 requestSudoToken：BackupSection 走的是 withSudo(action, askPwd)，
   *      withSudo 内部会自己用密码换 sudoToken；保持职责单一。
   */
  const [sudoAsk, setSudoAsk] = useState<{ resolve: (v: string | null) => void } | null>(null);
  const [sudoPwd, setSudoPwd] = useState("");
  const [sudoShowPwd, setSudoShowPwd] = useState(false);

  const askPassword = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        setSudoPwd("");
        setSudoShowPwd(false);
        setSudoAsk({ resolve });
      }),
    [],
  );

  const closeSudoAsk = useCallback(
    (value: string | null) => {
      sudoAsk?.resolve(value);
      setSudoAsk(null);
      setSudoPwd("");
      setSudoShowPwd(false);
    },
    [sudoAsk],
  );

  const handleCreate = async (type: "db-only" | "full") => {
    setCreating(type);
    setCreateMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.backup.create(type, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        // 用户取消密码框
        setCreating(null);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      setCreateMsg({
        type: "ok",
        text: t("dataManager.backup.createSuccess", {
          filename: out.result.filename,
          size: fmtBytes(out.result.size),
        }),
      });
      reload();
    } catch (err: any) {
      setCreateMsg({
        type: "err",
        text: t("dataManager.backup.createFailed", { error: err.message || "error" }),
      });
    } finally {
      setCreating(null);
    }
  };

  /**
   * 导入外部 .bak / .zip 备份到当前实例的备份仓库。
   *
   * 行为取舍：
   *   - 上传成功后 **不自动进入恢复流程**，只是刷新列表让新备份显现 —— 恢复仍
   *     要管理员自己在列表里点，走 dryRun 预览 + sudo 二次确认。理由是邮件
   *     投递 / 跨机拷贝拿到的备份，管理员 80% 的情况下想先看"这份到底有多少
   *     笔记 / 附件"再下决定，而不是一键覆盖当前库。
   *   - 成功后把 input.value 清空，允许同一个文件重复选择（浏览器默认会静默
   *     吞掉相同文件名的第二次 change）。
   *   - 错误信息直接透传后端 error 字段，便于管理员看到"文件头校验失败 / 格式
   *     版本过高"这类具体原因。
   */
  const handleImport = async (file: File) => {
    setImporting(true);
    setImportMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.backup.upload(file, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        // 用户取消密码框
        setImporting(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      setImportMsg({
        type: "ok",
        text: t("dataManager.backup.importSuccess", {
          filename: out.result.filename,
          size: fmtBytes(out.result.size),
        }),
      });
      reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setImportMsg({
        type: "err",
        text: t("dataManager.backup.importFailed", { error: msg }),
      });
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (filename: string) => {
    // 删除虽然不影响业务运行，但同样要 sudo（后端强制）；UI 仍弹 confirm 防误点
    const ok = await confirmDialog({
      title: t("dataManager.backup.deleteConfirm"),
      confirmText: t("common.delete", "删除"),
      danger: true,
    });
    if (!ok) return;
    try {
      const out = await withSudo(
        (tk) => api.backup.remove(filename, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) return;
      sudoTokenRef.current = out.sudoToken;
      reload();
    } catch (err: any) {
      setError(err.message || "delete failed");
    }
  };

  /** 保存自动备份配置 —— 走 sudo */
  const handleSaveAuto = async () => {
    // 启用邮件通知前的本地校验：避免点保存才被后端 400 顶回
    if (autoEnabled && autoEmailOnSuccess) {
      const okMail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(autoEmailTo.trim());
      if (!okMail) {
        setAutoMsg({ type: "err", text: t("dataManager.backup.autoEmailInvalid") });
        return;
      }
    }
    setAutoSaving(true);
    setAutoMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.backup.setAuto(autoEnabled, autoIntervalHours, tk, {
          mode: autoMode,
          dailyAt: autoDailyAt,
          keepCount: autoKeepCount,
          emailOnSuccess: autoEmailOnSuccess,
          emailTo: autoEmailTo.trim(),
        }),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setAutoSaving(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      setAutoMsg({ type: "ok", text: out.result.message });
      // 重新拉一次 status，确保 autoBackupRunning 等字段是后端最新值
      reload();
    } catch (err: any) {
      setAutoMsg({
        type: "err",
        text: t("dataManager.backup.saveAutoFailed", { error: err.message || "error" }),
      });
    } finally {
      setAutoSaving(false);
    }
  };

  /** 把"距上次成功小时数"渲染成更友好的中文/英文相对时间 */
  const formatSince = (hours: number | null): string => {
    if (hours === null) return t("dataManager.backup.neverSuccess");
    if (hours < 1) {
      const m = Math.max(1, Math.round(hours * 60));
      return t("dataManager.backup.minutesAgo", { minutes: m });
    }
    return t("dataManager.backup.hoursAgo", { hours: hours.toFixed(1) });
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Save size={18} className="text-emerald-500" />
        <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {t("dataManager.backup.title")}
        </h4>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 space-y-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("dataManager.backup.description")}
        </p>

        {/* ===== 健康告警区（按严重度从高到低） ===== */}
        {status && (
          <div className="space-y-2">
            {/* 红：备份目录不可写 —— 根本写不进去 */}
            {!status.backupDirWritable && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40">
                <ShieldAlert size={16} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-semibold text-red-700 dark:text-red-400">
                    {t("dataManager.backup.notWritableTitle")}
                  </div>
                  <div className="text-red-600 dark:text-red-300 mt-0.5">
                    {t("dataManager.backup.notWritableDesc", { dir: status.backupDir })}
                  </div>
                </div>
              </div>
            )}

            {/* 红：链路降级（连续失败/长时间未成功） */}
            {status.degraded && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40">
                <AlertTriangle size={16} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs flex-1 min-w-0">
                  <div className="font-semibold text-red-700 dark:text-red-400">
                    {t("dataManager.backup.degradedTitle")}
                  </div>
                  <div className="text-red-600 dark:text-red-300 mt-0.5">
                    {t("dataManager.backup.degradedDesc")}
                  </div>
                  {status.consecutiveFailures > 0 && (
                    <div className="text-red-600 dark:text-red-300 mt-1">
                      {t("dataManager.backup.consecutiveFailures", { n: status.consecutiveFailures })}
                      {status.lastFailureReason && (
                        <span className="block font-mono text-[11px] mt-0.5 opacity-80 break-all">
                          {status.lastFailureReason}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 黄：同物理卷 —— 不挡正常运行，只是容灾削弱 */}
            {status.sameVolume && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-700/40">
                <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-semibold text-amber-700 dark:text-amber-400">
                    {t("dataManager.backup.sameVolumeTitle")}
                  </div>
                  <div className="text-amber-600 dark:text-amber-300 mt-0.5">
                    {t("dataManager.backup.sameVolumeDesc")}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== 状态指标小卡 ===== */}
        {status && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-2">
              <div className="text-zinc-500 mb-0.5 flex items-center gap-1">
                <Clock size={11} /> {t("dataManager.backup.lastSuccess")}
              </div>
              <div
                className={`font-semibold ${
                  status.hoursSinceLastSuccess !== null && status.hoursSinceLastSuccess > status.autoBackupIntervalHours * 2
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-zinc-800 dark:text-zinc-200"
                }`}
              >
                {formatSince(status.hoursSinceLastSuccess)}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-2">
              <div className="text-zinc-500 mb-0.5 flex items-center gap-1">
                <RefreshCw size={11} />
                {status.autoBackupRunning
                  ? t("dataManager.backup.autoOn", { hours: status.autoBackupIntervalHours })
                  : t("dataManager.backup.autoOff")}
              </div>
              <div className={`font-semibold ${status.autoBackupRunning ? "text-emerald-600" : "text-zinc-400"}`}>
                {status.autoBackupRunning ? "●" : "○"}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-2">
              <div className="text-zinc-500 mb-0.5 flex items-center gap-1">
                <HardDrive size={11} /> {t("dataManager.backup.freeSpace")}
              </div>
              <div className="font-semibold text-zinc-800 dark:text-zinc-200">
                {fmtBytes(status.backupDirFreeBytes ?? 0)}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-2">
              <div className="text-zinc-500 mb-0.5 flex items-center gap-1">
                <Server size={11} /> {t("dataManager.backup.backupDir")}
              </div>
              <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 truncate" title={status.backupDir}>
                {status.backupDir}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-500 flex items-center gap-1">
            <AlertCircle size={12} /> {error}
          </div>
        )}

        {/* ===== 备份目录配置区 ===== */}
        {/*
          为什么单独抽：sameVolume 警告/不可写错误已经在顶部横幅出现，
          管理员看完应该有一个 "立刻能动手切换" 的入口，而不是去改 docker-compose
          重启容器（那对生产环境而言是几分钟的不可用窗口）。

          流程：
            1. 输入候选路径 → 点 "校验" → 调 setDir(dryRun=true) →
               显示 ok/reason/sameVolume/freeBytes；
            2. 校验通过且管理员确认 → 点 "切换" → withSudo + setDir(dryRun=false)；
               切换成功后旧目录文件不会迁移，前端 i18n 文案明确告知。
        */}
        <BackupDirSection
          currentBackupDir={status?.backupDir ?? ""}
          currentDataDir={status?.dataDir ?? ""}
          currentSameVolume={status?.sameVolume ?? false}
          askPassword={askPassword}
          sudoTokenRef={sudoTokenRef}
          onSwitched={() => {
            // 切换成功后重新拉 status —— sameVolume 横幅、可用空间、目录都会更新
            reload();
          }}
        />

        {/* ===== 自动备份配置区 ===== */}
        {/*
          字段持久化由后端 BackupManager 写到 system_settings.backup:auto；
          重启后由 readEffectiveAutoConfig 读出。这里 UI 只负责暴露开关 + 间隔，
          点 "保存" 才真正下发；改完不点保存离开页面则不生效（避免拖滑杆误触发）。
        */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
              <RefreshCw size={14} className="text-emerald-500" />
              {t("dataManager.backup.autoConfigTitle")}
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoEnabled}
                onChange={(e) => setAutoEnabled(e.target.checked)}
                className="w-4 h-4 accent-emerald-600"
              />
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                {autoEnabled ? t("dataManager.backup.autoEnabledLabel") : t("dataManager.backup.autoDisabledLabel")}
              </span>
            </label>
          </div>

          <div className={autoEnabled ? "space-y-3" : "opacity-50 pointer-events-none space-y-3"}>
            {/* 调度模式切换：interval（每 N 小时） / daily（每天 HH:mm）。
                旧版本只有 interval，daily 是新增——能精确落在低峰时段，
                避免重启服务后调度被踢出固定节奏。 */}
            <div className="flex items-center gap-3 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="whitespace-nowrap">{t("dataManager.backup.scheduleModeLabel")}</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="auto-backup-mode"
                  value="interval"
                  checked={autoMode === "interval"}
                  onChange={() => setAutoMode("interval")}
                  className="accent-emerald-600"
                  disabled={!autoEnabled}
                />
                <span>{t("dataManager.backup.scheduleModeInterval")}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="auto-backup-mode"
                  value="daily"
                  checked={autoMode === "daily"}
                  onChange={() => setAutoMode("daily")}
                  className="accent-emerald-600"
                  disabled={!autoEnabled}
                />
                <span>{t("dataManager.backup.scheduleModeDaily")}</span>
              </label>
            </div>

            {/* interval 模式：滑块 + 数字 */}
            {autoMode === "interval" && (
              <div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                    {t("dataManager.backup.intervalLabel")}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={168}
                    step={1}
                    value={Math.min(autoIntervalHours, 168)}
                    onChange={(e) => setAutoIntervalHours(Number(e.target.value))}
                    className="flex-1 accent-emerald-600"
                    disabled={!autoEnabled}
                  />
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={autoIntervalHours}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setAutoIntervalHours(Math.max(1, Math.min(720, Math.round(n))));
                    }}
                    className="w-16 px-2 py-1 text-xs text-right rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                    disabled={!autoEnabled}
                  />
                  <span className="text-xs text-zinc-500 whitespace-nowrap">
                    {t("dataManager.backup.intervalUnit")}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  {t("dataManager.backup.intervalHint")}
                </div>
              </div>
            )}

            {/* daily 模式：HH:mm 时间选择器（服务器本地时区） */}
            {autoMode === "daily" && (
              <div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                    {t("dataManager.backup.dailyAtLabel")}
                  </label>
                  <input
                    type="time"
                    value={autoDailyAt}
                    onChange={(e) => setAutoDailyAt(e.target.value || "03:00")}
                    className="px-2 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                    disabled={!autoEnabled}
                  />
                  <span className="text-xs text-zinc-500">
                    {t("dataManager.backup.dailyAtTzNote")}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  {t("dataManager.backup.dailyAtHint")}
                </div>
              </div>
            )}

            {/* 保留数量：从写死 10 → 可配置，默认 15。手动+自动两条路径都会触发清理 */}
            <div className="flex items-center gap-3">
              <label className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                {t("dataManager.backup.keepCountLabel")}
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={autoKeepCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setAutoKeepCount(Math.max(1, Math.min(100, Math.round(n))));
                }}
                className="w-20 px-2 py-1 text-xs text-right rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                disabled={!autoEnabled}
              />
              <span className="text-[11px] text-zinc-400">
                {t("dataManager.backup.keepCountHint")}
              </span>
            </div>

            {/* 自动发邮件：勾选后必须填合法邮箱；后端在 SMTP 未启用时会静默 skip */}
            <div className="border-t border-zinc-200 dark:border-zinc-700 pt-3 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoEmailOnSuccess}
                  onChange={(e) => setAutoEmailOnSuccess(e.target.checked)}
                  className="w-4 h-4 accent-emerald-600"
                  disabled={!autoEnabled}
                />
                <span className="text-xs text-zinc-700 dark:text-zinc-300">
                  {t("dataManager.backup.autoEmailLabel")}
                </span>
              </label>
              {autoEmailOnSuccess && (
                <div className="flex items-center gap-2 pl-6">
                  <input
                    type="email"
                    value={autoEmailTo}
                    onChange={(e) => setAutoEmailTo(e.target.value)}
                    placeholder={t("dataManager.backup.autoEmailPlaceholder")}
                    className="flex-1 px-2 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                    disabled={!autoEnabled}
                  />
                </div>
              )}
              <div className="text-[11px] text-zinc-400 pl-6">
                {t("dataManager.backup.autoEmailHint")}
              </div>
            </div>
          </div>

          {autoMsg && (
            <div className={`text-xs flex items-start gap-1 ${autoMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
              {autoMsg.type === "ok" ? <CheckCircle size={12} className="mt-0.5" /> : <AlertCircle size={12} className="mt-0.5" />}
              <span>{autoMsg.text}</span>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={handleSaveAuto}
              disabled={
                autoSaving ||
                // 没变化就禁用，避免无意义 sudo 弹框：所有可编辑字段都要纳入比对
                (status !== null &&
                  status.autoBackupRunning === autoEnabled &&
                  status.autoBackupIntervalHours === autoIntervalHours &&
                  (status.autoBackupMode ?? "interval") === autoMode &&
                  (status.autoBackupDailyAt ?? "03:00") === autoDailyAt &&
                  (status.autoBackupKeepCount ?? 15) === autoKeepCount &&
                  (status.autoBackupEmailOnSuccess ?? false) === autoEmailOnSuccess &&
                  (status.autoBackupEmailTo ?? "") === autoEmailTo.trim())
              }
              className={`flex items-center justify-center py-1.5 px-3 rounded-lg text-xs font-medium transition-all ${
                autoSaving
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                  : "bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
              }`}
            >
              {autoSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  {t("dataManager.backup.savingAuto")}
                </>
              ) : (
                t("dataManager.backup.saveAuto")
              )}
            </button>
          </div>
        </div>

        {createMsg && (
          <div className={`text-xs flex items-start gap-1 ${createMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
            {createMsg.type === "ok" ? <CheckCircle size={12} className="mt-0.5" /> : <AlertCircle size={12} className="mt-0.5" />}
            <span>{createMsg.text}</span>
          </div>
        )}

        {importMsg && (
          <div className={`text-xs flex items-start gap-1 ${importMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
            {importMsg.type === "ok" ? <CheckCircle size={12} className="mt-0.5" /> : <AlertCircle size={12} className="mt-0.5" />}
            <span>{importMsg.text}</span>
          </div>
        )}

        {/* ===== 立即备份按钮 =====
            布局取舍：
              - 之前用 grid-cols-3 等宽，导致中文最长的"立即备份（仅数据库）"被强制换行，
                整行按钮变成两倍高、视觉破败。
              - 改成 flex-wrap：每个按钮按内容自适应宽度（min-w-0 + flex-1 让它们尽量分摊宽度），
                文字加 whitespace-nowrap 严禁换行；窄屏（<sm）回退为竖排堆叠。
              - 统一固定按钮高度 h-9，避免 loading/正常态切换时高度跳动。 */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <button
            onClick={() => handleCreate("db-only")}
            disabled={creating !== null}
            className={`flex-1 min-w-0 sm:min-w-[10rem] h-9 flex items-center justify-center px-3 rounded-lg font-medium text-sm whitespace-nowrap transition-all ${
              creating !== null
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
            }`}
          >
            {creating === "db-only" ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin flex-shrink-0" />
                <span className="truncate">{t("dataManager.backup.creating")}</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-1.5 flex-shrink-0" />
                <span className="truncate">{t("dataManager.backup.createDb")}</span>
              </>
            )}
          </button>
          <button
            onClick={() => handleCreate("full")}
            disabled={creating !== null}
            className={`flex-1 min-w-0 sm:min-w-[8rem] h-9 flex items-center justify-center px-3 rounded-lg font-medium text-sm whitespace-nowrap transition-all ${
              creating !== null
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
            }`}
          >
            {creating === "full" ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin flex-shrink-0" />
                <span className="truncate">{t("dataManager.backup.creating")}</span>
              </>
            ) : (
              <>
                <FolderDown className="w-4 h-4 mr-1.5 flex-shrink-0" />
                <span className="truncate">{t("dataManager.backup.createFull")}</span>
              </>
            )}
          </button>
          <button
            onClick={reload}
            disabled={loading}
            className="sm:flex-none sm:w-auto h-9 flex items-center justify-center px-4 rounded-lg font-medium text-sm whitespace-nowrap border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            <RefreshCw size={14} className={`mr-1.5 flex-shrink-0 ${loading ? "animate-spin" : ""}`} />
            {t("dataManager.backup.refresh")}
          </button>
        </div>

        {/* ===== 导入外部 .bak / .zip ===== 
            —————————————————————————————————————————————————————————————————
            场景：邮件投递回来的附件 / U盘异机拷贝 / 运维从别的实例搬过来。
            
            行为：仅上传 + 补 meta.json 入备份列表；不直接覆盖现网数据。用户上传
            成功后，备份列表里会出现一条 `*-imported-*.bak|zip`，再由用户点击
            旁边的「恢复」按钮走 dryRun 预览 + sudo 确认的常规路径。
            
            刻意与上面的"立即备份"放在同一区块下方而非放进顶部，是因为"导入"是
            低频操作——默认视觉权重低于"就地创建备份"，避免首次看到的人被多个
            并列按钮弄乱。 */}
        <div className="flex items-center gap-2 pt-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".bak,.zip,application/octet-stream,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              // 清空 input，允许用户连续选同一个文件（默认浏览器会静默吞第二次 change）
              e.target.value = "";
              if (f) void handleImport(f);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing || creating !== null}
            className={`h-9 flex items-center justify-center px-3 rounded-lg font-medium text-sm whitespace-nowrap border transition-all ${
              importing || creating !== null
                ? "border-zinc-200 dark:border-zinc-700 text-zinc-400 cursor-not-allowed"
                : "border-sky-300 dark:border-sky-600 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10"
            }`}
          >
            {importing ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin flex-shrink-0" />
                <span className="truncate">{t("dataManager.backup.importing")}</span>
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-1.5 flex-shrink-0" />
                <span className="truncate">{t("dataManager.backup.importBackup")}</span>
              </>
            )}
          </button>
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t("dataManager.backup.importHint")}
          </span>
        </div>

        {/* ===== 备份列表 ===== */}
        <div>
          {backups.length === 0 ? (
            <div className="text-center text-xs text-zinc-400 py-6">
              {t("dataManager.backup.noBackups")}
            </div>
          ) : (
            // 列表外层加 max-h + overflow-y-auto：当备份数量增长（保留可达 100）时
            // 不会无限撑长把"邮件通道(SMTP)"折叠卡顶到屏幕外，改成内部滚动。
            // 高度 ~7 行（每行 ≈56px）≈ 400px，与 SettingsModal 体感一致。
            <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg divide-y divide-zinc-200 dark:divide-zinc-700 max-h-[400px] overflow-y-auto">
              {backups.map((b) => (
                <div key={b.filename} className="flex items-center gap-3 px-3 py-2 bg-white dark:bg-zinc-900/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono text-zinc-800 dark:text-zinc-200 truncate" title={b.filename}>
                      {b.filename}
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span>{b.type}</span>
                      <span>{fmtBytes(b.size)}</span>
                      <span>{new Date(b.createdAt).toLocaleString()}</span>
                      <span>{b.noteCount} notes · {b.notebookCount} notebooks</span>
                      <span className="opacity-70">schema v{b.schemaVersion}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setRestoreTarget(b)}
                    className="p-1.5 rounded hover:bg-amber-50 dark:hover:bg-amber-500/10 text-zinc-400 hover:text-amber-600"
                    title={t("dataManager.backup.restoreTooltip")}
                  >
                    <Upload size={14} />
                  </button>
                  <button
                    onClick={() => setSendEmailTarget(b)}
                    className="p-1.5 rounded hover:bg-sky-50 dark:hover:bg-sky-500/10 text-zinc-400 hover:text-sky-600"
                    title={t("dataManager.backup.sendEmailTooltip")}
                  >
                    <Mail size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(b.filename)}
                    className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-500/10 text-zinc-400 hover:text-red-500"
                    title={t("dataManager.backup.delete")}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ===== 邮件通道（SMTP）配置区：仅管理员 =====
          放在「备份」分栏内而不是独立 Tab，是因为它的唯一用途就是配合
          「发送到邮箱」使用——内聚在一起可减少管理员跨页面跳转。
          折叠默认关闭，保持备份页首屏干净。 */}
      {isAdmin && (
        <SmtpConfigSection
          askPassword={askPassword}
          sudoTokenRef={sudoTokenRef}
        />
      )}

      {/* ===== 发送到邮箱 对话框 ===== */}
      {sendEmailTarget && (
        <BackupSendEmailDialog
          target={sendEmailTarget}
          defaultTo={currentEmail}
          onClose={() => setSendEmailTarget(null)}
          askPassword={askPassword}
          sudoTokenRef={sudoTokenRef}
          onSent={reload}
        />
      )}

      {/* ===== 恢复对话框（高危） ===== */}
      {restoreTarget && (
        <BackupRestoreDialog
          target={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onSuccess={() => {
            setRestoreTarget(null);
            // 重启后刷新页面让用户登录新会话；先 reload 状态以便看到 lastSuccessAt 等
            reload();
          }}
          askPassword={askPassword}
          sudoTokenRef={sudoTokenRef}
        />
      )}

      {/* ===== 自定义 sudo 密码确认 Modal =====
          替代原生 window.prompt：
            - 视觉与产品深浅色统一，移除浏览器顶部"localhost:5173 显示"的尴尬抬头；
            - 密码框默认隐藏可一键切换显隐；
            - 支持 Esc 关闭、回车提交，遮罩点击取消；
            - 关闭时务必 resolve(null)，避免 withSudo 永远挂起。 */}
      <AnimatePresence>
        {sudoAsk && (
          <motion.div
            key="sudo-ask"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          >
            {/* 半透明遮罩 */}
            <div
              className="absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
              onClick={() => closeSudoAsk(null)}
            />
            <motion.form
              initial={{ scale: 0.95, y: 10, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 10, opacity: 0 }}
              transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (!sudoPwd) return;
                closeSudoAsk(sudoPwd);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSudoAsk(null);
                }
              }}
              className="relative w-full max-w-md bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
            >
              {/* 标题栏 */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
                <h4 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  <Lock className="w-3.5 h-3.5 text-amber-500" />
                  {t("dataManager.backup.sudoTitle") || "身份验证"}
                </h4>
                <button
                  type="button"
                  onClick={() => closeSudoAsk(null)}
                  className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  aria-label="close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* 内容 */}
              <div className="p-5 space-y-3">
                {/* 提示横幅：复用现有 sudoPrompt 文案，带 amber 警示色 */}
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50/70 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-700/40 text-amber-700 dark:text-amber-300 text-xs leading-relaxed">
                  <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    {t("dataManager.backup.sudoPrompt") ||
                      "请输入当前密码以确认本次备份/恢复操作（5 分钟内连续操作只需输一次）"}
                  </span>
                </div>

                {/* 密码输入：左侧 lock 图标 + 右侧显隐切换按钮 */}
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {t("dataManager.backup.sudoPasswordLabel") || "当前密码"}
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Lock className="w-3.5 h-3.5 text-zinc-400" />
                  </div>
                  <input
                    type={sudoShowPwd ? "text" : "password"}
                    value={sudoPwd}
                    onChange={(e) => setSudoPwd(e.target.value)}
                    placeholder={t("dataManager.backup.sudoPasswordPlaceholder") || "输入登录密码"}
                    autoFocus
                    autoComplete="current-password"
                    className="block w-full pl-9 pr-10 py-2.5 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setSudoShowPwd((v) => !v)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                    tabIndex={-1}
                    aria-label={sudoShowPwd ? "hide password" : "show password"}
                  >
                    {sudoShowPwd ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => closeSudoAsk(null)}
                    className="px-3.5 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
                  >
                    {t("common.cancel") || "取消"}
                  </button>
                  <button
                    type="submit"
                    disabled={!sudoPwd}
                    className="px-3.5 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    {t("common.confirm") || "确定"}
                  </button>
                </div>
              </div>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

// ============================================================================
// 备份恢复对话框 —— 两步走：dryRun 预览 → sudo 验证 → 真正恢复
// ----------------------------------------------------------------------------
// 为什么单独抽组件：
//  1. 状态机较复杂（dryRun loading / 已预览 / 正在恢复 / 已恢复），塞在
//     BackupSection 里会让父组件 useState 数量翻倍；
//  2. 弹窗内部的多步骤交互可以独立卸载，关掉对话框就丢光中间态，避免泄漏；
//  3. 后续若要把恢复入口从备份页移到通知中心、或独立出"灾难恢复向导"，
//     抽出来更易复用。
//
// **极强警告语**：恢复=覆盖整库，包括其他用户的数据；后端会在覆盖前先做安全
// 备份（见 BackupManager.restoreFromDbOnly / restoreFromZip），即使误恢复也
// 可以从 .pre-restore.bak 二次回滚，但 UI 仍要把这一行影响范围讲明白。
// ============================================================================
function BackupRestoreDialog(props: {
  target: BackupRow;
  onClose: () => void;
  onSuccess: () => void;
  askPassword: () => string | null | Promise<string | null>;
  sudoTokenRef: React.MutableRefObject<string | null>;
}) {
  const { target, onClose, onSuccess, askPassword, sudoTokenRef } = props;
  const { t } = useTranslation();
  const [stage, setStage] = useState<"loading" | "preview" | "restoring" | "done" | "error">("loading");
  const [dryRun, setDryRun] = useState<RestoreDryRun | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  // confirmText：必须输入备份文件名作为最终确认（与 factoryReset 相同的安全模式）
  const [confirmText, setConfirmText] = useState("");

  // 进入对话框立刻调 dryRun 拿预览
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.backup.restore(target.filename, true);
        if (cancelled) return;
        if (!res.success || !res.dryRun) {
          setErrorMsg(res.error || "preview failed");
          setStage("error");
          return;
        }
        setDryRun(res.dryRun);
        setStage("preview");
      } catch (err: any) {
        if (cancelled) return;
        setErrorMsg(err.message || "preview failed");
        setStage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.filename]);

  const handleConfirm = async () => {
    if (confirmText !== target.filename) return;
    setStage("restoring");
    setErrorMsg("");
    try {
      const out = await withSudo(
        (tk) => api.backup.restore(target.filename, false, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        // 用户在密码框点了取消
        setStage("preview");
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      if (!out.result.success) {
        setErrorMsg(out.result.error || "restore failed");
        setStage("error");
        return;
      }
      setStage("done");
      // 给用户 2.5 秒看到"恢复成功，请重启"提示后再回到列表
      setTimeout(() => onSuccess(), 2500);
    } catch (err: any) {
      setErrorMsg(err.message || "restore failed");
      setStage("error");
    }
  };

  // 计算总影响行数（dryRun 时用）
  const totalClear = dryRun?.tables.reduce((s, t2) => s + t2.willClear, 0) ?? 0;
  const totalInsert = dryRun?.tables.reduce((s, t2) => s + t2.willInsert, 0) ?? 0;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
      >
        {/* 标题区 */}
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
          <ShieldAlert size={18} className="text-amber-500" />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {t("dataManager.backup.restoreTitle")}
          </h3>
          <span className="ml-auto text-[11px] font-mono text-zinc-500 truncate max-w-[260px]" title={target.filename}>
            {target.filename}
          </span>
        </div>

        {/* 高危横幅 */}
        <div className="px-5 py-3 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-700/40 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">{t("dataManager.backup.restoreDangerTitle")}</div>
            <div className="mt-0.5">{t("dataManager.backup.restoreDangerDesc")}</div>
          </div>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {stage === "loading" && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 size={14} className="animate-spin" />
              {t("dataManager.backup.restoreLoadingPreview")}
            </div>
          )}

          {(stage === "preview" || stage === "restoring") && dryRun && (
            <>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                  <div className="text-zinc-500 mb-0.5">{t("dataManager.backup.willClear")}</div>
                  <div className="font-semibold text-red-600 dark:text-red-400">{totalClear.toLocaleString()}</div>
                </div>
                <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                  <div className="text-zinc-500 mb-0.5">{t("dataManager.backup.willInsert")}</div>
                  <div className="font-semibold text-emerald-600 dark:text-emerald-400">{totalInsert.toLocaleString()}</div>
                </div>
                <div className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                  <div className="text-zinc-500 mb-0.5">{t("dataManager.backup.schemaVersion")}</div>
                  <div className="font-semibold text-zinc-700 dark:text-zinc-300">v{dryRun.schemaVersion}</div>
                </div>
              </div>

              <div className="text-xs text-zinc-500 mt-1">
                {t("dataManager.backup.fileBundle", {
                  attachments: dryRun.files.attachments,
                  fonts: dryRun.files.fonts,
                  plugins: dryRun.files.plugins,
                })}
              </div>

              {/* 表级明细：只显示净变化 != 0 的，避免一屏几十张表全 0 */}
              <div className="border border-zinc-200 dark:border-zinc-700 rounded overflow-hidden">
                <div className="text-[11px] font-semibold text-zinc-500 px-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/50 grid grid-cols-[1fr_auto_auto] gap-3">
                  <span>{t("dataManager.backup.tableName")}</span>
                  <span className="text-right w-20">{t("dataManager.backup.colClear")}</span>
                  <span className="text-right w-20">{t("dataManager.backup.colInsert")}</span>
                </div>
                <div className="max-h-48 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
                  {dryRun.tables
                    .filter((tb) => tb.willClear || tb.willInsert)
                    .map((tb) => (
                      <div
                        key={tb.name}
                        className="text-[11px] px-3 py-1 grid grid-cols-[1fr_auto_auto] gap-3 font-mono text-zinc-700 dark:text-zinc-300"
                      >
                        <span className="truncate" title={tb.name}>{tb.name}</span>
                        <span className="text-right w-20 text-red-500">{tb.willClear || ""}</span>
                        <span className="text-right w-20 text-emerald-600">{tb.willInsert || ""}</span>
                      </div>
                    ))}
                </div>
              </div>

              {/* 最终输入文件名确认 */}
              <div className="pt-2">
                <label className="text-xs text-zinc-600 dark:text-zinc-400 block mb-1">
                  {t("dataManager.backup.confirmFilenamePrompt")}
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  disabled={stage === "restoring"}
                  placeholder={target.filename}
                  className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>
            </>
          )}

          {stage === "done" && (
            <div className="flex flex-col items-center justify-center py-6 gap-2 text-center">
              <CheckCircle size={32} className="text-emerald-500" />
              <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                {t("dataManager.backup.restoreDoneTitle")}
              </div>
              <div className="text-xs text-zinc-500">
                {t("dataManager.backup.restoreDoneDesc")}
              </div>
            </div>
          )}

          {stage === "error" && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">{t("dataManager.backup.restoreFailed")}</div>
                <div className="text-xs mt-0.5 break-all">{errorMsg}</div>
              </div>
            </div>
          )}
        </div>

        {/* 底栏 */}
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          {stage !== "done" && (
            <button
              onClick={onClose}
              disabled={stage === "restoring"}
              className="px-3 py-1.5 text-xs rounded border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              {t("dataManager.backup.cancel")}
            </button>
          )}
          {stage === "preview" && (
            <button
              onClick={handleConfirm}
              disabled={confirmText !== target.filename}
              className={`px-3 py-1.5 text-xs rounded font-semibold flex items-center gap-1.5 ${
                confirmText === target.filename
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-zinc-200 dark:bg-zinc-700 text-zinc-400 cursor-not-allowed"
              }`}
            >
              <ShieldAlert size={12} />
              {t("dataManager.backup.confirmRestore")}
            </button>
          )}
          {stage === "restoring" && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Loader2 size={12} className="animate-spin" />
              {t("dataManager.backup.restoring")}
            </div>
          )}
          {stage === "error" && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded bg-zinc-600 hover:bg-zinc-700 text-white"
            >
              {t("dataManager.backup.close")}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================================
// 备份目录配置区 —— 让管理员在 UI 直接切换 backupDir，不必改 docker-compose
// ----------------------------------------------------------------------------
// 设计要点：
//  1. 双行布局：上面显示 "当前备份目录 / 数据目录"，下面是 "新路径输入 + 校验/切换"。
//     不把切换塞进同一个目录展示卡里，是因为切换是低频高风险操作，需要明显视觉
//     分割（折叠面板/独立卡片二选一，这里选了独立卡片避免多一次点击）。
//  2. 校验是 dryRun 调用，无需 sudo —— 用户改路径时可能多次试探，反复弹密码框
//     体验极差；真正切换才走 sudo。
//  3. 切换不迁移历史备份文件：在按钮 hint 和成功提示里都讲清楚，让管理员知道
//     需要时手动 docker exec cp（避免 GUI 触发几十 GB IO 风暴）。
//  4. 同卷警告以橙色而非红色显示——后端不会因 sameVolume=true 拒绝切换
//     （比如管理员就是要换到同卷的另一个目录），但要让用户清楚这一点没解决核心问题。
// ============================================================================
function BackupDirSection(props: {
  currentBackupDir: string;
  currentDataDir: string;
  currentSameVolume: boolean;
  askPassword: () => string | null | Promise<string | null>;
  sudoTokenRef: React.MutableRefObject<string | null>;
  onSwitched: () => void;
}) {
  const { currentBackupDir, currentDataDir, currentSameVolume, askPassword, sudoTokenRef, onSwitched } = props;
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  // checkResult：dryRun 校验的最近一次结果。null 表示用户还没校验过。
  const [checkResult, setCheckResult] = useState<{
    ok: boolean;
    resolved: string;
    sameVolume?: boolean;
    freeBytes?: number | null;
    reason?: string;
    message?: string;
  } | null>(null);
  const [opMsg, setOpMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 输入变化时把上次校验结果清空 —— 否则用户改了路径却看到旧的"通过"会误以为新路径也 OK
  useEffect(() => {
    setCheckResult(null);
    setOpMsg(null);
  }, [input]);

  const handleCheck = async () => {
    if (!input.trim()) return;
    setChecking(true);
    setCheckResult(null);
    setOpMsg(null);
    try {
      const res = await api.backup.setDir(input.trim(), true);
      setCheckResult(res);
    } catch (err: any) {
      // 后端 400 时也走 catch（request() 会把 4xx 抛错）。
      // 把 message 透出给用户，便于看到 "目录不可写" 等具体原因。
      setCheckResult({
        ok: false,
        resolved: input.trim(),
        message: err?.message || "check failed",
      });
    } finally {
      setChecking(false);
    }
  };

  const handleSwitch = async () => {
    if (!checkResult?.ok) return;
    // 二次 confirm —— 这是会影响所有未来备份位置的全局操作
    const ok = await confirmDialog({
      title: t("dataManager.backup.dirSwitchConfirm", { path: checkResult.resolved }),
      danger: true,
    });
    if (!ok) {
      return;
    }
    setSwitching(true);
    setOpMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.backup.setDir(input.trim(), false, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setSwitching(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      if (!out.result.ok) {
        setOpMsg({ type: "err", text: out.result.message || "switch failed" });
        setSwitching(false);
        return;
      }
      setOpMsg({ type: "ok", text: t("dataManager.backup.dirSwitchSuccess", { path: out.result.resolved }) });
      setInput("");
      setCheckResult(null);
      onSwitched();
    } catch (err: any) {
      setOpMsg({ type: "err", text: err?.message || "switch failed" });
    } finally {
      setSwitching(false);
    }
  };

  // 是否处于"已校验通过、可以切换"的活跃状态——用于决定是否展开切换面板
  const canSwitch = checkResult?.ok === true;

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 p-4 space-y-4">
      {/* —— 标题 —— */}
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
        <HardDrive size={14} className="text-emerald-500" />
        {t("dataManager.backup.dirConfigTitle")}
      </div>

      {/* —— 当前生效值（双栏） —— */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-800/40 px-3 py-2">
          <div className="text-[11px] text-zinc-500 mb-1">{t("dataManager.backup.currentBackupDir")}</div>
          <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 truncate" title={currentBackupDir}>
            {currentBackupDir || "—"}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-800/40 px-3 py-2">
          <div className="text-[11px] text-zinc-500 mb-1">{t("dataManager.backup.currentDataDir")}</div>
          <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 truncate" title={currentDataDir}>
            {currentDataDir || "—"}
          </div>
        </div>
      </div>

      {/* —— 同卷警告 —— */}
      {currentSameVolume && (
        <div className="flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-700/40 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          <span>{t("dataManager.backup.dirSameVolumeHint")}</span>
        </div>
      )}

      {/* —— 输入 + 校验 —— */}
      <div className="space-y-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
        <label className="text-xs text-zinc-600 dark:text-zinc-400 block">
          {t("dataManager.backup.dirInputLabel")}
        </label>
        {/* 用 group 让 input 与 校验按钮 视觉融合（同高、共享圆角、加 focus 整体高亮） */}
        <div className="flex items-stretch h-9 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 focus-within:ring-2 focus-within:ring-emerald-500 focus-within:border-transparent overflow-hidden">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("dataManager.backup.dirInputPlaceholder") || "/mnt/backup-volume"}
            disabled={checking || switching}
            className="flex-1 min-w-0 px-3 text-xs font-mono bg-transparent text-zinc-800 dark:text-zinc-200 focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={handleCheck}
            disabled={!input.trim() || checking || switching}
            className="px-3.5 text-xs font-medium border-l border-zinc-300 dark:border-zinc-600 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap"
          >
            {checking ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
            {checking ? t("dataManager.backup.dirChecking") : t("dataManager.backup.dirCheck")}
          </button>
        </div>

        {/* —— 校验结果 —— */}
        {checkResult && (
          checkResult.ok ? (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-700/40 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-xs space-y-1.5">
              <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-semibold">
                <CheckCircle size={12} />
                {t("dataManager.backup.dirCheckOk")}
              </div>
              <div className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300 break-all leading-snug">
                → {checkResult.resolved}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                <span>
                  {t("dataManager.backup.freeSpace")}:{" "}
                  <span className="font-semibold">{fmtBytes(checkResult.freeBytes ?? 0)}</span>
                </span>
                {checkResult.sameVolume && (
                  <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <AlertTriangle size={11} />
                    {t("dataManager.backup.dirCheckSameVolume")}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-red-200 dark:border-red-700/40 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-xs space-y-1">
              <div className="flex items-center gap-1.5 text-red-700 dark:text-red-400 font-semibold">
                <AlertCircle size={12} />
                {t("dataManager.backup.dirCheckFailed")}
              </div>
              <div className="text-red-600 dark:text-red-300 break-all leading-snug">
                {checkResult.message || checkResult.reason}
              </div>
            </div>
          )
        )}

        {/* —— 操作结果 —— */}
        {opMsg && (
          <div
            className={`flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-xs ${
              opMsg.type === "ok"
                ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700/40"
                : "bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-300 border border-red-200 dark:border-red-700/40"
            }`}
          >
            {opMsg.type === "ok" ? (
              <CheckCircle size={12} className="mt-0.5 flex-shrink-0" />
            ) : (
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
            )}
            <span className="break-all leading-snug">{opMsg.text}</span>
          </div>
        )}

        {/* —— 切换面板：仅当校验通过时才显示，避免按钮"灰着挡视线"的问题 —— */}
        {canSwitch && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-700/40 bg-amber-50/60 dark:bg-amber-500/5 p-3 space-y-2.5">
            <div className="flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              <span>{t("dataManager.backup.dirMigrateHint")}</span>
            </div>
            <button
              onClick={handleSwitch}
              disabled={switching}
              className={`w-full flex items-center justify-center py-2 px-3 rounded-lg text-xs font-medium transition-all ${
                switching
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed"
                  : "bg-amber-600 hover:bg-amber-700 text-white shadow-sm"
              }`}
            >
              {switching ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  {t("dataManager.backup.dirSwitching")}
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3.5 h-3.5 mr-1.5" />
                  {t("dataManager.backup.dirSwitch")}
                </>
              )}
            </button>
          </div>
        )}

        {/* 校验未通过时只露一行小提示，不占大块视觉 */}
        {!canSwitch && !checkResult && (
          <div className="text-[11px] text-zinc-500 leading-snug pt-0.5">
            {t("dataManager.backup.dirMigrateHint")}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 发送备份到邮箱 —— 对话框
// ----------------------------------------------------------------------------
// 为什么要单独对话框：
//   1. 发邮件触达互联网，必须让管理员先确认收件地址（从默认的"自己邮箱"改成别的
//      地址是一个有意识的动作，不能一键误发给错误对象）；
//   2. 附件上限 25 MB 的拦截在后端，UI 层提前做一次大小检查，避免把备份读进内存后
//      才被后端拒；同时在"正在发送"态把按钮禁用，避免双击重发；
//   3. 后端成功返回的 SMTP lastResponse（形如 "250 Ok: queued as xxx"）直接 toast，
//      能让管理员对"邮件是不是真的被服务器收下"有确定感，比单纯 "发送成功" 可信。
// ============================================================================
function BackupSendEmailDialog(props: {
  target: BackupRow;
  defaultTo: string;
  onClose: () => void;
  askPassword: () => Promise<string | null>;
  sudoTokenRef: React.MutableRefObject<string | null>;
  /** 发送成功（尤其在 createNew 情况下）后触发，用于让上层刷新备份列表。 */
  onSent?: () => void;
}) {
  const { t } = useTranslation();
  const { target, defaultTo, onClose, askPassword, sudoTokenRef, onSent } = props;
  const [to, setTo] = useState(defaultTo);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 附件格式：
  //   - "current"：直接发当前这条备份（zip 或 .bak，取决于 target.type）
  //   - "full"   ：请求后端现场新建一份 .zip 全量备份再发送
  //   - "db-only"：请求后端现场新建一份 .bak 数据库快照再发送
  // 说明：当用户选了一个"生成"选项，但所选格式恰好等于当前备份格式时，
  //      前端不做聪明降级——后端照单生成，这样用户能拿到一份"新时间戳"的备份，
  //      并与邮件投递时间一致，符合"每次发送 = 一次独立归档"的预期。
  type SendFormat = "current" | "full" | "db-only";
  const [format, setFormat] = useState<SendFormat>("current");

  // 前端硬拦截上限（与后端 EMAIL_ATTACHMENT_LIMIT 保持一致，25MB）
  const ATTACH_LIMIT = 25 * 1024 * 1024;
  // 只有"发送当前备份"时才能预知大小；选"生成新备份"时大小未知，
  // 超限由后端 413 再拦，不在前端硬拒——避免阻塞合理的小库全量备份。
  const tooLarge = format === "current" && target.size > ATTACH_LIMIT;

  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim());

  const handleSend = async () => {
    if (!emailValid || sending || tooLarge) return;
    setSending(true);
    setMsg(null);
    try {
      const out = await withSudo(
        (tk) =>
          api.backup.sendEmail(
            target.filename,
            to.trim(),
            tk,
            note.trim() || undefined,
            format, // "current" | "full" | "db-only"
          ),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        // 用户取消 sudo
        setSending(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      const sentName = out.result.filename || target.filename;
      setMsg({
        type: "ok",
        text: out.result.generatedNew
          ? t("dataManager.backup.sendEmailGeneratedSuccess", {
              filename: sentName,
              to: to.trim(),
              resp: out.result.lastResponse || "",
            })
          : t("dataManager.backup.sendEmailSuccess", {
              to: to.trim(),
              resp: out.result.lastResponse || "",
            }),
      });
      // 生成了新备份时，通知上层刷新列表；发送当前备份时不需要
      if (out.result.generatedNew && onSent) onSent();
    } catch (err: any) {
      setMsg({
        type: "err",
        text: t("dataManager.backup.sendEmailFailed", { error: err?.message || "error" }),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        key="send-email"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[65] flex items-center justify-center p-4"
      >
        <div
          className="absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
        <motion.div
          initial={{ scale: 0.95, y: 10, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.95, y: 10, opacity: 0 }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
          className="relative w-full max-w-md bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              <Mail className="w-3.5 h-3.5 text-sky-500" />
              {t("dataManager.backup.sendEmailTitle")}
            </h4>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-5 space-y-3">
            {/* 备份摘要 */}
            <div className="text-xs text-zinc-600 dark:text-zinc-400 p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-800 space-y-0.5">
              <div className="font-mono truncate" title={target.filename}>{target.filename}</div>
              <div className="opacity-70">
                {target.type} · {fmtBytes(target.size)} · {new Date(target.createdAt).toLocaleString()}
              </div>
            </div>

            {/* 附件格式选择
                 - 当前备份：直接发 target 本身；
                 - full(.zip)：数据库 + 附件 + 字体 + 插件 + 密钥，真正"全家桶"；
                 - db-only(.bak)：仅 SQLite 快照，附件会丢，但体积最小最适合邮件。
                "生成"两项会在后端顺手落成一条新备份，相当于"邮件发送 = 一次归档"。*/}
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("dataManager.backup.sendEmailFormat")}
              </label>
              <div className="grid grid-cols-1 gap-1.5">
                {([
                  {
                    val: "current" as const,
                    label: t("dataManager.backup.sendEmailFormatCurrent", {
                      type: target.type,
                      size: fmtBytes(target.size),
                    }),
                    hint: t("dataManager.backup.sendEmailFormatCurrentHint"),
                  },
                  {
                    val: "full" as const,
                    label: t("dataManager.backup.sendEmailFormatFull"),
                    hint: t("dataManager.backup.sendEmailFormatFullHint"),
                  },
                  {
                    val: "db-only" as const,
                    label: t("dataManager.backup.sendEmailFormatDbOnly"),
                    hint: t("dataManager.backup.sendEmailFormatDbOnlyHint"),
                  },
                ]).map((opt) => (
                  <label
                    key={opt.val}
                    className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition ${
                      format === opt.val
                        ? "border-sky-400 dark:border-sky-500/60 bg-sky-50 dark:bg-sky-500/10"
                        : "border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                    }`}
                  >
                    <input
                      type="radio"
                      name="send-email-format"
                      value={opt.val}
                      checked={format === opt.val}
                      onChange={() => setFormat(opt.val)}
                      className="mt-0.5 accent-sky-600"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-medium text-zinc-800 dark:text-zinc-200">
                        {opt.label}
                      </span>
                      <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                        {opt.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* 超大提示（仅"发送当前备份"时按 target.size 预判） */}
            {tooLarge && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300 text-xs leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{t("dataManager.backup.sendEmailTooLarge")}</span>
              </div>
            )}

            {/* 收件人 */}
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("dataManager.backup.sendEmailTo")}
              </label>
              <input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
              />
              {!emailValid && to && (
                <div className="text-[11px] text-red-500 mt-1">
                  {t("dataManager.backup.sendEmailInvalid")}
                </div>
              )}
            </div>

            {/* 备注（可选） */}
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("dataManager.backup.sendEmailNote")}
                <span className="opacity-60 ml-1 font-normal">
                  ({t("dataManager.backup.sendEmailNoteOptional")})
                </span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                rows={2}
                maxLength={500}
                placeholder={t("dataManager.backup.sendEmailNotePlaceholder")}
                className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500 resize-none"
              />
            </div>

            {/* 结果 */}
            {msg && (
              <div
                className={`flex items-start gap-2 p-2.5 rounded-lg text-xs leading-relaxed ${
                  msg.type === "ok"
                    ? "bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-700/40 text-emerald-700 dark:text-emerald-300"
                    : "bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300"
                }`}
              >
                {msg.type === "ok" ? (
                  <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                )}
                <span className="break-all">{msg.text}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 bg-zinc-50 dark:bg-zinc-900/40 border-t border-zinc-100 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
            >
              {t("common.close") || "关闭"}
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={!emailValid || sending || tooLarge}
              className="px-3.5 py-1.5 text-xs rounded-lg bg-sky-600 hover:bg-sky-700 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
            >
              {sending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              {t("dataManager.backup.sendEmailBtn")}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ============================================================================
// SMTP 常见邮箱速查 / 教程入口（管理员）
// ----------------------------------------------------------------------------
// 为什么内置这块：
//   - docs/backup-email-smtp.md 是完整文档，但"部署在内网 / 断网运维"的管理员
//     点不到 GitHub；把最关键的速查表（主机/端口/TLS/密码来源）内联到前端，
//     保证**不联网也能配通**常见的 QQ/163/Gmail/Outlook；
//   - 同时给一个"查看完整教程"的外链（GitHub docs），能联网的用户一键跳走看
//     详细点击路径、授权码生成步骤、故障排查；
//   - 刻意做成默认折叠，避免老手每次看到一长串说明。
// ============================================================================
function SmtpProviderGuide() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);

  // 速查表按"中文环境优先本地邮箱，英文环境优先国际邮箱"的顺序排列，
  // 让第一眼看到的就是当前用户最可能用的那家。
  const zhFirst = i18n.language?.toLowerCase().startsWith("zh");
  type Row = {
    name: string;
    host: string;
    port: string;
    tls: "on" | "off" | "465on-587off";
    passNote: string; // 密码来源的一句话说明，已翻译
  };
  const cn: Row[] = [
    { name: "QQ", host: "smtp.qq.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passAuthCodeQQ") },
    { name: "163", host: "smtp.163.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passAuthCode163") },
    { name: "126", host: "smtp.126.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passAuthCode163") },
    { name: "exmail", host: "smtp.exmail.qq.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passClientPass") },
  ];
  const intl: Row[] = [
    { name: "Gmail", host: "smtp.gmail.com", port: "465 / 587", tls: "465on-587off", passNote: t("dataManager.smtp.guide.passAppPassword") },
    { name: "Outlook", host: "smtp.office365.com", port: "587", tls: "off", passNote: t("dataManager.smtp.guide.passAppPassword") },
    { name: "Yahoo", host: "smtp.mail.yahoo.com", port: "465", tls: "on", passNote: t("dataManager.smtp.guide.passAppPassword") },
  ];
  const rows: Row[] = zhFirst ? [...cn, ...intl] : [...intl, ...cn];

  const tlsLabel = (v: Row["tls"]) =>
    v === "on"
      ? t("dataManager.smtp.guide.tlsOn")
      : v === "off"
        ? t("dataManager.smtp.guide.tlsOff")
        : t("dataManager.smtp.guide.tlsDepends");

  const docUrl = "https://github.com/cropflre/nowen-note/blob/main/docs/backup-email-smtp.md";

  return (
    <div className="rounded-lg border border-sky-200/70 dark:border-sky-500/30 bg-sky-50/60 dark:bg-sky-500/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={14} className="text-sky-600 dark:text-sky-400" />
        ) : (
          <ChevronRight size={14} className="text-sky-600 dark:text-sky-400" />
        )}
        <BookOpen size={14} className="text-sky-600 dark:text-sky-400" />
        <span className="text-xs font-medium text-sky-800 dark:text-sky-200">
          {t("dataManager.smtp.guide.title")}
        </span>
        <span className="ml-auto text-[11px] text-sky-700/70 dark:text-sky-300/70">
          {t("dataManager.smtp.guide.subtitle")}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          {/* 顶部简述：先告诉用户"必须用授权码 / App Password" */}
          <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            {t("dataManager.smtp.guide.intro")}
          </p>

          {/* 速查表 */}
          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
            <table className="w-full text-[11px]">
              <thead className="bg-zinc-50 dark:bg-zinc-800/60 text-zinc-600 dark:text-zinc-400">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colProvider")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colHost")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colPort")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colTls")}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t("dataManager.smtp.guide.colPass")}</th>
                </tr>
              </thead>
              <tbody className="text-zinc-700 dark:text-zinc-300">
                {rows.map((r) => (
                  <tr key={r.name} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-2 py-1.5 font-medium">{r.name}</td>
                    <td className="px-2 py-1.5 font-mono">{r.host}</td>
                    <td className="px-2 py-1.5 font-mono">{r.port}</td>
                    <td className="px-2 py-1.5">{tlsLabel(r.tls)}</td>
                    <td className="px-2 py-1.5">{r.passNote}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 关键提醒 */}
          <ul className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400 list-disc pl-4 space-y-0.5">
            <li>{t("dataManager.smtp.guide.tipAuthCode")}</li>
            <li>{t("dataManager.smtp.guide.tipFromEqLogin")}</li>
            <li>{t("dataManager.smtp.guide.tipPortTls")}</li>
            <li>{t("dataManager.smtp.guide.tipAttachmentLimit")}</li>
          </ul>

          {/* 外链：完整教程（需外网访问 GitHub） */}
          <a
            href={docUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[11px] text-sky-700 dark:text-sky-300 hover:underline"
          >
            <ExternalLink size={12} />
            {t("dataManager.smtp.guide.fullDocLink")}
          </a>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SMTP 邮件通道配置区（管理员）
// ----------------------------------------------------------------------------
// 设计要点：
//   - 放在 BackupSection 内部，而不是另开一个 Tab 或独立页面 —— 它的存在仅服务于
//     "备份发送到邮箱"，逻辑上和备份同域；
//   - 默认折叠（由内部 expanded 控制），不干扰备份主流程；
//   - 密码字段走"占位符模式"：hasPassword=true 时 input 显示 "••••••••"，用户不填
//     就代表不修改，避免"编辑其它字段"意外清空密码的陷阱；
//   - 保存成功后允许直接点"发送测试邮件"验证，所有操作都要 sudoToken。
// ============================================================================
function SmtpConfigSection(props: {
  askPassword: () => Promise<string | null>;
  sudoTokenRef: React.MutableRefObject<string | null>;
}) {
  const { t } = useTranslation();
  const { askPassword, sudoTokenRef } = props;

  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 服务端回的"只读视图"：永远不含明文密码，只有 hasPassword 标记
  const [hasPassword, setHasPassword] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // 表单字段（password 为空串意味着"不改动密码"）
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(465);
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState(""); // 空串 = 不动旧密码；用户主动输入才覆盖
  const [showPwd, setShowPwd] = useState(false);
  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 测试邮件
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await api.email.getSmtp();
      setEnabled(cfg.enabled);
      setHost(cfg.host);
      setPort(cfg.port);
      setSecure(cfg.secure);
      setUsername(cfg.username);
      setFromName(cfg.fromName);
      setFromEmail(cfg.fromEmail);
      setHasPassword(cfg.hasPassword);
      setUpdatedAt(cfg.updatedAt);
      setLoaded(true);
    } catch (err: any) {
      setSaveMsg({ type: "err", text: err?.message || "load failed" });
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次展开才拉取配置，避免没必要的 GET
  useEffect(() => {
    if (expanded && !loaded) loadConfig();
  }, [expanded, loaded, loadConfig]);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const out = await withSudo(
        (tk) =>
          api.email.putSmtp(
            {
              enabled,
              host: host.trim(),
              port: Number(port) || 465,
              secure,
              username: username.trim(),
              // 空串代表"不动旧密码"；非空才传新值
              password: password ? password : undefined,
              fromName: fromName.trim(),
              fromEmail: fromEmail.trim(),
            },
            tk,
          ),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setSaving(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      const cfg = out.result;
      setHasPassword(cfg.hasPassword);
      setUpdatedAt(cfg.updatedAt);
      setPassword(""); // 保存后清空本地密码输入框，避免残留
      setSaveMsg({ type: "ok", text: t("dataManager.smtp.saveSuccess") });
    } catch (err: any) {
      setSaveMsg({
        type: "err",
        text: t("dataManager.smtp.saveFailed", { error: err?.message || "error" }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const to = testTo.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      setTestMsg({ type: "err", text: t("dataManager.backup.sendEmailInvalid") });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const out = await withSudo(
        (tk) => api.email.testSmtp(to, tk),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setTesting(false);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      if (out.result.success) {
        setTestMsg({
          type: "ok",
          text: t("dataManager.smtp.testSuccess", {
            to,
            resp: out.result.lastResponse || "",
          }),
        });
      } else {
        setTestMsg({
          type: "err",
          text: out.result.error || t("dataManager.smtp.testFailed", { error: "error" }),
        });
      }
    } catch (err: any) {
      setTestMsg({
        type: "err",
        text: t("dataManager.smtp.testFailed", { error: err?.message || "error" }),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/30 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition"
      >
        {expanded ? (
          <ChevronDown size={14} className="text-zinc-500" />
        ) : (
          <ChevronRight size={14} className="text-zinc-500" />
        )}
        <SettingsIcon size={14} className="text-sky-500" />
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {t("dataManager.smtp.title")}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {loaded && (
            <span
              className={`text-[11px] px-1.5 py-0.5 rounded ${
                enabled
                  ? "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "bg-zinc-200 dark:bg-zinc-700/50 text-zinc-600 dark:text-zinc-400"
              }`}
            >
              {enabled ? t("dataManager.smtp.enabled") : t("dataManager.smtp.disabled")}
            </span>
          )}
          {updatedAt && (
            <span className="text-[11px] text-zinc-400">
              {new Date(updatedAt).toLocaleString()}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 space-y-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t("dataManager.smtp.description")}
          </p>

          {/* 常见邮箱 SMTP 配置教程入口
              ——————————————————————————————————————————————
              离线/内网环境：展开就能看到 QQ/163/Gmail/Outlook 的速查表与授权码要点，
              无需联网也够用；有外网时还给一个指向 docs/backup-email-smtp.md 的
              "完整教程"外链。刻意放在 description 下方、启用开关之上，
              原则是"先教会，再让你配"，降低首次配置时的挫败感。 */}
          <SmtpProviderGuide />


          {loading && !loaded ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500 py-4 justify-center">
              <Loader2 size={14} className="animate-spin" />
              {t("common.loading") || "加载中…"}
            </div>
          ) : (
            <>
              {/* 启用开关 */}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="w-4 h-4 accent-sky-600"
                />
                <span className="text-zinc-700 dark:text-zinc-300">
                  {t("dataManager.smtp.enable")}
                </span>
              </label>

              {/* host / port / secure */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {t("dataManager.smtp.host")}
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="smtp.example.com"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {t("dataManager.smtp.port")}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || 465)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={secure}
                  onChange={(e) => setSecure(e.target.checked)}
                  className="w-3.5 h-3.5 accent-sky-600"
                />
                <span>{t("dataManager.smtp.secure")}</span>
              </label>

              {/* 账号 / 密码 */}
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  {t("dataManager.smtp.username")}
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  {t("dataManager.smtp.password")}
                  {hasPassword && (
                    <span className="ml-2 text-[11px] text-emerald-600 dark:text-emerald-400 font-normal">
                      {t("dataManager.smtp.passwordSet")}
                    </span>
                  )}
                </label>
                <div className="relative">
                  <input
                    type={showPwd ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={hasPassword ? "••••••••" : t("dataManager.smtp.passwordPlaceholder") || ""}
                    className="w-full px-3 py-2 pr-9 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                    tabIndex={-1}
                  >
                    {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <div className="text-[11px] text-zinc-400 mt-1">
                  {t("dataManager.smtp.passwordHint")}
                </div>
              </div>

              {/* From */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {t("dataManager.smtp.fromName")}
                  </label>
                  <input
                    type="text"
                    value={fromName}
                    onChange={(e) => setFromName(e.target.value)}
                    placeholder="nowen-note"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {t("dataManager.smtp.fromEmail")}
                  </label>
                  <input
                    type="email"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    placeholder="no-reply@example.com"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                </div>
              </div>

              {/* Save 结果 */}
              {saveMsg && (
                <div
                  className={`flex items-start gap-2 p-2.5 rounded-lg text-xs leading-relaxed ${
                    saveMsg.type === "ok"
                      ? "bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-700/40 text-emerald-700 dark:text-emerald-300"
                      : "bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300"
                  }`}
                >
                  {saveMsg.type === "ok" ? (
                    <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  )}
                  <span className="break-all">{saveMsg.text}</span>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-3.5 py-1.5 text-xs rounded-lg bg-sky-600 hover:bg-sky-700 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
                >
                  {saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  {t("dataManager.smtp.save")}
                </button>
              </div>

              {/* ===== 发送测试邮件 ===== */}
              <div className="pt-3 mt-1 border-t border-dashed border-zinc-200 dark:border-zinc-800 space-y-2">
                <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {t("dataManager.smtp.testTitle")}
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder="test@example.com"
                    className="flex-1 px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-transparent text-zinc-900 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={testing || !testTo}
                    className="px-3 py-2 text-xs rounded-lg border border-sky-300 dark:border-sky-700/50 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5 justify-center"
                  >
                    {testing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    {t("dataManager.smtp.testSend")}
                  </button>
                </div>
                {testMsg && (
                  <div
                    className={`flex items-start gap-2 p-2.5 rounded-lg text-xs leading-relaxed ${
                      testMsg.type === "ok"
                        ? "bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-700/40 text-emerald-700 dark:text-emerald-300"
                        : "bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-700/40 text-red-700 dark:text-red-300"
                    }`}
                  >
                    {testMsg.type === "ok" ? (
                      <CheckCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    )}
                    <span className="break-all">{testMsg.text}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
