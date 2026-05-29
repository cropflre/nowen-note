import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Palette, Shield, Database, X, Settings, Camera, Save, Loader2, Trash2, Upload, Type, Check, ChevronDown, Globe, Bot, Users, Info, ExternalLink, Heart, Sparkles, RefreshCw, Wrench, ZoomIn, Key, Building2, BookOpen, ToggleLeft, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import ThemeToggle from "@/components/ThemeToggle";
import SkinSwitcher from "@/components/SkinSwitcher";
import SecuritySettings from "@/components/SecuritySettings";
import TokenManagement from "@/components/TokenManagement";
import DataManager from "@/components/DataManager";
import AISettingsPanel from "@/components/AISettingsPanel";
import UserManagement from "@/components/UserManagement";
import WorkspaceManagement from "@/components/WorkspaceManagement";
import WhatsNewModal from "@/components/WhatsNewModal";
import AuthorStoryModal from "@/components/AuthorStoryModal";
import DownloadPanel from "@/components/DownloadPanel";
import { useSiteSettings, BUILTIN_FONTS, getBuiltinFontName } from "@/hooks/useSiteSettings";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { api } from "@/lib/api";
import { isDesktop, checkForUpdates, onUpdaterStatus, getReleaseChannel, isPortableDesktop, getAppInfo, setDesktopHideMenuBar as setDesktopHideMenuBarPreference, type UpdaterPayload } from "@/lib/desktopBridge";
import { CustomFont } from "@/types";
import { cn } from "@/lib/utils";

type TabId = "appearance" | "switches" | "ai" | "security" | "tokens" | "data" | "users" | "workspaces" | "developer" | "download" | "about";

interface SettingsModalProps {
  onClose: () => void;
  defaultTab?: TabId;
}

/**
 * Panel 级错误兜底：
 *
 * 背景：移动端（Capacitor / Android WebView）实测，部分 panel（尤其是 Data，
 * 由于其顶层 import 了 exportService / importService / 三个云盘组件，链路里包含
 * lowlight、tiptap、sessionStorage 等可能在受限 WebView 环境下抛错的依赖）
 * 在 mount 时同步抛错。由于全应用没有 ErrorBoundary，这种异常会冒泡到根，
 * 导致 createPortal 出去的整个 SettingsModal 子树被 React 卸载——表现为
 * "用户切到该 tab 后整个设置弹窗消失，回到笔记主界面"。
 *
 * 这里就地实现一个最小 ErrorBoundary，把"卸载整个 modal"的硬故障降级为
 * "该 panel 显示一句加载失败"的软故障，让其它 panel 仍然可用，并把错误
 * 留在 console 便于排查（不静默吞）。activeTab 变化时通过 key 重置状态，
 * 避免一次失败后切换到正常 panel 仍卡在错误态。
 */
class PanelErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 故意保留 console.error：移动端连 USB 调试时，这是唯一能拿到原始 stack 的途径。
    console.error("[SettingsModal] panel render failed:", error, info.componentStack);
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

/**
 * VersionCompareCard — "关于"页的版本对比卡
 *
 * 展示：
 *   - 当前客户端版本（编译期 __APP_VERSION__）
 *   - 服务端版本（/api/version, 由后端从根 package.json 解析）
 *   - GitHub 最新 release（后端 /api/releases/latest 代理，含 60s 缓存）
 *
 * 交互：
 *   - 桌面端（Electron）额外渲染"检查更新"按钮，走 electron-updater；
 *     同时订阅 updater 状态并在卡片下方滚动显示（checking / downloading %）。
 *   - Web / 移动端没有桥接，只显示三个版本 + 仓库链接。
 *
 * 错误策略：
 *   - 后端失败 → serverVersion 显示"unknown"并给"重试"按钮；
 *   - release 失败 → 展示 fallback 文案 + 仓库链接；
 *   - 都静默失败，不弹错误弹窗——"版本对比"本身是锦上添花，不要阻塞 About 渲染。
 */
function VersionCompareCard() {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [release, setRelease] = useState<
    | {
        available: true;
        tag: string;
        version: string;
        name: string;
        htmlUrl: string;
        publishedAt: string;
        prerelease: boolean;
        draft: boolean;
        body?: string;
      }
    | { available: false; reason: string }
    | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterPayload | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const desktop = isDesktop();
  const releaseChannel = getReleaseChannel();
  // Portable / 免安装版（Windows portable target）不走 electron-updater，
  // autoUpdater.checkForUpdates() 会抛 error；此时按钮要换成"前往下载页"，
  // 避免用户点了之后静默失败还以为是网络问题。
  const portable = isPortableDesktop();
  const clientVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

  // 拉版本信息
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setServerError(null);
    Promise.allSettled([api.getVersion(), api.getLatestRelease()])
      .then(([v, r]) => {
        if (cancelled) return;
        if (v.status === "fulfilled") {
          setServerVersion(v.value.appVersion || null);
        } else {
          setServerError(v.reason instanceof Error ? v.reason.message : String(v.reason));
        }
        if (r.status === "fulfilled") {
          setRelease(r.value);
        } else {
          setRelease({ available: false, reason: "request_failed" });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // 桌面端订阅 autoUpdater 状态
  useEffect(() => {
    if (!desktop) return;
    const off = onUpdaterStatus((p) => setUpdaterStatus(p));
    return off;
  }, [desktop]);

  const handleRetry = () => setReloadTick((t) => t + 1);
  const handleCheckUpdates = async () => {
    setUpdaterStatus({ status: "checking" });
    try {
      const res = await checkForUpdates();
      if (!res.ok && res.reason) {
        setUpdaterStatus({ status: "error", message: res.reason });
      }
    } catch (e) {
      setUpdaterStatus({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // 比较结果：outdated = 客户端 < 服务端
  const isOutdated =
    !!serverVersion && serverVersion !== "0.0.0" && serverVersion !== clientVersion;
  const hasNewerRelease =
    release?.available &&
    release.version !== clientVersion &&
    release.version !== serverVersion;

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">版本信息</h3>
        <button
          type="button"
          onClick={handleRetry}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400 hover:text-accent-primary disabled:opacity-50"
          title="重新拉取"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          {loading ? "检查中" : "重新检查"}
        </button>
      </div>

      <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-2 text-xs">
        {/* 客户端 */}
        <span className="text-zinc-500 dark:text-zinc-400">当前客户端</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100">v{clientVersion}</span>
        <span className="text-zinc-400 dark:text-zinc-600">
          {typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")
            ? "Desktop"
            : desktop
              ? "Desktop"
              : "Web"}
        </span>

        {/* 服务端 */}
        <span className="text-zinc-500 dark:text-zinc-400">服务端</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100">
          {serverError ? (
            <span className="text-amber-500">unknown</span>
          ) : serverVersion ? (
            <>v{serverVersion}</>
          ) : (
            <span className="text-zinc-400">—</span>
          )}
        </span>
        <span className="text-right">
          {isOutdated ? (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
              需刷新
            </span>
          ) : serverVersion ? (
            <span className="text-emerald-500">匹配</span>
          ) : null}
        </span>

        {/* GitHub 最新 release */}
        <span className="text-zinc-500 dark:text-zinc-400">最新发布</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100 truncate">
          {release?.available ? (
            <a
              href={release.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-primary hover:underline"
              title={release.name || release.tag}
            >
              v{release.version}
            </a>
          ) : release && !release.available ? (
            <span className="text-zinc-400">不可用</span>
          ) : (
            <span className="text-zinc-400">—</span>
          )}
        </span>
        <span className="text-right">
          {hasNewerRelease ? (
            <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400">
              可升级
            </span>
          ) : null}
        </span>
      </div>

      {/* 桌面端：检查更新按钮 + autoUpdater 状态
          Portable 版本不支持 electron-updater，切换成"前往下载页"CTA，
          并显式给出原因提示，避免用户点按钮后只看到模糊的错误。 */}
      {desktop && (
        <div className="pt-2 border-t border-zinc-200/60 dark:border-zinc-800/60 space-y-2">
          {releaseChannel && (
            <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
              <span>发布渠道</span>
              <span className="font-mono px-1.5 py-0.5 rounded bg-zinc-200/60 dark:bg-zinc-700/40 text-zinc-700 dark:text-zinc-200">
                {releaseChannel}
                {portable ? " · portable" : ""}
              </span>
            </div>
          )}
          {portable ? (
            <>
              <a
                href="https://github.com/cropflre/nowen-note/releases/latest"
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-primary text-white text-xs font-medium hover:opacity-90"
              >
                <ExternalLink size={12} />
                前往下载页
              </a>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 text-center leading-relaxed">
                免安装版不支持自动更新，请下载新版本 portable.exe 替换当前文件。
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleCheckUpdates}
                disabled={updaterStatus?.status === "checking" || updaterStatus?.status === "downloading"}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-primary text-white text-xs font-medium hover:opacity-90 disabled:opacity-60"
              >
                <RefreshCw
                  size={12}
                  className={
                    updaterStatus?.status === "checking" || updaterStatus?.status === "downloading"
                      ? "animate-spin"
                      : ""
                  }
                />
                检查桌面端更新
              </button>
              {updaterStatus && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400 text-center">
                  {renderUpdaterStatus(updaterStatus)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function renderUpdaterStatus(p: UpdaterPayload): string {
  switch (p.status) {
    case "checking":
      return "正在检查更新…";
    case "not-available":
      return "已是最新版本";
    case "available":
      return `发现新版本 v${p.version ?? "?"}，准备下载`;
    case "downloading": {
      const pct = typeof p.percent === "number" ? ` ${p.percent.toFixed(1)}%` : "";
      return `正在下载${pct}`;
    }
    case "downloaded":
      return `新版本 v${p.version ?? "?"} 已下载，将在下次重启时安装`;
    case "error":
      return `更新失败：${p.message || "未知错误"}`;
    default:
      return "";
  }
}

/**
 * 开发者选项面板（仅管理员可见）。
 *
 * 承载运行时调试开关，开关值持久化在 system_settings 表里——这意味着：
 *   - 不需要重启进程；
 *   - 全节点 30s 内（后端缓存 TTL）一致生效；
 *   - 重启后保持上次状态。
 *
 * 双源开关：env DEBUG_FILES_QUERY=1 也能强制开启（运维侧旁路），UI 上检测到
 * 该值时给出提示并禁用开关——避免管理员困惑"我关了为什么日志还在打"。
 *
 * 设计理由：之前 v12 myUploads 字面量大小写错配排查耗时颇长，根因是看不到
 * "后端实际收到的 query 是什么"。把这个调试开关做成可视化，下次再有类似
 * 「前端传了 filter 但后端像没收到」的现象，管理员可一键开启 → 看日志 → 关闭。
 */
function DeveloperPanel() {
  const { t } = useTranslation();
  const [debugFilesQuery, setDebugFilesQuery] = useState(false);
  const [envForced, setEnvForced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.getSiteSettings()
      .then((s) => {
        if (cancelled) return;
        setDebugFilesQuery(s.debug_files_query === "true");
        // 后端没单独下发 env 状态——做不到精确感知。这里保留 false，
        // 仅当 PUT 失败回写时才能间接发现 env 强开（暂不做）。如有需要后续
        // 可在 /api/settings 响应里加 `_env` 字段下发。
        setEnvForced(false);
      })
      .catch((e: any) => {
        if (!cancelled) setErrMsg(String(e?.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleToggleDebugFilesQuery = async (next: boolean) => {
    setSaving(true);
    setErrMsg("");
    const prev = debugFilesQuery;
    setDebugFilesQuery(next); // 乐观更新
    try {
      const data = await api.updateSiteSettings({ debug_files_query: next });
      // 用后端归一化后的真值兜底（防止前端布尔/字符串不一致）
      setDebugFilesQuery(data.debug_files_query === "true");
    } catch (e: any) {
      setDebugFilesQuery(prev); // 失败回滚
      setErrMsg(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">
          {t('settings.developerTitle')}
        </h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t('settings.developerDesc')}
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={debugFilesQuery}
            disabled={loading || saving || envForced}
            onChange={(e) => handleToggleDebugFilesQuery(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer disabled:cursor-not-allowed"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {t('settings.debugFilesQueryLabel')}
              </span>
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
              {t('settings.debugFilesQueryHint')}
            </p>
            {envForced && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1.5">
                {t('settings.debugFilesQueryEnvActive')}
              </p>
            )}
          </div>
        </label>
      </div>

      {errMsg && (
        <p className="text-xs text-red-500 dark:text-red-400">{errMsg}</p>
      )}
    </div>
  );
}

/**
 * 简易图片放大 Lightbox
 * - 点击图片打开，Esc/点击蒙层/关闭按钮 关闭
 * - createPortal 到 body，避免被 SettingsModal 的 overflow/transform 截断
 * - 故意做轻：赞赏码场景只需要看清原图，不需要缩放/平移
 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="absolute top-3 right-3 p-2 rounded-lg bg-black/60 border border-white/10 text-white/90 hover:bg-white/10 transition-colors"
        title="关闭 (Esc)"
        aria-label="关闭"
        onClick={onClose}
      >
        <X size={16} />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg shadow-2xl bg-white"
        draggable={false}
      />
    </div>,
    document.body
  );
}

function AboutPanel() {
  const { t } = useTranslation();
  const [showSponsor, setShowSponsor] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [showAuthorStory, setShowAuthorStory] = useState(false);
  // 赞赏码大图预览：点击赞赏码缩略图时弹起 Lightbox
  const [sponsorPreviewOpen, setSponsorPreviewOpen] = useState(false);
  return (
    <div className="space-y-6">
      {/* 标题区 */}
      <div className="text-center py-4">
        <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{t('about.appName')}</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">{t('about.slogan')}</p>
        <span className="inline-block mt-2 px-3 py-0.5 rounded-full bg-accent-primary/10 text-accent-primary text-xs font-medium">
          {t('about.version')} {__APP_VERSION__}
        </span>
      </div>

      {/* 版本对比卡（客户端 / 服务端 / GitHub 最新 release） */}
      <VersionCompareCard />

      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      {/* 简介 */}
      <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
        {t('about.description')}
      </p>

      {/* 核心能力 */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">{t('about.features')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            'featureEditor', 'featureAI', 'featureClipper',
            'featureMindMap', 'featureSync', 'featureSelfHost',
          ].map((key) => (
            <div key={key} className="flex items-start gap-2 p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/40">
              <Check size={14} className="text-accent-primary mt-0.5 shrink-0" />
              <span className="text-xs text-zinc-700 dark:text-zinc-300">{t(`about.${key}`)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      {/* 开源信息 */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
        <div>
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('about.openSource')}</span>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('about.license')}</p>
        </div>
        <a
          href="https://github.com/cropflre/nowen-note"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium hover:opacity-80 transition-opacity"
        >
          <ExternalLink size={12} />
          {t('about.github')}
        </a>
      </div>

      {/* 更新日志 */}
      <button
        type="button"
        onClick={() => setShowWhatsNew(true)}
        className="w-full flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/50 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent-primary/10 text-accent-primary">
            <Sparkles size={16} />
          </span>
          <div>
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t('about.changelog')}
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t('about.changelogDesc')}
            </div>
          </div>
        </div>
        <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">
          {t('about.viewChangelog')}
        </span>
      </button>

      {/* 作者感言 —— 项目背后的故事 */}
      <button
        type="button"
        onClick={() => setShowAuthorStory(true)}
        className="w-full flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/50 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 text-amber-500">
            <BookOpen size={16} />
          </span>
          <div>
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t('about.authorStory')}
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t('about.authorStoryDesc')}
            </div>
          </div>
        </div>
        <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">
          {t('about.authorStoryAction')}
        </span>
      </button>

      {/* 支持作者 / 打赏 */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowSponsor((v) => !v)}
          className="w-full flex items-center justify-between p-4 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-rose-500/10 text-rose-500">
              <Heart size={16} fill="currentColor" />
            </span>
            <div className="text-left">
              <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t('about.sponsor')}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {t('about.sponsorDesc')}
              </div>
            </div>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">
            {showSponsor ? t('about.sponsorCollapse') : t('about.sponsorAction')}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {showSponsor && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="px-4 pb-4 pt-2 flex flex-col items-center gap-3 border-t border-zinc-200/60 dark:border-zinc-800/60">
                {/* 点击图片打开 Lightbox 看大图（按钮包裹 → 无障碍/键盘可达） */}
                <button
                  type="button"
                  onClick={() => setSponsorPreviewOpen(true)}
                  className="group relative rounded-lg overflow-hidden cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                  title={t('about.sponsor')}
                  aria-label={t('about.sponsor')}
                >
                  <img
                    src="/weixin.jpg"
                    alt={t('about.sponsor')}
                    className="w-44 h-44 sm:w-52 sm:h-52 object-contain rounded-lg bg-white p-2 shadow-sm transition-transform duration-200 group-hover:scale-[1.02]"
                    loading="lazy"
                    draggable={false}
                  />
                  {/* hover 时浮现的放大图标提示 */}
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors">
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-2 py-1 rounded-md bg-black/60 text-white text-[11px]">
                      <ZoomIn size={12} />
                      点击放大
                    </span>
                  </span>
                </button>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center">
                  {t('about.sponsorTip')}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 底部 */}
      <p className="text-center text-xs text-zinc-400 dark:text-zinc-600">
        {t('about.madeWith')}
      </p>

      {/* 更新日志 Modal —— 用户点"查看更新"按钮时唤起 */}
      <WhatsNewModal
        open={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
      />

      {/* 作者感言 Modal —— 项目背后的故事 */}
      <AuthorStoryModal
        open={showAuthorStory}
        onClose={() => setShowAuthorStory(false)}
      />

      {/* 赞赏码大图预览 Lightbox */}
      {sponsorPreviewOpen && (
        <ImageLightbox
          src="/weixin.jpg"
          alt={t('about.sponsor')}
          onClose={() => setSponsorPreviewOpen(false)}
        />
      )}
    </div>
  );
}

function SwitchesPanel() {
  const { t } = useTranslation();
  const { prefs: userPrefs, setPref: setUserPref } = useUserPreferences();
  const [isAdmin, setIsAdmin] = useState(false);
  const [webUiEnabled, setWebUiEnabled] = useState(false);
  const [desktopHideMenuBar, setDesktopHideMenuBar] = useState(true);
  const [desktopPlatform, setDesktopPlatform] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const desktop = isDesktop();
  const supportsDesktopMenuBarToggle = desktop && desktopPlatform !== "darwin";

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => { if (!cancelled) setIsAdmin((u as any)?.role === "admin"); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    api.getSiteSettings()
      .then((s) => { if (!cancelled) setWebUiEnabled(s.web_ui_enabled !== "false"); })
      .catch(() => {});
    if (desktop) {
      getAppInfo()
        .then((info) => {
          if (cancelled) return;
          setDesktopHideMenuBar(!!info?.hideMenuBar);
          setDesktopPlatform(info?.platform ?? null);
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [desktop]);

  const handleToggleWebUi = async (next: boolean) => {
    const prev = webUiEnabled;
    setWebUiEnabled(next);
    setSavingKey("webUi");
    try {
      const updated = await api.updateSiteSettings({ web_ui_enabled: next });
      setWebUiEnabled(updated.web_ui_enabled !== "false");
    } catch {
      setWebUiEnabled(prev);
    } finally {
      setSavingKey(null);
    }
  };

  const handleToggleDesktopMenuBar = async (hide: boolean) => {
    const prev = desktopHideMenuBar;
    setDesktopHideMenuBar(hide);
    setSavingKey("menuBar");
    try {
      const res = await setDesktopHideMenuBarPreference(hide);
      if (typeof res.hideMenuBar === "boolean") setDesktopHideMenuBar(res.hideMenuBar);
    } catch {
      setDesktopHideMenuBar(prev);
    } finally {
      setSavingKey(null);
    }
  };

  const switches = [
    {
      key: "noteTitleAsAppTitle" as const,
      label: t('settings.prefNoteTitleAsAppTitle'),
      hint: t('settings.prefNoteTitleAsAppTitleHint'),
    },
    {
      key: "outlineDefaultOpen" as const,
      label: t('settings.prefOutlineDefaultOpen'),
      hint: t('settings.prefOutlineDefaultOpenHint'),
    },
    {
      key: "lockOnOpen" as const,
      label: t('settings.prefLockOnOpen'),
      hint: t('settings.prefLockOnOpenHint'),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">
          {t('settings.switchesTitle')}
        </h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t('settings.switchesDesc')}
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 divide-y divide-zinc-200 dark:divide-zinc-800 overflow-hidden">
        {switches.map((item) => (
          <label key={item.key} className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors">
            <input
              type="checkbox"
              checked={userPrefs[item.key]}
              onChange={(e) => setUserPref(item.key, e.target.checked)}
              className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 cursor-pointer"
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none">
                {item.label}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
                {item.hint}
              </p>
            </div>
          </label>
        ))}

        {supportsDesktopMenuBarToggle && (
          <label className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors">
            <input
              type="checkbox"
              checked={desktopHideMenuBar}
              disabled={savingKey === "menuBar"}
              onChange={(e) => handleToggleDesktopMenuBar(e.target.checked)}
              className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 cursor-pointer disabled:opacity-50"
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none flex items-center gap-1.5">
                隐藏桌面端菜单栏
                {savingKey === "menuBar" && <Loader2 size={12} className="animate-spin text-zinc-400" />}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
                仅 Windows/Linux 生效；隐藏后可按 Alt 临时显示菜单栏，快捷键仍然可用。
              </p>
            </div>
          </label>
        )}

        {isAdmin && (
          <label className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-white/60 dark:hover:bg-zinc-900/25 transition-colors">
            <input
              type="checkbox"
              checked={!webUiEnabled}
              disabled={savingKey === "webUi"}
              onChange={(e) => handleToggleWebUi(!e.target.checked)}
              className="mt-0.5 w-3.5 h-3.5 accent-indigo-600 cursor-pointer disabled:opacity-50"
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-none flex items-center gap-1.5">
                关闭网页端页面
                {savingKey === "webUi" && <Loader2 size={12} className="animate-spin text-zinc-400" />}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">
                开启后服务器只保留 API；浏览器访问网页端会显示禁用提示。桌面客户端使用本地界面连接 API，不受影响。
              </p>
            </div>
          </label>
        )}
      </div>
    </div>
  );
}

function AppearancePanel() {
  const { t, i18n } = useTranslation();
  const { siteConfig, updateSiteConfig, updateEditorFont } = useSiteSettings();
  const { prefs: userPrefs, setPref: setUserPref } = useUserPreferences();
  const [title, setTitle] = useState(siteConfig.title);
  const [previewIcon, setPreviewIcon] = useState(siteConfig.favicon);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 站点标识属于全站共享配置，只有系统管理员能改。
  // 这里独立拉一次身份（不依赖父组件传 props），与 DataManager 的做法保持一致，
  // 避免修改 SettingsModal 主体的渲染契约。
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => { if (!cancelled) setIsAdmin((u as any)?.role === "admin"); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, []);

  // 字体状态
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [isSwitchingFont, setIsSwitchingFont] = useState(false);
  const fontFileRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 加载自定义字体列表
  const loadFonts = useCallback(async () => {
    try {
      const fonts = await api.getFonts();
      setCustomFonts(fonts);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadFonts(); }, [loadFonts]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setFontDropdownOpen(false);
      }
    };
    if (fontDropdownOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fontDropdownOpen]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setSaveMessage(t('settings.iconTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewIcon(reader.result as string);
      setSaveMessage("");
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveIcon = () => {
    setPreviewIcon("");
    setSaveMessage("");
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setIsSaving(true);
    setSaveMessage("");
    try {
      await updateSiteConfig(title.trim(), previewIcon);
      setSaveMessage(t('settings.saveSuccess'));
      setTimeout(() => setSaveMessage(""), 2000);
    } catch {
      setSaveMessage(t('settings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = title !== siteConfig.title || previewIcon !== siteConfig.favicon;

  // 当前字体的显示名
  const currentFontName = (() => {
    const builtin = BUILTIN_FONTS.find(f => f.id === siteConfig.editorFontFamily);
    if (builtin) return getBuiltinFontName(builtin);
    const custom = customFonts.find(f => f.id === siteConfig.editorFontFamily);
    return custom ? custom.name : t('settings.interDefault');
  })();

  const handleSelectFont = async (fontId: string) => {
    setIsSwitchingFont(true);
    setFontDropdownOpen(false);
    try {
      await updateEditorFont(fontId);
    } catch { /* ignore */ }
    setIsSwitchingFont(false);
  };

  const handleUploadFonts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setUploadMessage("");
    setUploadSuccess(false);
    try {
      const result = await api.uploadFonts(files);
      const msgs: string[] = [];
      if (result.uploaded.length > 0) msgs.push(t('settings.fontUploadSuccess', { count: result.uploaded.length }));
      if (result.errors.length > 0) msgs.push(result.errors.join("; "));
      setUploadMessage(msgs.join(" · "));
      setUploadSuccess(result.uploaded.length > 0);
      await loadFonts();
      setTimeout(() => { setUploadMessage(""); setUploadSuccess(false); }, 4000);
    } catch (err: any) {
      setUploadMessage(err.message || t('settings.fontUploadFailed'));
      setUploadSuccess(false);
    } finally {
      setIsUploading(false);
      if (fontFileRef.current) fontFileRef.current.value = "";
    }
  };

  const handleDeleteFont = async (fontId: string) => {
    try {
      await api.deleteFont(fontId);
      // 如果删的是当前字体，回退默认
      if (siteConfig.editorFontFamily === fontId) {
        await updateEditorFont("");
      }
      await loadFonts();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-6">
      {/* 站点标识 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t('settings.siteIdentity')}</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-2">{t('settings.siteIdentityDesc')}</p>
        {!isAdmin && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-4">
            {t('settings.siteIdentityAdminOnly')}
          </p>
        )}
        {isAdmin && <div className="mb-6" />}

        <div className="flex flex-col sm:flex-row gap-6 items-start">
          {/* Logo 上传区域 */}
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('settings.siteIcon')}</span>
            <div
              className={cn(
                "relative w-20 h-20 rounded-2xl border-2 border-dashed border-zinc-300 dark:border-zinc-700 flex items-center justify-center overflow-hidden group transition-colors",
                isAdmin
                  ? "cursor-pointer hover:border-accent-primary"
                  : "cursor-not-allowed opacity-60"
              )}
              onClick={() => { if (isAdmin) fileInputRef.current?.click(); }}
            >
              {previewIcon ? (
                <img src={previewIcon} alt="Site Icon" className="w-full h-full object-cover" />
              ) : (
                <div className="flex flex-col items-center gap-1 text-zinc-400 dark:text-zinc-600">
                  <Camera size={20} />
                  <span className="text-[10px]">{t('settings.upload')}</span>
                </div>
              )}
              {isAdmin && (
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                  <Camera className="w-5 h-5 text-white" />
                </div>
              )}
            </div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageChange}
              accept="image/png,image/jpeg,image/svg+xml,image/x-icon,image/webp"
              className="hidden"
              disabled={!isAdmin}
            />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500">PNG/SVG/ICO · &lt;1MB</span>
              {previewIcon && isAdmin && (
                <button
                  onClick={handleRemoveIcon}
                  className="text-[10px] text-red-500 hover:text-red-400 transition-colors"
                >
                  {t('settings.remove')}
                </button>
              )}
            </div>
          </div>

          {/* 站点名称 */}
          <div className="flex-1 space-y-3 w-full">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('settings.siteName')}</label>
              <input
                type="text"
                value={title}
                onChange={(e) => { setTitle(e.target.value); setSaveMessage(""); }}
                maxLength={20}
                disabled={!isAdmin}
                className="w-full px-3 py-2 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all placeholder:text-zinc-400 disabled:opacity-60 disabled:cursor-not-allowed"
                placeholder={t('settings.siteNamePlaceholder')}
              />
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right">{title.length} / 20</p>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={isSaving || !title.trim() || !hasChanges}
                  className="flex items-center justify-center gap-1.5 px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-white rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {t('settings.saveChanges')}
                </button>
                {saveMessage && (
                  <span className={`text-xs ${saveMessage === t('settings.saveSuccess') ? "text-emerald-500" : "text-red-500"}`}>
                    {saveMessage}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 分割线 */}
      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      {/* 外观与主题 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t('settings.appearanceTheme')}</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">{t('settings.appearanceThemeDesc')}</p>
      </div>

      <div className="space-y-4">
        {/* 外观风格（Skin）：默认 / macOS —— 与下方明暗模式正交 */}
        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 space-y-3">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t('appearance.skinTitle', { defaultValue: '外观风格' })}
            </span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t('appearance.skinDesc', { defaultValue: '选择整体视觉语言。macOS 风格在 Apple 设备上体验最佳。' })}
            </p>
          </div>
          <SkinSwitcher />
        </div>

        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('settings.themeMode')}</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings.themeModeDesc')}</p>
          </div>
          <ThemeToggle />
        </div>

        {/* 编辑器字体 - 可交互 */}
        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('settings.editorFont')}</span>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings.editorFontDesc')}</p>
            </div>
            {isSwitchingFont && <Loader2 size={14} className="animate-spin text-accent-primary" />}
          </div>

          {/* 字体选择器下拉 */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setFontDropdownOpen(!fontDropdownOpen)}
              className="w-full flex items-center justify-between px-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100 hover:border-accent-primary/50 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Type size={14} className="text-zinc-400" />
                {currentFontName}
              </span>
              <ChevronDown size={14} className={cn("text-zinc-400 transition-transform", fontDropdownOpen && "rotate-180")} />
            </button>

            <AnimatePresence>
              {fontDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute z-50 top-full left-0 mt-1 w-full max-h-64 overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl"
                >
                  {/* 内置字体 */}
                  <div className="px-2 pt-2 pb-1">
                    <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2">{t('settings.builtinFonts')}</span>
                  </div>
                  {BUILTIN_FONTS.map(font => (
                    <button
                      key={font.id}
                      onClick={() => handleSelectFont(font.id)}
                      className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                    >
                      <span style={{ fontFamily: font.family }}>{getBuiltinFontName(font)}</span>
                      {siteConfig.editorFontFamily === font.id && <Check size={14} className="text-accent-primary" />}
                    </button>
                  ))}

                  {/* 自定义字体 */}
                  {customFonts.length > 0 && (
                    <>
                      <div className="h-px bg-zinc-100 dark:bg-zinc-800 mx-2 my-1" />
                      <div className="px-2 pt-1 pb-1">
                        <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2">{t('settings.importedFonts')}</span>
                      </div>
                      {customFonts.map(font => (
                        <div
                          key={font.id}
                          className="flex items-center justify-between px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors group"
                        >
                          <button
                            onClick={() => handleSelectFont(font.id)}
                            className="flex-1 text-left text-sm text-zinc-700 dark:text-zinc-300"
                          >
                            {font.name}
                            <span className="ml-2 text-[10px] text-zinc-400">.{font.format}</span>
                          </button>
                          <div className="flex items-center gap-1.5">
                            {siteConfig.editorFontFamily === font.id && <Check size={14} className="text-accent-primary" />}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDeleteFont(font.id); }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-400 hover:text-red-500 transition-all"
                              title={t('settings.deleteFont')}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 字体导入 */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => fontFileRef.current?.click()}
              disabled={isUploading}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg text-xs text-zinc-600 dark:text-zinc-400 hover:border-accent-primary/50 hover:text-accent-primary transition-colors disabled:opacity-50"
            >
              {isUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {t('settings.importFont')}
            </button>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t('settings.importFontHint')}</span>
            <input
              type="file"
              ref={fontFileRef}
              onChange={handleUploadFonts}
              accept=".otf,.otc,.ttc,.ttf,.woff,.woff2"
              multiple
              className="hidden"
            />
          </div>

          {uploadMessage && (
            <p className={cn("text-xs", uploadSuccess ? "text-emerald-500" : "text-amber-500")}>{uploadMessage}</p>
          )}

          {/* 字体预览 */}
          <div
            className="px-3 py-3 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-950"
            style={{ fontFamily: "var(--editor-font-family)" }}
          >
            <p className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">
              {t('settings.fontPreviewEn')}
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed mt-1">
              {t('settings.fontPreviewZh')}
            </p>
          </div>
        </div>

        {/* 语言切换 */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-zinc-500 dark:text-zinc-400" />
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('language.label')}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">
            {([
              { code: "zh-CN", label: t('language.zh') },
              { code: "en", label: t('language.en') },
            ] as const).map(lang => (
              <button
                key={lang.code}
                onClick={() => i18n.changeLanguage(lang.code)}
                className={cn(
                  "relative px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  i18n.language === lang.code
                    ? "bg-white dark:bg-zinc-700 text-accent-primary shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>

        {/* 阅读密度：影响编辑器正文段落与列表项的纵向间距/行高（per-device 偏好） */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div className="min-w-0 pr-3">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t('settings.readingDensity', { defaultValue: '阅读密度' })}
            </span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t('settings.readingDensityDesc', { defaultValue: '调节正文段落和列表项的纵向间距，紧凑模式更省空间。' })}
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex-shrink-0">
            {([
              { code: "cozy" as const, label: t('settings.densityCozy', { defaultValue: '宽松' }) },
              { code: "compact" as const, label: t('settings.densityCompact', { defaultValue: '紧凑' }) },
            ]).map(opt => (
              <button
                key={opt.code}
                onClick={() => setUserPref("readingDensity", opt.code)}
                className={cn(
                  "relative px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  userPrefs.readingDensity === opt.code
                    ? "bg-white dark:bg-zinc-700 text-accent-primary shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/*
         * 个人空间导入/导出的功能开关已下沉为 per-user 字段
         * （users.personalExportEnabled / personalImportEnabled，schema v6 起）。
         * 现在管理员需要在「用户管理」tab 里逐个用户编辑，不再是站点级全局开关。
         * 这里历史上的 FeatureTogglesSection 已整体移除。
         */}
      </div>
    </div>
  );
}

const SettingsModal = React.forwardRef<HTMLDivElement, SettingsModalProps>(
  function SettingsModal({ onClose, defaultTab = "appearance" }, ref) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const { siteConfig } = useSiteSettings();
  const [currentUser, setCurrentUser] = useState<{ id: string; role?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => { if (!cancelled) setCurrentUser({ id: u.id, role: (u as any).role }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 监听"DataManager 完成导入后请求关闭弹窗"事件——用户在 DataManager 里
  // 把笔记导入到 ≠ 当前侧边栏的工作区，点击"切换到该工作区查看"按钮后，需要
  // 把这层 Modal 也关掉，否则切到目标工作区但弹窗仍盖住主界面，体感很奇怪。
  useEffect(() => {
    const onCloseRequest = () => onClose();
    window.addEventListener("nowen:close-settings", onCloseRequest);
    return () => window.removeEventListener("nowen:close-settings", onCloseRequest);
  }, [onClose]);

  const isAdmin = currentUser?.role === "admin";

  const SETTING_TABS = [
    { id: "appearance" as const, label: t('settings.appearance'), icon: Palette },
    { id: "switches" as const, label: t('settings.switches'), icon: ToggleLeft },
    { id: "ai" as const, label: t('settings.ai'), icon: Bot },
    { id: "security" as const, label: t('settings.security'), icon: Shield },
    // 【个人访问令牌】任意登录用户都可管理自己的 token；与 security 同为"账号安全"类别，
    // 不需要 isAdmin 判定。
    { id: "tokens" as const, label: t('settings.tokens', { defaultValue: '访问令牌' }), icon: Key },
    ...(isAdmin ? [{ id: "users" as const, label: t('settings.users'), icon: Users }] : []),
    ...(isAdmin ? [{ id: "workspaces" as const, label: t('settings.workspaces'), icon: Building2 }] : []),
    // 「数据管理」面板：
    //   - 管理员：展示三个一级 tab（个人空间 / 工作区 / 系统），包含跨用户/全库范围
    //     的高危操作（备份、灾难恢复、工厂重置、SQLite 文件级导入导出等）；
    //   - 普通用户：DataManager 内部只渲染"个人空间"scope 的导出/导入 —— 这是
    //     用户对自己数据的基本自主权。是否可用再叠加后端下发的 feature flag
    //     （personalExport/Import Enabled），由管理员集中控制。
    //   组件内部也做了一层防御性闸门，防止用户从深链绕过这里直达 admin-only 区域。
    { id: "data" as const, label: t('settings.dataManagement'), icon: Database },
    // 「开发者」面板：仅管理员可见，承载运行时调试开关（如 files-list 查询日志）。
    // 普通用户根本看不到这一项，与后端的 admin-only 写入闸门双层防御。
    ...(isAdmin ? [{ id: "developer" as const, label: t('settings.developer'), icon: Wrench }] : []),
    // 「下载客户端」面板：面向所有用户（含未登录、本地、云端）。需求背景：
    //   用户主要在中国大陆，GitHub Releases 下载体验差，这里按平台列出产物并提供
    //   「GitHub 直连 + 多个公共加速代理」的换源能力。与 about 的「前往下载页」区别：后者只能调起
    //   GitHub 。该面板本身不调用任何需要鉴权的接口（releases/latest 未鉴权）。
    { id: "download" as const, label: t('settings.download', { defaultValue: '下载客户端' }), icon: Download },
    { id: "about" as const, label: t('about.title'), icon: Info },
  ];

  // 用 Portal 挂载到 body：
  //   SettingsModal 调用点位于 Sidebar 组件内部（见 Sidebar.tsx 的 AnimatePresence）。
  //   Sidebar 根容器使用 `.vibrancy-sidebar`，在 macOS 皮肤下会经由 ::before 应用
  //   backdrop-filter；CSS 规范规定任何非 none 的 backdrop-filter 都会让宿主成为
  //   内部 position: fixed 的 containing block。即使我们已经把 filter 挪到伪元素
  //   减小了冲撞面，Sidebar 子树未来可能加入 transform / filter / contain 等属性，
  //   都会再次困住本模态框。用 Portal 一次性脱离 Sidebar 子树，彻底杜绝此类布局事故。
  //
  // 移动端关闭误触防御（重要）：
  //   实测在 Capacitor / Android & iOS WebView 里，用户在弹窗内"长按 / 滚动 / 横向触摸"
  //   都会让弹窗瞬间消失。真因不是弹窗自身处理了点击，而是 App.tsx 的 useSwipeGesture
  //   在 document 上监听全局 touchstart/touchend：打开 SettingsModal 时 mobileSidebarOpen
  //   仍为 true，任何足够大的 deltaX 都会触发 setMobileSidebar(false)。SettingsModal 虽
  //   然 portal 到 body，但生命周期挂在 Sidebar 子树——Sidebar 卸载就把弹窗一起带走。
  //   React 合成事件的 stopPropagation 拦不住 document 原生监听，必须用 data 属性让全局
  //   hook 主动跳过本子树（见 App.tsx 同名实现）。
  //
  //   除此之外仍保留下列分层防御：
  //     - 桌面端遮罩点击关闭；移动端遮罩 max-md:hidden（视觉上看不见的遮罩没意义）；
  //     - 模态主体 touch-action: pan-y pinch-zoom，避免被 WebView 当作系统返回手势；
  //     - 顶层 motion.div 不绑 click，避免漏到外层的点击被解释成关闭。
  return createPortal(
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-0 md:p-4 md:sm:p-6"
      // data-swipe-blocker：让 App.tsx::useSwipeGesture 在本子树内的 touchstart 上主动跳过
      // 判定。整个 portal 子树（含移动端 tab 栏 / panel 内容）一并受保护。
      data-swipe-blocker="settings-modal"
    >
      {/* 背景遮罩：仅桌面端渲染。移动端模态主体已全屏覆盖，遮罩不可见且只会
          带来\"轻触即关闭\"的误触，故直接不挂载。 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="hidden md:block absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
      />

      {/* 模态框主体
          - touch-action: pan-y pinch-zoom：声明本容器内部只允许竖向滚动 + 双指缩放，
            禁止 WebView 把横向 / 边缘手势解释为系统级返回 / 抽屉手势；
          - onPointerDownCapture stopPropagation：把指针事件在捕获阶段就拦下，
            杜绝事件\"绕过\"主体冒到外层 motion.div 上。 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", duration: 0.5, bounce: 0 }}
        className="relative w-full max-w-4xl h-[80vh] min-h-[500px] flex flex-col md:flex-row overflow-hidden bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 max-md:h-[100dvh] max-md:max-w-none max-md:rounded-none max-md:border-0"
        style={{ touchAction: "pan-y pinch-zoom" }}
        onClick={(e) => e.stopPropagation()}
        onPointerDownCapture={(e) => e.stopPropagation()}
      >
        {/* 移动端：顶部标签栏 + 关闭按钮
            - sticky top-0：避免内容滚动时 tab 栏跟着上移露出后面的遮罩；
            - touch-action: pan-x：仅允许横向滑动（tab 多时可滑），杜绝竖向手势
              漂移到外层被识别为关闭/系统手势。 */}
        <div
          className="md:hidden sticky top-0 z-10 flex items-center border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/95 backdrop-blur"
          style={{ paddingTop: 'var(--safe-area-top)', touchAction: 'pan-x' }}
        >
          <div className="flex-1 flex items-center gap-1 px-3 py-2 overflow-x-auto no-scrollbar" style={{ touchAction: 'pan-x' }}>
            {SETTING_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                    isActive
                      ? "bg-zinc-200/70 dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400"
                      : "text-zinc-500 dark:text-zinc-400 active:bg-zinc-200/40 dark:active:bg-zinc-800/50"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <button
            onClick={onClose}
            className="p-2 mr-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-lg transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 桌面端：左侧导航栏 */}
        <div className="hidden md:flex w-56 flex-shrink-0 bg-zinc-50 dark:bg-zinc-900/50 border-r border-zinc-200 dark:border-zinc-800 p-4 flex-col">
          <div className="flex items-center gap-2 mb-6 px-2">
            <Settings className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
            <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">{t('settings.title')}</span>
          </div>

          <nav className="flex-1 space-y-0.5">
            {SETTING_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-zinc-200/70 dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* 底部版本信息：版本号由 vite.config.ts 从根 package.json 注入 */}
          <div className="mt-auto pt-4 border-t border-zinc-200 dark:border-zinc-800 px-2">
            <p className="text-xs text-zinc-400 dark:text-zinc-600">{siteConfig.title} v{__APP_VERSION__}</p>
          </div>
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto relative">
          {/* 关闭按钮 — 桌面端 */}
          <button
            onClick={onClose}
            className="hidden md:block absolute top-4 right-4 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors z-10"
          >
            <X className="w-4 h-4" />
          </button>

          {/* 动态渲染内容 */}
          <div className="p-4 md:p-8 md:pr-14">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.15 }}
              >
                {/*
                  PanelErrorBoundary 用 activeTab 做 key：每次切 tab 都重新创建一个
                  Boundary 实例，已经"中过招"的 panel 不会污染下一个 panel 的状态；
                  同时把"模态框被整个卸掉退回笔记页"的灾难性体验降级成局部错误提示。
                */}
                <PanelErrorBoundary
                  key={activeTab}
                  fallback={
                    <div className="py-12 px-4 text-center">
                      <p className="text-sm text-zinc-600 dark:text-zinc-300">
                        {t('settings.panelLoadFailed')}
                      </p>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">
                        {t('settings.panelLoadFailedHint')}
                      </p>
                    </div>
                  }
                >
            {activeTab === "appearance" && <AppearancePanel />}
            {activeTab === "switches" && <SwitchesPanel />}
            {activeTab === "ai" && <AISettingsPanel />}
            {activeTab === "security" && <SecuritySettings />}
            {activeTab === "tokens" && <TokenManagement />}
                  {activeTab === "users" && isAdmin && <UserManagement currentUserId={currentUser?.id ?? null} />}
                  {activeTab === "workspaces" && isAdmin && <WorkspaceManagement />}
                  {/* data tab 对所有用户可见：DataManager 内部会按 isAdmin 自动分流
                       —— 管理员看到完整三 scope；普通用户只看"个人空间"的导出/导入。 */}
                  {activeTab === "data" && <DataManager />}
                  {activeTab === "developer" && isAdmin && <DeveloperPanel />}
                  {activeTab === "download" && <DownloadPanel />}
                  {activeTab === "about" && <AboutPanel />}
                </PanelErrorBoundary>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
});

export default SettingsModal;
