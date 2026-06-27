/**
 * NavRail（v16 P3 双层导航 Rail）
 *
 * 设计目标：把"模块切换"从主侧栏拆出，放到左侧永久可见的 Rail。
 * 主侧栏因此可以专注于"当前模块的子内容"（笔记本/标签）。
 *
 * 视觉模式（由 useRailMode 控制）：
 *   - "icon"  ：48px 纯图标（紧凑）
 *   - "label" ：64px 图标 + 下方 10px 标签文字（识别度优先，企微/钉钉风格）
 *   - "hidden"：桌面变体下整块不渲染（由 App.tsx 处理，本组件不会被挂载）。
 *               mobile 变体下抽屉永远显式打开来看导航，不接受 hidden——遇到 hidden 时
 *               强制按 icon 渲染。
 *
 * 行为约定：
 * - desktop 变体：hidden md:flex，配合 sidebarCollapsed 由 App.tsx 控制可见性。
 *   折叠按钮、设置、登出 都收编到 Rail（替代主侧栏 Footer + Header 折叠按钮的位置）。
 * - mobile 变体（v16 P3 后续：移动端也拆 Rail+主区两栏）：
 *   只在抽屉里渲染（外层已 md:hidden），顶部按钮是"关闭抽屉" X 而非折叠；
 *   设置 / 登出同样收编到 Rail 底部，与桌面对齐视觉风格。
 *
 * 与 Sidebar 内 navItemsRaw 的关系：
 *   两边各持一份"导航项配置"——拆分得干净（NavRail 不依赖 Sidebar 的内部 state）。
 *   维护成本：增删模块时两处都要改。后续如果出现第三个消费者，可考虑提到统一 hook。
 *
 * 关于回收站清空：
 *   v15 的逻辑（带 lock 检测 / 体量统计 / VACUUM 提示）在 Sidebar 内，复杂且与 toast 强耦合。
 *   Rail 上不再支持"右键清空"——这是低频破坏性操作，用户进入「回收站」视图后再清空更合理。
 *   不为了功能对齐而把 ~80 行复杂逻辑复制到这里。
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  BookOpen, Star, Trash2, ListTodo, BrainCircuit,
  Sparkles, NotebookPen, FolderOpen,
  Settings, LogOut, PanelLeftClose, PanelLeft, X,
  Columns2, Columns3, Cloud, CloudOff,
} from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions } from "@/store/AppContext";
import { api, broadcastLogout, getCurrentWorkspace, getServerUrl, clearServerUrl } from "@/lib/api";
import { ViewMode, WorkspaceFeatures } from "@/types";
import { cn } from "@/lib/utils";
import SettingsModal from "@/components/SettingsModal";
import MigrationModal from "@/components/MigrationModal";
import { useRailMode, nextRailMode, RailMode } from "@/hooks/useRailMode";
import { getAppInfo, isDesktop as isDesktopApp, switchDesktopToFull, type AppInfo } from "@/lib/desktopBridge";
import { clearLocalIdMap, clearQueue, getQueueLength } from "@/lib/offlineQueue";
import { clearRememberedCredentials } from "@/lib/rememberLogin";

type NavGroup = "workspace" | "modules" | "tools";

interface NavConfigItem {
  icon: React.ReactNode;
  labelKey: string;       // i18n key
  mode: ViewMode;
  feature?: keyof WorkspaceFeatures;
  group: NavGroup;
}

// Rail 上图标统一 18px——比主侧栏 16px 略大，因为没有文字陪衬时需要更醒目；
// label 模式下也保持 18px，配 10px 字号视觉层级正好。
const RAIL_ICON_SIZE = 18;

const NAV_CONFIG: NavConfigItem[] = [
  // ─── 工作台 ───
  { icon: <BookOpen size={RAIL_ICON_SIZE} />,    labelKey: "sidebar.allNotes",    mode: "all",        feature: "notes",     group: "workspace" },
  { icon: <Star size={RAIL_ICON_SIZE} />,        labelKey: "sidebar.favorites",   mode: "favorites",  feature: "favorites", group: "workspace" },
  { icon: <FolderOpen size={RAIL_ICON_SIZE} />,  labelKey: "sidebar.fileManager", mode: "files",      feature: "files",     group: "workspace" },
  { icon: <Trash2 size={RAIL_ICON_SIZE} />,      labelKey: "sidebar.trash",       mode: "trash",                            group: "workspace" },
  // ─── 内容模块 ───
  { icon: <NotebookPen size={RAIL_ICON_SIZE} />, labelKey: "sidebar.diary",       mode: "diary",      feature: "diaries",   group: "modules" },
  { icon: <ListTodo size={RAIL_ICON_SIZE} />,    labelKey: "sidebar.tasks",       mode: "tasks",      feature: "tasks",     group: "modules" },
  { icon: <BrainCircuit size={RAIL_ICON_SIZE} />,labelKey: "sidebar.mindMaps",    mode: "mindmaps",   feature: "mindmaps",  group: "modules" },
  // ─── 工具 ───
  { icon: <Sparkles size={RAIL_ICON_SIZE} />,    labelKey: "sidebar.aiChat",      mode: "ai-chat",                           group: "tools" },
];

/**
 * 判断 Rail 上某个 mode 是否处于"激活态"。
 * 产品决策：当用户选了某个具体的 notebook（viewMode="all" + selectedNotebookId 不为 null）
 * 或具体的 tag（viewMode="tag"）、搜索结果（viewMode="search"）时，Rail 应该高亮"所有笔记"——
 * 因为这些视图本质上都是笔记的派生视图。
 */
function isActive(itemMode: ViewMode, viewMode: ViewMode): boolean {
  if (itemMode === "all") {
    return viewMode === "all" || viewMode === "search" || viewMode === "tag";
  }
  return viewMode === itemMode;
}

export default function NavRail({ variant = "desktop" }: { variant?: "desktop" | "mobile" } = {}) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const [railMode, setRailMode] = useRailMode();
  // mobile 变体：hidden 在抽屉里没意义（用户已经主动打开抽屉就是要看导航），
  // 强制按 icon 渲染——不修改持久化值，桌面端切回 hidden 仍然有效。
  const effectiveMode: RailMode = variant === "mobile" && railMode === "hidden" ? "icon" : railMode;
  const showLabel = effectiveMode === "label";
  const isMobile = variant === "mobile";

  // 工作区功能开关——独立订阅一份（与 Sidebar 内部各自一份，互不干扰）。
  // 个人空间或加载失败时为 null = 全开。
  const [features, setFeatures] = useState<WorkspaceFeatures | null>(null);
  useEffect(() => {
    const load = () => {
      const ws = getCurrentWorkspace();
      if (!ws || ws === "personal") {
        setFeatures(null);
        return;
      }
      api.getWorkspaceFeatures(ws).then(setFeatures).catch(() => setFeatures(null));
    };
    load();
    const onChange = () => load();
    window.addEventListener("nowen:workspace-changed", onChange);
    window.addEventListener("nowen:workspace-features-changed", onChange);
    return () => {
      window.removeEventListener("nowen:workspace-changed", onChange);
      window.removeEventListener("nowen:workspace-features-changed", onChange);
    };
  }, []);

  // 设置弹窗（与 Sidebar 内的 settings 入口逻辑一致——这里独占一份，
  // 因为 Sidebar 桌面变体不再渲染 Settings 入口）
  const [showSettings, setShowSettings] = useState(false);
  // D-2：迁移向导弹窗。点"切换到云端"会先弹出，让用户选择是否把本地数据迁过去。
  const [showMigration, setShowMigration] = useState(false);
  const [desktopInfo, setDesktopInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (!isDesktopApp()) return;
    let cancelled = false;
    getAppInfo()
      .then((info) => {
        if (!cancelled) setDesktopInfo(info ?? null);
      })
      .catch(() => {
        if (!cancelled) setDesktopInfo(null);
      });
    return () => { cancelled = true; };
  }, []);

  const normalizeUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();
  const isLoopbackUrl = (url: string) => {
    try {
      const u = new URL(url);
      return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
    } catch {
      return false;
    }
  };
  const serverUrl = getServerUrl();
  const currentOrigin = typeof window !== "undefined" && window.location.origin.startsWith("http")
    ? window.location.origin
    : "";
  const desktopMode = desktopInfo?.mode ?? null;
  const usingDesktopLiteMode = desktopMode === "lite";
  const desktopLocalUrl = desktopInfo?.backendPort ? `http://127.0.0.1:${desktopInfo.backendPort}` : "";
  const usingCurrentLocalBackend = !!serverUrl && !!desktopLocalUrl && normalizeUrl(serverUrl) === normalizeUrl(desktopLocalUrl);
  // Electron 打包态是 file:// origin，不能用 "!currentOrigin" 判定远端；否则本地后端
  // http://127.0.0.1:<port> 也会被误判成云端，点击“本地”会反复清状态/刷新。
  const usingRemoteServer = !!serverUrl
    && !usingCurrentLocalBackend
    && (usingDesktopLiteMode || !isLoopbackUrl(serverUrl) || (!!currentOrigin && normalizeUrl(serverUrl) !== normalizeUrl(currentOrigin)));
  const canSwitchBackToLocal = isDesktopApp() && (usingRemoteServer || usingDesktopLiteMode);

  const items = features
    ? NAV_CONFIG.filter((it) => !it.feature || features[it.feature] !== false)
    : NAV_CONFIG;

  const handleClick = useCallback((mode: ViewMode) => {
    actions.setViewMode(mode);
    actions.setSelectedNotebook(null);

    // 移动端切换模块后自动关闭抽屉，露出对应内容区
    if (isMobile) {
      actions.setMobileSidebar(false);
    }
  }, [actions, isMobile]);

  const handleDesktopCloudButton = useCallback(async () => {
    if (!canSwitchBackToLocal) {
      setShowMigration(true);
      return;
    }

    const queuedCount = getQueueLength();
    if (queuedCount > 0) {
      const confirmed = window.confirm(
        t('sidebar.switchToLocalConfirmWithQueue', '切回本地离线模式？当前云端账号还有未同步操作，切换后这些待同步操作会被丢弃，云端数据不会被删除。')
      );
      if (!confirmed) return;
    }

    // 桌面端切回本地统一交给主进程：写 settings、清 Electron session storage、
    // 停/启后端并 relaunch。renderer 内部 location.reload() 在 file:// + query serverUrl
    // 场景下容易和 AuthGate / serverUrl 持久化互相打架，表现为黑屏/闪屏。
    const result = await switchDesktopToFull();
    if (result?.ok !== false) return;

    // 旧版 preload 不支持 mode IPC 时的兜底：只做 renderer 级清理并刷新。
    clearQueue();
    clearLocalIdMap();
    broadcastLogout("switch_to_local");
    try {
      clearServerUrl();
      localStorage.removeItem("nowen-token");
      localStorage.removeItem("nowen-prefer-cloud");
      localStorage.removeItem("nowen-offline-queue");
      localStorage.removeItem("nowen-offline-id-map");
    } catch { /* ignore */ }
    window.location.reload();
  }, [canSwitchBackToLocal, t]);

  // ===== 尺寸常量 =====
  // icon 模式：48px 宽栏 / 40px 方按钮
  // label 模式：64px 宽栏 / 整宽纵向按钮（图标 + 文字两行）
  const railWidthClass = showLabel ? "w-16" : "w-12";
  const itemBaseClass = showLabel
    ? "relative w-14 py-1.5 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors"
    : "relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors";

  const renderItem = (item: NavConfigItem) => {
    const active = isActive(item.mode, state.viewMode);
    const isTrashItem = item.mode === "trash";
    const label = t(item.labelKey);
    return (
      <button
        key={item.mode}
        onClick={() => handleClick(item.mode)}
        // icon 模式靠 title 兜底识别；label 模式文字已显式呈现，无需 tooltip
        title={showLabel ? undefined : label}
        aria-label={label}
        className={cn(
          itemBaseClass,
          active
            ? "bg-accent-primary/12 text-accent-primary"
            : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
          // 回收站破坏性入口降级：未选中时再弱半度
          isTrashItem && !active && "opacity-70 hover:opacity-100",
        )}
      >
        {/* Active 左侧 2px 高亮条——与主侧栏 v15 风格一致 */}
        {active && (
          <span
            className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent-primary"
            aria-hidden
          />
        )}
        {item.icon}
        {showLabel && (
          // 文字限定单行，超长用 ellipsis；leading-none 让两行视觉间距更紧凑
          <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">
            {label}
          </span>
        )}
      </button>
    );
  };

  // 分组之间用细分隔线（不要文字组标题——Rail 上分组标题 = 噪音）
  const groups: NavGroup[] = ["workspace", "modules", "tools"];

  // mobile 变体下 Rail 模式切换只在 icon ↔ label 之间循环（hidden 被强制忽略）。
  // 这样用户能在抽屉里调整图标紧凑度，但不会把自己折叠成无导航死局。
  const mobileNextMode: RailMode = effectiveMode === "label" ? "icon" : "label";
  const MobileSwitchIcon = effectiveMode === "label" ? Columns2 : Columns3;

  return (
    <div
      className={cn(
        // desktop：桌面专用，md 及以上才显示
        // mobile：仅在抽屉里使用，本身已被 md:hidden 包裹的容器约束；这里再加 md:hidden 双保险
        isMobile
          ? "flex md:hidden h-full"
          : "hidden md:flex h-full",
        "vibrancy-sidebar bg-app-sidebar border-r border-app-border flex-col items-center shrink-0 transition-[width] duration-150",
        railWidthClass,
      )}
      style={{ paddingTop: 'calc(var(--safe-area-top) + 4px)', paddingBottom: '8px' }}
    >
      {/* 顶部按钮区：
          - desktop：折叠/展开主侧栏（合并 Sidebar 原 Header 折叠按钮的功能）。
          - mobile：关闭抽屉 X（替代 Sidebar mobile Header 的关闭按钮，统一收编到 Rail）+
                    Rail 模式切换（icon ↔ label）。
          决策：这两个按钮都是工具按钮，不属于"导航项"——保持 40px 方形紧凑感，
          不与下方导航项的 label 模式纵向对齐。 */}
      {isMobile ? (
        <>
          <button
            onClick={() => actions.setMobileSidebar(false)}
            title={t('common.close')}
            aria-label={t('common.close')}
            className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <X size={16} />
          </button>
          <button
            onClick={() => setRailMode(mobileNextMode)}
            title={t(`sidebar.railMode.switchTo.${mobileNextMode}`)}
            aria-label={t(`sidebar.railMode.switchTo.${mobileNextMode}`)}
            className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <MobileSwitchIcon size={16} />
          </button>
        </>
      ) : (
        <button
          onClick={actions.toggleSidebar}
          title={state.sidebarCollapsed ? t('common.expand') : t('common.collapse')}
          aria-label={state.sidebarCollapsed ? t('common.expand') : t('common.collapse')}
          className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
        >
          {state.sidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </button>
      )}

      <div className={cn("my-2 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />

      {/* 主导航：3 组，组间细线分隔。
          v16 P3 后续：用 .no-scrollbar 隐藏 native 滚动条——Rail 是极简导航栏，
          滚动条会破坏视觉权重；label 模式下 8+ 项可能溢出窄屏视口，但鼠标滚轮/触摸板
          仍可滚动。极端窄屏用户更倾向直接切到 hidden 模式，停留在 label 是少数场景。 */}
      <div className="flex-1 min-h-0 w-full overflow-y-auto no-scrollbar flex flex-col items-center gap-1 px-1">
        {groups.map((g, idx) => {
          const groupItems = items.filter((it) => it.group === g);
          if (groupItems.length === 0) return null;
          return (
            <React.Fragment key={g}>
              {idx > 0 && (
                <div
                  className={cn("my-1 border-t border-app-border/60", showLabel ? "w-8" : "w-6")}
                  aria-hidden
                />
              )}
              {groupItems.map(renderItem)}
            </React.Fragment>
          );
        })}
      </div>

      <div className={cn("my-2 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />

      {/* 底部：设置 + 登出（label 模式下与导航项视觉对齐——也带文字，因为它们语义上是入口） */}
      <button
        onClick={() => setShowSettings(true)}
        title={showLabel ? undefined : t('sidebar.settings')}
        aria-label={t('sidebar.settings')}
        className={cn(
          itemBaseClass,
          "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
        )}
      >
        <Settings size={16} />
        {showLabel && (
          <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">
            {t('sidebar.settings')}
          </span>
        )}
      </button>
      {/*
        桌面端底部账号模式入口：
          - 本地态：显示 Cloud，打开 MigrationModal；登录后可选择「直接进入云端」
            或「迁移本地数据到云端」；
          - 云端态：显示 CloudOff，切回本地零登录；
          - lite 运行模式：交给主进程切回 full 并重启。
        Web/移动端保持原本的退出登录行为。
      */}
      {isDesktopApp() ? (
        <button
          onClick={handleDesktopCloudButton}
          title={showLabel ? undefined : (canSwitchBackToLocal
            ? t('sidebar.switchToLocal', '切回本地离线模式')
            : t('sidebar.switchToCloud', '切换到云端账号'))}
          aria-label={canSwitchBackToLocal
            ? t('sidebar.switchToLocal', '切回本地离线模式')
            : t('sidebar.switchToCloud', '切换到云端账号')}
          className={cn(
            itemBaseClass,
            "text-tx-tertiary hover:bg-app-hover hover:text-accent-primary",
          )}
        >
          {canSwitchBackToLocal ? <CloudOff size={16} /> : <Cloud size={16} />}
          {showLabel && (
            <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">
              {canSwitchBackToLocal
                ? t('sidebar.switchToLocalShort', '本地')
                : t('sidebar.switchToCloudShort', '云端')}
            </span>
          )}
        </button>
      ) : (
        <button
          onClick={async () => {
            // Android/移动端如果开启“下次自动登录”，必须先清除记住密码凭据；
            // 否则 reload 后 LoginPage 会读取 SecureStorage 并再次自动登录，表现为“退出不了”。
            await clearRememberedCredentials();
            // L10: 广播给其他 tab 一起下线，与 Sidebar Footer 保持一致
            broadcastLogout("user_logout");
            window.location.reload();
          }}
          title={showLabel ? undefined : t('sidebar.logout')}
          aria-label={t('sidebar.logout')}
          className={cn(
            itemBaseClass,
            "text-tx-tertiary hover:text-accent-danger hover:bg-accent-danger/10",
          )}
        >
          <LogOut size={16} />
          {showLabel && (
            <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">
              {t('sidebar.logout')}
            </span>
          )}
        </button>
      )}

      {/* Settings Modal（Rail 自持一份，与 Sidebar 互不影响） */}
      <AnimatePresence>
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
        {showMigration && (
          <MigrationModal
            onClose={() => {
              // 迁移完成 → reload 进入云端模式（MigrationModal 已写好 token & url）
              setShowMigration(false);
              window.location.reload();
            }}
            onCancel={() => {
              // 取消 = 关弹窗，保持当前（本地）模式不动。
              // 不 reload、不清 token，避免出现"主页 → 闪登录页 → 主页"的抖动。
              // 若用户确实想去云端，再次点"切换云端"即可，或在登录页手动走流程。
              setShowMigration(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
