import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Palette, Shield, Database, X, Camera, Save, Loader2, Trash2, Upload, Type, Check, ChevronDown, Globe, Bot, Users, Info, ExternalLink, Heart, Sparkles, RefreshCw, ZoomIn, Key, Keyboard, Building2, BookOpen, SlidersHorizontal, Download, FolderSync, Mail, Workflow, Blocks, Star, Share2, Copy, Server, WifiOff, Layers, Compass, ArrowUpRight, FileText, Rocket, Clock } from "lucide-react";
import PluginManagementPanel from "@/components/PluginManagementPanel";
import { useTranslation } from "react-i18next";
import { Browser } from "@capacitor/browser";
import wechatSponsorQr from "@/assets/sponsor/weixin.jpg";
import alipaySponsorQr from "@/assets/sponsor/zhifubao.png";
import qqGroupQr from "@/assets/feedback/qq-group.jpg";
import communityQr from "@/assets/community/nowen-lab-wechat.jpg";
import ThemeToggle from "@/components/ThemeToggle";
import SkinSwitcher from "@/components/SkinSwitcher";
import ShareBannerEditor from "@/components/settings/ShareBannerEditor";
import SecuritySettings from "@/components/SecuritySettings";
import TokenManagement from "@/components/TokenManagement";
import McpConnectionPanel from "@/components/settings/McpConnectionPanel";
import DataManager from "@/components/DataManager";
import FolderSyncSettings from "@/components/settings/FolderSyncSettings";
import SyncSettingsTab from "@/components/settings/SyncSettingsTab";
import MobileAccountSettings from "@/components/settings/MobileAccountSettings";
import { isAndroidNativeRuntime, isMobileLocalMode } from "@/lib/mobileLocalMode";
import ShortcutSettingsPanel from "@/components/settings/ShortcutSettingsPanel";
import AutomationCenter from "@/components/automation/AutomationCenter";
// Same component the build aliases @/components/AISettingsPanel to (vite.config.ts); imported directly so it can host serverSettings.
import AISettingsPanel from "@/components/AISettingsReliabilityShell";
import UserManagement from "@/components/UserManagement";
import WorkspaceManagement from "@/components/WorkspaceManagement";
import WhatsNewModal from "@/components/WhatsNewModal";
import AuthorStoryModal from "@/components/AuthorStoryModal";
import DownloadPanel from "@/components/DownloadPanel";
import AppGalleryDownloadLink from "@/components/settings/AppGalleryDownloadLink";
import PreferencesPanel, { type PreferencesPanelNavigationRequest } from "@/components/settings/preferences/PreferencesPanel";
import { revealSettingsTarget } from "@/components/settings/preferences/revealSettingsTarget";
import type { RelatedSettingsTab } from "@/components/settings/preferences/preferenceSearch";
import { formatTimeZonePreview } from "@/lib/timeZones";
import AIMemoryArchiveSetting from "@/components/settings/AIMemoryArchiveSetting";
import { useSiteSettings, BUILTIN_FONTS, getBuiltinFontName } from "@/hooks/useSiteSettings";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { useSidebarTextStyle } from "@/hooks/useSidebarTextStyle";
import { useKnowledgeTreeDisplaySize } from "@/hooks/useKnowledgeTreeDisplaySize";
import { normalizeSharePageWidth } from "@/lib/sharePageWidth";
import { api } from "@/lib/api";
import { isDesktop, checkForUpdates, onUpdaterStatus, getReleaseChannel, isPortableDesktop, type UpdaterPayload } from "@/lib/desktopBridge";
import { CustomFont } from "@/types";
import { cn } from "@/lib/utils";
import { detectShortcutSurface } from "@/lib/shortcutRegistry";
import HotUpdateStatusCard from "./settings/HotUpdateStatusCard";
import NowenEcosystemPanel from "./settings/NowenEcosystemPanel";
import {
  PlayfulSegmentedControl,
  SettingsBentoCard,
  SettingsTabHero,
} from "./settings/shell/SettingsVisualKit";
import {
  SettingsDesktopSidebar,
  SettingsMobileTopBar,
} from "./settings/shell/SettingsNavSidebar";
import {
  SETTINGS_NAV_GROUP_META,
  SETTINGS_TAB_META,
  type SettingsTabId,
} from "./settings/shell/settingsNavMeta";

type TabId = SettingsTabId;

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
    <SettingsBentoCard className="p-4 space-y-3 bg-gradient-to-br from-slate-50/85 via-white to-sky-50/45 dark:from-zinc-900/75 dark:via-zinc-900/55 dark:to-sky-950/25">
      <div className="relative flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className="inline-flex h-7 w-7 items-center justify-center rounded-xl bg-sky-500/12 text-sky-600 ring-1 ring-inset ring-sky-500/20 dark:text-sky-300">
            <Server size={14} />
          </span>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">版本信息</h3>
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 rounded-full",
              hasNewerRelease ? "bg-blue-500 animate-pulse" : isOutdated ? "bg-amber-500 animate-pulse" : "bg-emerald-500",
            )}
          />
        </div>
        <button
          type="button"
          onClick={handleRetry}
          disabled={loading}
          className="nowen-tactile-btn inline-flex items-center gap-1 rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:border-accent-primary/40 hover:text-accent-primary disabled:opacity-50 dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-300"
          title="重新拉取"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          {loading ? "检查中" : "重新检查"}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        {/* 客户端 */}
        <div className="rounded-lg border border-zinc-200/70 dark:border-zinc-800/80 bg-white/80 dark:bg-zinc-900/60 px-3 py-2">
          <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>当前客户端</span>
            <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
              {typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")
                ? "Desktop"
                : desktop
                  ? "Desktop"
                  : "Web"}
            </span>
          </div>
          <div className="mt-1 font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">
            v{clientVersion}
          </div>
        </div>

        {/* 服务端 */}
        <div className="rounded-lg border border-zinc-200/70 dark:border-zinc-800/80 bg-white/80 dark:bg-zinc-900/60 px-3 py-2">
          <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>服务端</span>
            {isOutdated ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                需刷新
              </span>
            ) : serverVersion ? (
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                匹配
              </span>
            ) : null}
          </div>
          <div className="mt-1 font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">
            {serverError ? (
              <span className="text-amber-500">unknown</span>
            ) : serverVersion ? (
              <>v{serverVersion}</>
            ) : (
              <span className="text-zinc-400">—</span>
            )}
          </div>
        </div>

        {/* GitHub 最新 release */}
        <div className="rounded-lg border border-zinc-200/70 dark:border-zinc-800/80 bg-white/80 dark:bg-zinc-900/60 px-3 py-2">
          <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>最新发布</span>
            {hasNewerRelease ? (
              <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                可升级
              </span>
            ) : release?.available ? (
              <span className="rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                最新
              </span>
            ) : null}
          </div>
          <div className="mt-1 font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate tabular-nums">
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
          </div>
        </div>
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
    </SettingsBentoCard>
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

function AboutPanel({ onOpenEcosystem }: { onOpenEcosystem?: () => void }) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const contactEmail = "nowenlab@qq.com";
  const feedbackMailto = `mailto:${contactEmail}?subject=${encodeURIComponent("[Nowen Note 反馈]")}`;
  const feedbackQqGroupNumber = "1093473044";
  const [showSponsor, setShowSponsor] = useState(false);
  const [sponsorMethod, setSponsorMethod] = useState<"wechat" | "alipay">("wechat");
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [showAuthorStory, setShowAuthorStory] = useState(false);
  // 赞赏码 / 社群码大图预览 Lightbox
  const [sponsorPreviewOpen, setSponsorPreviewOpen] = useState(false);
  const [feedbackQqPreviewOpen, setFeedbackQqPreviewOpen] = useState(false);
  const [communityPreviewOpen, setCommunityPreviewOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [qqCopied, setQqCopied] = useState(false);
  const [logoCheers, setLogoCheers] = useState(0);
  const [logoBooped, setLogoBooped] = useState(false);
  const sponsorImage = sponsorMethod === "wechat" ? wechatSponsorQr : alipaySponsorQr;
  const sponsorLabel = sponsorMethod === "wechat"
    ? t('about.sponsorWechat')
    : t('about.sponsorAlipay');

  const handleCopyShare = () => {
    const text = t('about.shareText');
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(() => {
        setShareCopied(true);
        window.setTimeout(() => setShareCopied(false), 2200);
      }).catch(() => {});
    }
  };

  const handleCopyQq = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(feedbackQqGroupNumber).then(() => {
        setQqCopied(true);
        window.setTimeout(() => setQqCopied(false), 2000);
      }).catch(() => {});
    }
  };

  const highlights = [
    {
      key: "featureEditor",
      titleKey: "featureEditorTitle",
      Icon: FileText,
      iconTone: "from-sky-400/20 to-blue-500/15 text-sky-700 ring-sky-500/20 dark:text-sky-300",
      cardTint: "from-sky-500/[0.04] via-white to-white dark:from-sky-500/[0.06] dark:via-zinc-900/60 dark:to-zinc-900/60 hover:border-sky-400/45",
    },
    {
      key: "featureAI",
      titleKey: "featureAITitle",
      Icon: Bot,
      iconTone: "from-fuchsia-400/20 to-violet-500/15 text-fuchsia-700 ring-fuchsia-500/20 dark:text-fuchsia-300",
      cardTint: "from-fuchsia-500/[0.04] via-white to-white dark:from-fuchsia-500/[0.06] dark:via-zinc-900/60 dark:to-zinc-900/60 hover:border-fuchsia-400/45",
    },
    {
      key: "featureSelfHost",
      titleKey: "featureSelfHostTitle",
      Icon: Shield,
      iconTone: "from-emerald-400/20 to-teal-500/15 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
      cardTint: "from-emerald-500/[0.04] via-white to-white dark:from-emerald-500/[0.06] dark:via-zinc-900/60 dark:to-zinc-900/60 hover:border-emerald-400/45",
    },
    {
      key: "featureSync",
      titleKey: "featureSyncTitle",
      Icon: WifiOff,
      iconTone: "from-indigo-400/20 to-cyan-500/15 text-indigo-700 ring-indigo-500/20 dark:text-indigo-300",
      cardTint: "from-indigo-500/[0.04] via-white to-white dark:from-indigo-500/[0.06] dark:via-zinc-900/60 dark:to-zinc-900/60 hover:border-indigo-400/45",
    },
    {
      key: "featureClipper",
      titleKey: "featureClipperTitle",
      Icon: Layers,
      iconTone: "from-amber-400/20 to-orange-500/15 text-amber-700 ring-amber-500/20 dark:text-amber-300",
      cardTint: "from-amber-500/[0.04] via-white to-white dark:from-amber-500/[0.06] dark:via-zinc-900/60 dark:to-zinc-900/60 hover:border-amber-400/45",
    },
    {
      key: "featureMindMap",
      titleKey: "featureMindMapTitle",
      Icon: Blocks,
      iconTone: "from-cyan-400/20 to-sky-500/15 text-cyan-700 ring-cyan-500/20 dark:text-cyan-300",
      cardTint: "from-cyan-500/[0.04] via-white to-white dark:from-cyan-500/[0.06] dark:via-zinc-900/60 dark:to-zinc-900/60 hover:border-cyan-400/45",
    },
  ];

  return (
    <div className="space-y-5 pb-2">
      {/* 1. 品牌极光名片 Hero — 第一眼建立信任感 + 核心增长 CTA */}
      <motion.section
        initial={reducedMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 28 }}
        className="relative overflow-hidden rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-500/[0.10] via-white to-indigo-500/[0.08] p-5 shadow-sm dark:border-sky-400/20 dark:from-sky-500/[0.14] dark:via-zinc-900/80 dark:to-fuchsia-500/[0.10]"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-gradient-to-br from-sky-400/25 to-indigo-500/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-14 -left-10 h-36 w-36 rounded-full bg-gradient-to-tr from-fuchsia-400/15 to-cyan-400/20 blur-3xl"
        />

        <div className="relative flex flex-col items-center text-center">
          {/* 品牌 Logo + 俏皮连击打 call 彩蛋 + 版本胶囊 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setLogoCheers((c) => c + 1);
                setLogoBooped(true);
                window.setTimeout(() => setLogoBooped(false), 180);
              }}
              title="点一下给 Nowen 打 call"
              className={cn(
                "nowen-playful-emblem relative rounded-2xl p-0.5 bg-white/80 dark:bg-zinc-900/80 ring-1 ring-black/5 dark:ring-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
                logoBooped && "nowen-playful-emblem--booped",
              )}
            >
              <img
                src="/nowen-note-icon.svg"
                alt={t('about.appName')}
                className="h-16 w-16 rounded-2xl"
                draggable={false}
              />
              {!reducedMotion && logoCheers > 0 && (
                <span key={logoCheers} aria-hidden className="pointer-events-none absolute inset-0 overflow-visible">
                  {[
                    { x: -26, y: -22, color: "#6366f1" },
                    { x: 0, y: -32, color: "#38bdf8" },
                    { x: 26, y: -22, color: "#f472b6" },
                    { x: -22, y: 14, color: "#f59e0b" },
                    { x: 22, y: 14, color: "#34d399" },
                  ].map((spark, idx) => (
                    <span
                      key={idx}
                      className="nowen-sparkle-burst absolute left-1/2 top-1/2 h-2 w-2 rounded-full"
                      style={{
                        backgroundColor: spark.color,
                        ["--spark-x" as string]: `${spark.x}px`,
                        ["--spark-y" as string]: `${spark.y}px`,
                      }}
                    />
                  ))}
                </span>
              )}
            </button>
            <span className="pointer-events-none absolute -bottom-1.5 -right-2.5 rounded-full bg-accent-primary px-2 py-0.5 font-mono text-[10px] font-semibold text-white shadow-sm ring-2 ring-white dark:ring-zinc-900">
              v{__APP_VERSION__}
            </span>
            {logoCheers > 0 && (
              <span className="pointer-events-none absolute -top-2 -left-10 whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300">
                ✨ ×{logoCheers}
              </span>
            )}
          </div>

          <span className="mt-4 inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-700 ring-1 ring-inset ring-sky-500/20 dark:text-sky-300">
            <Sparkles size={11} aria-hidden />
            {t('about.heroBadge')}
          </span>

          <h2 className="mt-2 text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {t('about.appName')}
          </h2>
          <p className="mt-1 max-w-lg text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {t('about.slogan')}
          </p>
          <p className="mt-2 max-w-xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            {t('about.description')}
          </p>

          {/* 3 枚信任差异化徽章 */}
          <div className="mt-3.5 flex flex-wrap items-center justify-center gap-1.5">
            {[
              { label: t('about.trustOwned'), tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
              { label: t('about.trustOffline'), tone: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
              { label: t('about.trustAiEco'), tone: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
            ].map((badge) => (
              <span
                key={badge.label}
                className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium", badge.tone)}
              >
                <Check size={11} aria-hidden />
                {badge.label}
              </span>
            ))}
          </div>

          {/* 黄金转化 CTA 按钮行：GitHub Star + 一键安利给朋友 */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <a
              href="https://github.com/cropflre/nowen-note"
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex h-9 items-center gap-1.5 rounded-xl bg-zinc-900 px-4 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:bg-zinc-800 hover:shadow motion-safe:hover:-translate-y-0.5 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              <Star size={14} className="text-amber-400 fill-amber-400 transition-transform duration-200 motion-safe:group-hover:scale-110 motion-safe:group-hover:rotate-12" aria-hidden />
              {t('about.starOnGithub')}
              <ArrowUpRight size={13} className="opacity-70" aria-hidden />
            </a>
            <button
              type="button"
              onClick={handleCopyShare}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3.5 text-xs font-medium shadow-xs transition-all duration-200 motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
                shareCopied
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-zinc-200/90 bg-white/90 text-zinc-700 hover:border-accent-primary/40 hover:text-accent-primary dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200",
              )}
            >
              {shareCopied ? <Check size={14} aria-hidden /> : <Share2 size={14} aria-hidden />}
              {shareCopied ? t('about.shareCopied') : t('about.shareApp')}
            </button>
          </div>

          {/* 快捷官方直达入口条 */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-zinc-200/60 pt-3 dark:border-zinc-800/70">
            <a
              href="https://nowen.cn/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-zinc-600 hover:text-accent-primary dark:text-zinc-400 dark:hover:text-accent-primary transition-colors"
            >
              <Globe size={12} aria-hidden />
              {t('about.website')}
              <ExternalLink size={11} aria-hidden />
            </a>
            <a
              href="https://apps.microsoft.com/detail/9MZ7Z6S39LL3"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-zinc-600 hover:text-accent-primary dark:text-zinc-400 dark:hover:text-accent-primary transition-colors"
            >
              <Download size={12} aria-hidden />
              {t('about.microsoftStoreDownload')}
              <ExternalLink size={11} aria-hidden />
            </a>
            <AppGalleryDownloadLink className="inline-flex items-center gap-1 text-xs text-zinc-600 hover:text-accent-primary dark:text-zinc-400 dark:hover:text-accent-primary transition-colors" />
          </div>

          {import.meta.env.MODE === "harmony" && (
            <div className="mt-3 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              <p>{t('about.appFilingNumber')}</p>
              <a
                href="https://beian.miit.gov.cn/"
                onClick={async (event) => {
                  event.preventDefault();
                  await Browser.open({ url: "https://beian.miit.gov.cn/" });
                }}
                className="inline-flex items-center gap-1 hover:text-accent-primary transition-colors"
              >
                粤ICP备2026067978号-2A
                <ExternalLink size={11} />
              </a>
            </div>
          )}
        </div>
      </motion.section>

      {/* 2. 核心竞争力 2×3 价值矩阵 */}
      <section className="space-y-2.5">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('about.features')}</h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{t('about.featuresSubtitle')}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {highlights.map(({ key, titleKey, Icon, iconTone, cardTint }) => (
            <SettingsBentoCard
              key={key}
              as="div"
              interactive
              className={cn(
                "group/feat flex items-start gap-3 bg-gradient-to-br p-3 hover:border-zinc-300/80 dark:hover:border-zinc-700/80",
                cardTint,
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ring-1 ring-inset transition-transform duration-200 motion-safe:group-hover/feat:scale-110 motion-safe:group-hover/feat:-rotate-6",
                  iconTone,
                )}
              >
                <Icon size={15} />
              </span>
              <div className="relative z-10 min-w-0">
                <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{t(`about.${titleKey}`)}</div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">{t(`about.${key}`)}</p>
              </div>
            </SettingsBentoCard>
          ))}
        </div>
      </section>

      {/* 3. 弄文生态家族快捷跳转卡 */}
      {onOpenEcosystem && (
        <button
          type="button"
          onClick={onOpenEcosystem}
          className="nowen-settings-card nowen-settings-card--interactive group/eco flex w-full items-center justify-between gap-3 rounded-2xl border-indigo-500/25 bg-gradient-to-r from-indigo-500/[0.08] via-sky-500/[0.06] to-emerald-500/[0.08] p-4 text-left hover:border-indigo-400/50 dark:from-indigo-500/[0.13] dark:via-sky-500/[0.08] dark:to-emerald-500/[0.11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/25 to-emerald-500/20 text-indigo-600 ring-1 ring-inset ring-indigo-500/25 transition-transform duration-200 motion-safe:group-hover/eco:scale-110 motion-safe:group-hover/eco:-rotate-6 dark:text-indigo-300"
            >
              <Rocket size={18} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <span>{t("ecosystem.aboutPromoTitle")}</span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                {t("ecosystem.aboutPromoDesc")}
              </p>
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-colors group-hover/eco:bg-indigo-600">
            <span>{t("ecosystem.aboutPromoAction")}</span>
            <ArrowUpRight size={13} className="transition-transform motion-safe:group-hover/eco:translate-x-0.5 motion-safe:group-hover/eco:-translate-y-0.5" aria-hidden />
          </span>
        </button>
      )}

      {/* 4. 版本信息 & 在线更新卡（严格保留 DockerUpdateCenter 挂载契约） */}
      <div className="space-y-3">
        <VersionCompareCard />
        <HotUpdateStatusCard />
      </div>

      {/* 4. 情感连接与透明演进：作者感言 + 更新日志 双列卡片 */}
      <section className="space-y-2.5">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('about.storySectionTitle')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => setShowAuthorStory(true)}
            className="nowen-settings-card nowen-settings-card--interactive group/story flex items-start justify-between gap-3 rounded-2xl border-amber-500/20 bg-gradient-to-br from-amber-500/[0.08] via-white to-orange-500/[0.04] p-4 text-left hover:border-amber-400/50 dark:from-amber-500/[0.10] dark:via-zinc-900/70 dark:to-orange-500/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            <div className="flex items-start gap-3 min-w-0">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400/25 to-orange-500/15 text-amber-700 ring-1 ring-inset ring-amber-500/25 transition-transform duration-200 motion-safe:group-hover/story:scale-110 motion-safe:group-hover/story:-rotate-6 dark:text-amber-300">
                <BookOpen size={17} aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {t('about.authorStory')}
                  <ArrowUpRight size={13} className="text-amber-600/70 transition-transform motion-safe:group-hover/story:translate-x-0.5 motion-safe:group-hover/story:-translate-y-0.5 dark:text-amber-300/70" aria-hidden />
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {t('about.authorStoryDesc')}
                </p>
                <span className="mt-2 inline-flex items-center text-[11px] font-medium text-amber-700 dark:text-amber-300">
                  {t('about.authorStoryAction')} →
                </span>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setShowWhatsNew(true)}
            className="nowen-settings-card nowen-settings-card--interactive group/log flex items-start justify-between gap-3 rounded-2xl border-indigo-500/20 bg-gradient-to-br from-indigo-500/[0.08] via-white to-violet-500/[0.04] p-4 text-left hover:border-indigo-400/50 dark:from-indigo-500/[0.10] dark:via-zinc-900/70 dark:to-violet-500/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <div className="flex items-start gap-3 min-w-0">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-400/25 to-violet-500/15 text-indigo-700 ring-1 ring-inset ring-indigo-500/25 transition-transform duration-200 motion-safe:group-hover/log:scale-110 motion-safe:group-hover/log:-rotate-6 dark:text-indigo-300">
                <Sparkles size={17} aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {t('about.changelog')}
                  <ArrowUpRight size={13} className="text-indigo-600/70 transition-transform motion-safe:group-hover/log:translate-x-0.5 motion-safe:group-hover/log:-translate-y-0.5 dark:text-indigo-300/70" aria-hidden />
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {t('about.changelogDesc')}
                </p>
                <span className="mt-2 inline-flex items-center text-[11px] font-medium text-indigo-700 dark:text-indigo-300">
                  {t('about.viewChangelog')} →
                </span>
              </div>
            </div>
          </button>
        </div>
      </section>

      {/* 5. 社区阵地（公众号 + QQ 群双列 Bento 卡） */}
      <section className="space-y-2.5">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('about.communitySectionTitle')}</h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{t('about.communitySectionSubtitle')}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* Nowen 开源实验室公众号 */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.06] via-white to-teal-500/[0.03] p-4 shadow-xs dark:from-emerald-500/[0.08] dark:via-zinc-900/70 dark:to-teal-500/[0.04]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <Compass size={15} className="text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden />
                <span className="truncate">{t('about.communityQrTitle')}</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                {t('about.communityQrDesc')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCommunityPreviewOpen(true)}
              className="group relative shrink-0 overflow-hidden rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-black/5 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              title={t('about.communityQrTitle')}
              aria-label={t('about.communityQrTitle')}
            >
              <img
                src={communityQr}
                alt={t('about.communityQrTitle')}
                className="h-20 w-20 object-contain transition-transform duration-200 group-hover:scale-105"
                loading="lazy"
                draggable={false}
              />
            </button>
          </div>

          {/* QQ 群反馈 */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-500/[0.06] via-white to-blue-500/[0.03] p-4 shadow-xs dark:from-sky-500/[0.08] dark:via-zinc-900/70 dark:to-blue-500/[0.04]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <Users size={15} className="text-sky-600 dark:text-sky-400 shrink-0" aria-hidden />
                <span className="truncate">{t('about.feedbackQqGroup')}</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                {t('about.feedbackQqGroupDesc')}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-sky-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-sky-700 dark:text-sky-300">
                  {t('about.feedbackQqGroupNumber', { number: feedbackQqGroupNumber })}
                </span>
                <button
                  type="button"
                  onClick={handleCopyQq}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-sky-500/10 hover:text-sky-700 dark:text-zinc-400 dark:hover:text-sky-300 transition-colors"
                >
                  {qqCopied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
                  {qqCopied ? t('about.copiedQqNumber') : t('about.copyQqNumber')}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setFeedbackQqPreviewOpen(true)}
              className="group relative shrink-0 overflow-hidden rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-black/5 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              title={t('about.feedbackQqGroup')}
              aria-label={t('about.feedbackQqGroup')}
            >
              <img
                src={qqGroupQr}
                alt={t('about.feedbackQqGroupNumber', { number: feedbackQqGroupNumber })}
                className="h-20 w-20 object-cover transition-transform duration-200 group-hover:scale-105"
                loading="lazy"
                draggable={false}
              />
            </button>
          </div>
        </div>
      </section>

      {/* 6. 温暖情感高光卡：支持持续开源 / 打赏 */}
      <div className="relative overflow-hidden rounded-2xl border border-rose-500/25 bg-gradient-to-br from-rose-500/[0.08] via-white to-amber-500/[0.06] shadow-xs dark:from-rose-500/[0.12] dark:via-zinc-900/75 dark:to-amber-500/[0.08]">
        <button
          type="button"
          onClick={() => setShowSponsor((v) => !v)}
          className="group/sponsor w-full flex items-center justify-between gap-3 p-4 hover:bg-rose-500/[0.04] transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500/20 to-amber-500/20 text-rose-600 ring-1 ring-inset ring-rose-500/25 transition-transform duration-200 motion-safe:group-hover/sponsor:scale-110 dark:text-rose-300">
              <Heart size={18} fill="currentColor" aria-hidden />
            </span>
            <div className="min-w-0 text-left">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('about.sponsor')}
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                {t('about.sponsorDesc')}
              </div>
            </div>
          </div>
          <span className="shrink-0 rounded-xl bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-transform duration-150 group-hover/sponsor:bg-rose-600">
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
              <div className="px-4 pb-5 pt-3 flex flex-col items-center gap-3 border-t border-rose-200/60 dark:border-rose-900/40">
                <div
                  className="nowen-segmented-track grid w-full max-w-xs grid-cols-2 rounded-xl p-1"
                  role="tablist"
                  aria-label={t('about.sponsorMethod')}
                >
                  {(["wechat", "alipay"] as const).map((method) => {
                    const selected = sponsorMethod === method;
                    return (
                      <button
                        key={method}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => setSponsorMethod(method)}
                        className={cn(
                          "relative z-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                          selected
                            ? "text-white"
                            : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                        )}
                      >
                        {selected && (
                          <motion.span
                            layoutId="nowen-sponsor-method-pill"
                            transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42, mass: 0.8 }}
                            aria-hidden
                            className={cn(
                              "absolute inset-0 -z-10 rounded-lg shadow-sm",
                              method === "wechat" ? "bg-emerald-500" : "bg-blue-500",
                            )}
                          />
                        )}
                        <span className="relative z-10">
                          {method === "wechat" ? t('about.sponsorWechat') : t('about.sponsorAlipay')}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => setSponsorPreviewOpen(true)}
                  className="group relative rounded-xl overflow-hidden cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                  title={sponsorLabel}
                  aria-label={sponsorLabel}
                >
                  <img
                    src={sponsorImage}
                    alt={sponsorLabel}
                    className="w-44 sm:w-52 max-h-72 object-contain rounded-xl bg-white p-2 shadow-sm transition-transform duration-200 group-hover:scale-[1.02]"
                    loading="lazy"
                    draggable={false}
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors">
                    <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-2 py-1 rounded-md bg-black/60 text-white text-[11px]">
                      <ZoomIn size={12} />
                      点击放大
                    </span>
                  </span>
                </button>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 text-center">
                  {sponsorMethod === "wechat"
                    ? t('about.sponsorWechatTip')
                    : t('about.sponsorAlipayTip')}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 7. 联系与合作（紧凑双列） */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <a
          href={feedbackMailto}
          className="group/mail flex items-center gap-3 rounded-xl border border-zinc-200/80 bg-zinc-50/60 p-3.5 text-left transition-all duration-200 hover:border-sky-400/45 hover:bg-white hover:shadow-xs dark:border-zinc-800/80 dark:bg-zinc-900/50 dark:hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400" aria-hidden>
            <Mail size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
              <span>{t('about.feedback')}</span>
              <ArrowUpRight size={12} className="text-zinc-400 group-hover/mail:text-sky-500" aria-hidden />
            </div>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">{t('about.feedbackDesc')}</p>
          </div>
        </a>

        <a
          href={`mailto:${contactEmail}`}
          className="group/biz flex items-center gap-3 rounded-xl border border-zinc-200/80 bg-zinc-50/60 p-3.5 text-left transition-all duration-200 hover:border-accent-primary/45 hover:bg-white hover:shadow-xs dark:border-zinc-800/80 dark:bg-zinc-900/50 dark:hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary" aria-hidden>
            <Building2 size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 text-xs font-semibold text-tx-primary">
              <span>{t('about.businessPartnerships')}</span>
              <ArrowUpRight size={12} className="text-zinc-400 group-hover/biz:text-accent-primary" aria-hidden />
            </div>
            <div className="mt-0.5 truncate text-[11px] text-tx-secondary">{contactEmail}</div>
          </div>
        </a>
      </div>

      {/* 8. 开源协议与底部收尾 */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200/70 bg-zinc-50/50 px-4 py-3 text-xs dark:border-zinc-800/70 dark:bg-zinc-900/40">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">{t('about.openSource')}</span>
          <span>·</span>
          <a
            href="https://github.com/cropflre/nowen-note/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-accent-primary hover:underline transition-colors"
          >
            {t('about.license')}
          </a>
        </div>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
          {t('about.madeWith')}
        </span>
      </div>

      {/* 更新日志 Modal */}
      <WhatsNewModal
        open={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
      />

      {/* 作者感言 Modal */}
      <AuthorStoryModal
        open={showAuthorStory}
        onClose={() => setShowAuthorStory(false)}
      />

      {communityPreviewOpen && (
        <ImageLightbox
          src={communityQr}
          alt={t('about.communityQrTitle')}
          onClose={() => setCommunityPreviewOpen(false)}
        />
      )}

      {feedbackQqPreviewOpen && (
        <ImageLightbox
          src={qqGroupQr}
          alt={t('about.feedbackQqGroupNumber', { number: feedbackQqGroupNumber })}
          onClose={() => setFeedbackQqPreviewOpen(false)}
        />
      )}

      {sponsorPreviewOpen && (
        <ImageLightbox
          src={sponsorImage}
          alt={sponsorLabel}
          onClose={() => setSponsorPreviewOpen(false)}
        />
      )}
    </div>
  );
}

function AppearancePanel({ onOpenTimeZone }: { onOpenTimeZone?: () => void }) {
  const { t, i18n } = useTranslation();
  const { siteConfig, updateSiteConfig, updateEditorFont, isLoaded } = useSiteSettings();
  const { prefs: userPrefs, setPref: setUserPref } = useUserPreferences();
  const [sidebarTextStyle, setSidebarTextStyle] = useSidebarTextStyle();
  const [treeDisplaySize, setTreeDisplaySize] = useKnowledgeTreeDisplaySize();
  const [title, setTitle] = useState(siteConfig.title);
  const [previewIcon, setPreviewIcon] = useState(siteConfig.favicon);
  const [shareFooterText, setShareFooterText] = useState(siteConfig.shareFooterText);
  const [sharePageWidth, setSharePageWidth] = useState(siteConfig.sharePageWidth);
  const [shareBanner, setShareBanner] = useState({ enabled: siteConfig.shareBannerEnabled, image: siteConfig.shareBannerImage });
  useEffect(() => setShareBanner({ enabled: siteConfig.shareBannerEnabled, image: siteConfig.shareBannerImage }), [siteConfig.shareBannerEnabled, siteConfig.shareBannerImage]);
  useEffect(() => setSharePageWidth(siteConfig.sharePageWidth), [siteConfig.sharePageWidth]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  // 等待真实配置填充表单，避免仅修改横幅时把原品牌覆盖为初始占位值。
  useEffect(() => {
    if (!isLoaded) return;
    setTitle(siteConfig.title);
    setPreviewIcon(siteConfig.favicon);
    setShareFooterText(siteConfig.shareFooterText);
  }, [isLoaded, siteConfig.title, siteConfig.favicon, siteConfig.shareFooterText]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 站点标识属于全站共享配置，只有系统管理员能改。
  // 这里独立拉一次身份（不依赖父组件传 props），与 DataManager 的做法保持一致，
  // 避免修改 SettingsModal 主体的渲染契约。
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => { if (!cancelled) setIsAdmin((u as { role?: string })?.role === "admin"); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, []);

  const canEditSiteIdentity = isAdmin && isLoaded && !isSaving;

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
      await updateSiteConfig(title.trim(), previewIcon, shareFooterText.trim(), sharePageWidth, shareBanner);
      setShareFooterText(shareFooterText.trim());
      setSaveMessage(t('settings.saveSuccess'));
      setTimeout(() => setSaveMessage(""), 2000);
    } catch {
      setSaveMessage(t('settings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = title !== siteConfig.title || previewIcon !== siteConfig.favicon || shareFooterText !== siteConfig.shareFooterText || sharePageWidth !== siteConfig.sharePageWidth || shareBanner.enabled !== siteConfig.shareBannerEnabled || shareBanner.image !== siteConfig.shareBannerImage;

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      setUploadMessage(msg || t('settings.fontUploadFailed'));
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

  const previewFontSizePx = userPrefs.editorFontSize > 0 ? userPrefs.editorFontSize : 14;
  const isCompactDensity = userPrefs.readingDensity === "compact";

  return (
    <div className="space-y-4 pb-2">
      {/* 1. 快捷双控 Bento：明暗模式 + 界面语言 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SettingsBentoCard interactive className="flex items-center justify-between gap-3 p-3.5">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{t('settings.themeMode')}</div>
            <div className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.themeModeDesc')}</div>
          </div>
          <div className="shrink-0">
            <ThemeToggle />
          </div>
        </SettingsBentoCard>

        <SettingsBentoCard interactive className="flex items-center justify-between gap-3 p-3.5">
          <div className="flex items-center gap-2 min-w-0">
            <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-sky-500/12 text-sky-600 ring-1 ring-inset ring-sky-500/20 dark:text-sky-300">
              <Globe size={14} />
            </span>
            <span className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">{t('language.label')}</span>
          </div>
          <PlayfulSegmentedControl
            layoutId="nowen-appearance-lang-pill"
            ariaLabel={t('language.label')}
            value={(i18n.resolvedLanguage || i18n.language) === "en" ? "en" : "zh-CN"}
            onChange={(code) => {
              try { localStorage.setItem("i18nextLng", code); } catch { /* ignore storage quota */ }
              void i18n.changeLanguage(code);
            }}
            options={[
              { value: "zh-CN", label: t('language.zh') },
              { value: "en", label: t('language.en') },
            ]}
          />
        </SettingsBentoCard>
      </div>

      {/* 应用时区状态预览与快速跳转 */}
      {(() => {
        const activeLocale = i18n.resolvedLanguage || i18n.language || "zh-CN";
        const tzPreview = formatTimeZonePreview(userPrefs.timeZone, activeLocale);
        const modeLabel = tzPreview.isAuto
          ? t("preferences.items.timeZone.autoLabel", { defaultValue: "跟随系统" })
          : tzPreview.effectiveTimeZone;
        return (
          <SettingsBentoCard interactive className="flex flex-wrap items-center justify-between gap-3 p-3.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-cyan-500/12 text-cyan-600 ring-1 ring-inset ring-cyan-500/20 dark:text-cyan-300">
                <Clock size={14} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    {t("preferences.items.timeZone.title", { defaultValue: "应用时区" })}
                  </span>
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {modeLabel} · {tzPreview.offsetLabel}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                  {t("preferences.items.timeZone.currentPreview", {
                    defaultValue: `当前时间：${tzPreview.formattedTime}（${tzPreview.effectiveTimeZone} · ${tzPreview.offsetLabel}）`,
                    time: tzPreview.formattedTime,
                    zone: tzPreview.effectiveTimeZone,
                    offset: tzPreview.offsetLabel,
                  })}
                </div>
              </div>
            </div>
            {onOpenTimeZone && (
              <button
                type="button"
                data-appearance-timezone-jump
                onClick={onOpenTimeZone}
                className="nowen-tactile-btn inline-flex shrink-0 items-center gap-1 rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:border-accent-primary/40 hover:text-accent-primary dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
              >
                {t("preferences.items.timeZone.appearanceAction", { defaultValue: "更改时区" })}
              </button>
            )}
          </SettingsBentoCard>
        );
      })()}

      {/* 2. 外观风格（Skin）：视觉主题选择 */}
      <SettingsBentoCard className="p-4 space-y-3">
        <div className="relative">
          <div className="flex items-center gap-1.5">
            <Sparkles size={14} className="text-indigo-500" aria-hidden />
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {t('appearance.skinTitle', { defaultValue: '外观风格' })}
            </h4>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {t('appearance.skinDesc', { defaultValue: '选择整体视觉语言。macOS 风格在 Apple 设备上体验最佳。' })}
          </p>
        </div>
        <div className="relative">
          <SkinSwitcher />
        </div>
      </SettingsBentoCard>

      {/* 3. 阅读与排版工作室（字体 + 默认字号 + 阅读密度 + 实时预览） */}
      <SettingsBentoCard className="!overflow-visible">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200/60 bg-gradient-to-r from-violet-500/[0.06] via-transparent to-transparent px-4 py-3 rounded-t-2xl dark:border-zinc-800/70">
          <div className="flex items-center gap-2 min-w-0">
            <span
              aria-hidden
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400/20 to-indigo-500/15 text-violet-700 ring-1 ring-inset ring-violet-500/20 dark:text-violet-300"
            >
              <Type size={14} />
            </span>
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('settings.readingStudioTitle', { defaultValue: '阅读与排版' })}
              </h4>
              <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {t('settings.readingStudioDesc', { defaultValue: '调节字体、字号与段落密度，下方实时预览排版效果' })}
              </p>
            </div>
          </div>
          {isSwitchingFont && <Loader2 size={14} className="shrink-0 animate-spin text-accent-primary" />}
        </div>

        <div className="p-4 space-y-4">
          {/* 编辑器字体 + 导入字体包 */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.editorFont')}</span>
                <span className="ml-2 text-[11px] text-zinc-400 dark:text-zinc-500">{t('settings.editorFontDesc')}</span>
              </div>
              <button
                type="button"
                onClick={() => fontFileRef.current?.click()}
                disabled={isUploading}
                className="nowen-tactile-btn inline-flex h-7 items-center gap-1 rounded-xl border border-dashed border-zinc-300 px-2.5 text-[11px] font-medium text-zinc-600 hover:border-accent-primary/60 hover:text-accent-primary disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400"
              >
                {isUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                {t('settings.importFont')}
              </button>
              <input
                type="file"
                ref={fontFileRef}
                onChange={handleUploadFonts}
                accept=".otf,.otc,.ttc,.ttf,.woff,.woff2"
                multiple
                className="hidden"
              />
            </div>

            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setFontDropdownOpen(!fontDropdownOpen)}
                className="nowen-tactile-btn w-full flex items-center justify-between px-3 py-2 border border-zinc-200/90 dark:border-zinc-700 rounded-xl bg-white/90 dark:bg-zinc-900/90 text-sm text-zinc-900 dark:text-zinc-100 hover:border-accent-primary/50"
              >
                <span className="flex items-center gap-2 truncate">
                  <Type size={14} className="shrink-0 text-zinc-400" />
                  <span className="truncate">{currentFontName}</span>
                </span>
                <ChevronDown size={14} className={cn("shrink-0 text-zinc-400 transition-transform", fontDropdownOpen && "rotate-180")} />
              </button>

              <AnimatePresence>
                {fontDropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.98, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: -4 }}
                    transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                    className="absolute z-50 top-full left-0 mt-1.5 w-full max-h-64 overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-xl"
                  >
                    <div className="px-2 pt-2 pb-1">
                      <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2">{t('settings.builtinFonts')}</span>
                    </div>
                    {BUILTIN_FONTS.map(font => (
                      <button
                        key={font.id}
                        type="button"
                        onClick={() => handleSelectFont(font.id)}
                        className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                      >
                        <span style={{ fontFamily: font.family }}>{getBuiltinFontName(font)}</span>
                        {siteConfig.editorFontFamily === font.id && <Check size={14} className="text-accent-primary" />}
                      </button>
                    ))}

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
                              type="button"
                              onClick={() => handleSelectFont(font.id)}
                              className="flex-1 text-left text-sm text-zinc-700 dark:text-zinc-300"
                            >
                              {font.name}
                              <span className="ml-2 text-[10px] text-zinc-400">.{font.format}</span>
                            </button>
                            <div className="flex items-center gap-1.5">
                              {siteConfig.editorFontFamily === font.id && <Check size={14} className="text-accent-primary" />}
                              <button
                                type="button"
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('settings.importFontHint')}</span>
              {uploadMessage && (
                <span className={cn("text-xs", uploadSuccess ? "text-emerald-500" : "text-amber-500")}>{uploadMessage}</span>
              )}
            </div>
          </div>

          <div className="h-px bg-zinc-200/60 dark:bg-zinc-800/70" />

          {/* 默认字号 + 阅读密度 */}
          <div className="space-y-3.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  {t('settings.editorFontSize', { defaultValue: '编辑器默认字号' })}
                </div>
                <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('settings.editorFontSizeDesc', { defaultValue: '影响富文本正文、Markdown 源码和预览，仅改变显示，不修改笔记内容。' })}
                </p>
              </div>
              <PlayfulSegmentedControl
                layoutId="nowen-appearance-fontsize-pill"
                ariaLabel={t('settings.editorFontSize', { defaultValue: '编辑器默认字号' })}
                value={userPrefs.editorFontSize}
                onChange={(value) => setUserPref("editorFontSize", value as 0 | 14 | 16 | 18 | 20 | 22 | 24)}
                className="grid grid-cols-4 flex-shrink-0 sm:grid-cols-7"
                buttonClassName="min-w-8 px-2 max-sm:min-h-9"
                options={[
                  { value: 0, label: t('settings.fontSizeDefault', { defaultValue: '默认' }) },
                  ...([14, 16, 18, 20, 22, 24] as const).map(value => ({ value, label: String(value) })),
                ]}
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  {t('settings.readingDensity', { defaultValue: '阅读密度' })}
                </div>
                <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('settings.readingDensityDesc', { defaultValue: '调节正文段落和列表项的纵向间距，紧凑模式更省空间。' })}
                  {isAndroidNativeRuntime() && " · 开启同步后随账号保存"}
                </p>
              </div>
              <PlayfulSegmentedControl
                layoutId="nowen-appearance-density-pill"
                ariaLabel={t('settings.readingDensity', { defaultValue: '阅读密度' })}
                value={userPrefs.readingDensity}
                onChange={(code) => setUserPref("readingDensity", code)}
                className="self-start sm:self-auto"
                buttonClassName="px-3"
                options={[
                  { value: "cozy" as const, label: t('settings.densityCozy', { defaultValue: '宽松' }) },
                  { value: "compact" as const, label: t('settings.densityCompact', { defaultValue: '紧凑' }) },
                ]}
              />
            </div>
          </div>

          {/* 所见即所得实时排版预览 */}
          <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-zinc-50/75 dark:border-zinc-800 dark:bg-zinc-950/70">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/60 bg-white/75 px-3 py-1.5 text-[11px] dark:border-zinc-800/70 dark:bg-zinc-900/60">
              <span className="inline-flex items-center gap-1.5 font-medium text-zinc-500 dark:text-zinc-400">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t('settings.livePreviewLabel', { defaultValue: '实时排版预览' })}
              </span>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">{currentFontName}</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800 tabular-nums">
                  {userPrefs.editorFontSize > 0 ? `${userPrefs.editorFontSize}px` : t('settings.fontSizeDefault', { defaultValue: '默认' })}
                </span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                  {isCompactDensity ? t('settings.densityCompact', { defaultValue: '紧凑' }) : t('settings.densityCozy', { defaultValue: '宽松' })}
                </span>
              </div>
            </div>
            <div
              className={cn(
                "px-3.5 py-3 transition-all duration-150",
                isCompactDensity ? "space-y-1 leading-snug" : "space-y-2 leading-relaxed",
              )}
              style={{
                fontFamily: "var(--editor-font-family)",
                fontSize: `${previewFontSizePx}px`,
              }}
            >
              <p className="text-zinc-800 dark:text-zinc-200">{t('settings.fontPreviewZh')}</p>
              <p className="text-zinc-500 dark:text-zinc-400">{t('settings.fontPreviewEn')}</p>
            </div>
          </div>
        </div>
      </SettingsBentoCard>

      {/* 4. 界面显示与可读性（导航文字风格 + 知识树字号） */}
      <section className="space-y-2.5">
        <h4 className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
          {t('settings.interfaceDisplayTitle', { defaultValue: '界面显示与可读性' })}
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SettingsBentoCard interactive className="flex flex-col justify-between gap-3 p-3.5">
            <div>
              <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{t('settings.sidebarTextStyle')}</span>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.sidebarTextStyleDesc')}</p>
            </div>
            <PlayfulSegmentedControl
              layoutId="nowen-appearance-sidebar-style"
              ariaLabel={t('settings.sidebarTextStyle')}
              value={sidebarTextStyle}
              onChange={setSidebarTextStyle}
              fullWidth
              className="grid-cols-2"
              buttonClassName="min-h-8 px-3"
              options={[
                { value: "readable" as const, label: t('settings.sidebarTextReadable') },
                { value: "classic" as const, label: t('settings.sidebarTextClassic') },
              ]}
            />
          </SettingsBentoCard>

          <SettingsBentoCard interactive className="flex flex-col justify-between gap-3 p-3.5">
            <div>
              <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{t('settings.knowledgeTreeDisplaySize')}</span>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.knowledgeTreeDisplaySizeHint')}</p>
            </div>
            <PlayfulSegmentedControl
              layoutId="nowen-appearance-tree-size"
              ariaLabel={t('settings.knowledgeTreeDisplaySize')}
              value={treeDisplaySize}
              onChange={setTreeDisplaySize}
              fullWidth
              className="grid-cols-3"
              buttonClassName="min-h-10 px-2"
              options={[
                { value: "default" as const, label: t('settings.knowledgeTreeDisplaySize_default') },
                { value: "large" as const, label: t('settings.knowledgeTreeDisplaySize_large') },
                { value: "extra-large" as const, label: t('settings.knowledgeTreeDisplaySize_extra-large') },
              ]}
            />
          </SettingsBentoCard>
        </div>
      </section>

      {/* 5. 站点标识与分享页外观（全站共享配置） */}
      <SettingsBentoCard>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/60 bg-gradient-to-r from-amber-500/[0.05] via-transparent to-transparent px-4 py-3 dark:border-zinc-800/70">
          <div className="flex items-center gap-2 min-w-0">
            <span
              aria-hidden
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400/20 to-orange-500/15 text-amber-700 ring-1 ring-inset ring-amber-500/20 dark:text-amber-300"
            >
              <Building2 size={14} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('settings.siteIdentity')}</h3>
                <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                  {t('settings.siteIdentityScopeBadge', { defaultValue: '全站配置' })}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.siteIdentityDesc')}</p>
            </div>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {!isLoaded && (
            <p className="rounded-xl bg-zinc-100/80 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
              {t("settings.siteIdentityLoading")}
            </p>
          )}
          {!isAdmin && (
            <p className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {t('settings.siteIdentityAdminOnly')}
            </p>
          )}

          <div className="flex flex-col sm:flex-row gap-5 items-start">
            {/* Logo 上传区域 */}
            <div className="flex flex-col items-center gap-2 shrink-0">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('settings.siteIcon')}</span>
              <div
                className={cn(
                  "relative w-20 h-20 rounded-2xl border-2 border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-900/60 flex items-center justify-center overflow-hidden group transition-colors",
                  canEditSiteIdentity
                    ? "cursor-pointer hover:border-accent-primary"
                    : "cursor-not-allowed opacity-60"
                )}
                onClick={() => { if (canEditSiteIdentity) fileInputRef.current?.click(); }}
              >
                {previewIcon ? (
                  <img src={previewIcon} alt={t("settings.siteIcon")} className="w-full h-full object-cover" />
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
                disabled={!canEditSiteIdentity}
              />
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500">PNG/SVG · &lt;1MB</span>
                {previewIcon && isAdmin && (
                  <button
                    type="button"
                    onClick={handleRemoveIcon}
                    disabled={!canEditSiteIdentity}
                    className="text-[10px] text-red-500 hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('settings.remove')}
                  </button>
                )}
              </div>
            </div>

            {/* 站点名称 + 分享页宽度 + 页尾文字 */}
            <div className="flex-1 space-y-3 w-full min-w-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('settings.siteName')}</label>
                    <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 tabular-nums">{title.length}/20</span>
                  </div>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => { setTitle(e.target.value); setSaveMessage(""); }}
                    maxLength={20}
                    disabled={!canEditSiteIdentity}
                    className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all placeholder:text-zinc-400 disabled:opacity-60 disabled:cursor-not-allowed"
                    placeholder={t('settings.siteNamePlaceholder')}
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="site-share-page-width" className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('settings.sharePageWidth')}</label>
                  <select
                    id="site-share-page-width"
                    value={sharePageWidth}
                    onChange={(e) => { setSharePageWidth(normalizeSharePageWidth(e.target.value)); setSaveMessage(""); }}
                    disabled={!canEditSiteIdentity}
                    className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 outline-none disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {(["standard", "wide", "full"] as const).map(width => (
                      <option key={width} value={width}>{t(`settings.sharePageWidth_${width}`)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('settings.sharePageWidthHint')}</p>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor="site-share-footer-text" className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('settings.shareFooterText')}</label>
                  <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 tabular-nums">{shareFooterText.length}/100</span>
                </div>
                <input
                  id="site-share-footer-text"
                  type="text"
                  value={shareFooterText}
                  onChange={(e) => { setShareFooterText(e.target.value); setSaveMessage(""); }}
                  maxLength={100}
                  disabled={!canEditSiteIdentity}
                  className="w-full px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all placeholder:text-zinc-400 disabled:opacity-60 disabled:cursor-not-allowed"
                  placeholder={t("auditI18n.shareFooterPlaceholder")}
                />
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('settings.shareFooterTextHint')}</p>
              </div>
            </div>
          </div>

          <div className="border-t border-zinc-200/60 pt-3 dark:border-zinc-800/70">
            <ShareBannerEditor value={shareBanner} onChange={value => { setShareBanner(value); setSaveMessage(""); }} disabled={!canEditSiteIdentity} />
          </div>

          {isAdmin && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200/60 pt-3 dark:border-zinc-800/70">
              <div className="text-xs">
                {saveMessage ? (
                  <span className={saveMessage === t('settings.saveSuccess') ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-red-500"}>
                    {saveMessage}
                  </span>
                ) : hasChanges ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    {t('settings.unsavedChangesHint', { defaultValue: '有未保存的站点更改' })}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canEditSiteIdentity || !title.trim() || !hasChanges}
                className="nowen-tactile-btn inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent-primary px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-accent-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {t('settings.saveChanges')}
              </button>
            </div>
          )}
        </div>
      </SettingsBentoCard>
    </div>
  );
}

const SettingsModal = React.forwardRef<HTMLDivElement, SettingsModalProps>(
  function SettingsModal({ onClose, defaultTab = "appearance" }, ref) {
  const { t, i18n } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const [searchQuery, setSearchQuery] = useState("");
  const { siteConfig } = useSiteSettings();
  const shortcutSurface = detectShortcutSurface();
  const [currentUser, setCurrentUser] = useState<{ id: string; role?: string; username?: string; displayName?: string | null } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isEnglish = (i18n.resolvedLanguage || i18n.language || "").toLowerCase().startsWith("en");

  const fetchCurrentUser = useCallback(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => { if (!cancelled) setCurrentUser({ id: u.id, role: (u as { role?: string }).role, username: u.username, displayName: u.displayName }); })
      .catch(() => { if (!cancelled) setCurrentUser(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => fetchCurrentUser(), [fetchCurrentUser]);

  // 监听 token 变化，重新拉取当前用户（防止切换账号后残留旧用户信息）
  useEffect(() => {
    const onTokenChanged = () => { fetchCurrentUser(); };
    window.addEventListener("nowen:token-changed", onTokenChanged);
    return () => window.removeEventListener("nowen:token-changed", onTokenChanged);
  }, [fetchCurrentUser]);

  // 监听"DataManager 完成导入后请求关闭弹窗"事件——用户在 DataManager 里
  // 把笔记导入到 ≠ 当前侧边栏的工作区，点击"切换到该工作区查看"按钮后，需要
  // 把这层 Modal 也关掉，否则切到目标工作区但弹窗仍盖住主界面，体感很奇怪。
  useEffect(() => {
    const onCloseRequest = () => onClose();
    window.addEventListener("nowen:close-settings", onCloseRequest);
    return () => window.removeEventListener("nowen:close-settings", onCloseRequest);
  }, [onClose]);

  const isAdmin = currentUser?.role === "admin";
  const securityTabLabel = isAndroidNativeRuntime() ? t("mobileAccount.accountAndSecurity") : t('settings.security');

  // Options moved out of Preferences are reachable from its search and Advanced page:
  // switch to their tab, then bring the section into view once that panel has rendered.
  const contentRef = useRef<HTMLDivElement>(null);
  const [revealRequest, setRevealRequest] = useState<{ section: string } | null>(null);
  const [preferencesJumpRequest, setPreferencesJumpRequest] = useState<PreferencesPanelNavigationRequest | null>(null);
  const openRelatedSetting = useCallback((tab: RelatedSettingsTab, section: string) => {
    setActiveTab(tab);
    setRevealRequest({ section });
  }, []);
  const openTimeZonePreference = useCallback(() => {
    setRevealRequest(null);
    setActiveTab("preferences");
    setPreferencesJumpRequest((previous) => ({
      page: "layout",
      reveal: "timeZone",
      nonce: (previous?.nonce ?? 0) + 1,
    }));
  }, []);
  useEffect(() => {
    if (!revealRequest || !contentRef.current) return;
    return revealSettingsTarget(contentRef.current, `[data-settings-section="${revealRequest.section}"]`, { focus: true, timeoutMs: 8000 });
  }, [revealRequest]);
  // The phone tab strip scrolls sideways; keep the active tab visible, including after such a jump.
  const mobileTabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mobileTabsRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  // Press "/" outside inputs to jump into sidebar quick search; "Escape" inside search clears it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.activeElement === searchInputRef.current && searchQuery) {
        event.preventDefault();
        setSearchQuery("");
        return;
      }
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      // Don't hijack "/" when the shortcuts panel is recording or focus is inside an editor/input.
      if (activeTab === "shortcuts") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
        return;
      }
      if (searchInputRef.current && searchInputRef.current.offsetParent !== null) {
        event.preventDefault();
        searchInputRef.current.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, searchQuery]);

  const handleSelectTab = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
    setRevealRequest(null);
    setPreferencesJumpRequest(null);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  const SETTING_TABS = [
    { id: "appearance" as const, label: t('settings.appearance'), icon: Palette },
    { id: "preferences" as const, label: t('settings.preferences'), icon: SlidersHorizontal },
    ...(shortcutSurface !== "android" ? [{ id: "shortcuts" as const, label: t("auditI18n.shortcuts"), icon: Keyboard }] : []),
    { id: "ai" as const, label: t('settings.ai'), icon: Bot },
    { id: "automations" as const, label: t("auditI18n.automations"), icon: Workflow },
    { id: "security" as const, label: securityTabLabel, icon: Shield },
    // 每位登录用户都可连接自己的 AI 助手。
    { id: "tokens" as const, label: t('settings.tokens', { defaultValue: '访问令牌' }), icon: Key },
    ...(isAdmin ? [{ id: "users" as const, label: t('settings.users'), icon: Users }] : []),
    ...(isAdmin ? [{ id: "workspaces" as const, label: t('settings.workspaces'), icon: Building2 }] : []),
    // 扩展的管理员工具（来源、运行时策略、调试与恢复）；日常使用入口在扩展中心。
    ...(isAdmin ? [{ id: "extensions" as const, label: t("extensionCenter.advanced.tab"), icon: Blocks }] : []),
    // 三端共用数据管理：先呈现备份/恢复/导入/导出目标，再按权限展示范围及高级操作。
    { id: "data" as const, label: t('settings.dataManagement'), icon: Database },
    // 「同步」：Local-first 多设备同步（Sync V2）。产品层只呈现
    // 「不同步，仅此设备」/「我的 Nowen Server」，不暴露 Full/Lite/SQLite 概念。
    // Flag 关闭时组件内部会自行降级为一句说明，不需要在这里做条件渲染。
    { id: "sync" as const, label: isAndroidNativeRuntime() ? t("auditI18n.dataAndSync") : t("auditI18n.sync"), icon: RefreshCw },
    // 「文件夹同步」：桌面端专属，Phase B 只做配置 CRUD
    ...(isDesktop() ? [{ id: "folderSync" as const, label: t('folderSync.title'), icon: FolderSync }] : []),
    // 「下载客户端」面板：面向所有用户（含未登录、本地、云端）。需求背景：
    //   用户主要在中国大陆，GitHub Releases 下载体验差，这里按平台列出产物并提供
    //   「GitHub 直连 + 多个公共加速代理」的换源能力。与 about 的「前往下载页」区别：后者只能调起
    //   GitHub 。该面板本身不调用任何需要鉴权的接口（releases/latest 未鉴权）。
    { id: "download" as const, label: t('settings.download', { defaultValue: '下载客户端' }), icon: Download },
    { id: "ecosystem" as const, label: t('ecosystem.tab'), icon: Rocket },
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
      className="fixed inset-0 z-50 flex min-h-0 items-center justify-center overflow-hidden p-0 md:p-4 md:sm:p-6"
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
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
        transition={reducedMotion ? { duration: 0.12 } : { type: "spring", stiffness: 360, damping: 30, mass: 0.9 }}
        className="nowen-settings-shell relative flex h-[82dvh] max-h-[calc(100dvh-2.5rem)] min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-200/85 shadow-2xl dark:border-zinc-800/90 md:flex-row max-md:h-[100dvh] max-md:max-h-[100dvh] max-md:max-w-none max-md:rounded-none max-md:border-0"
        style={{ touchAction: "pan-y pinch-zoom" }}
        onClick={(e) => e.stopPropagation()}
        onPointerDownCapture={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="nowen-settings-aurora-line pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px]" />

        {/* 移动端：顶部弹性胶囊标签栏 + 关闭按钮 */}
        <SettingsMobileTopBar
          tabs={SETTING_TABS}
          activeTab={activeTab}
          mobileTabsRef={mobileTabsRef}
          onSelectTab={handleSelectTab}
          onClose={onClose}
        />

        {/* 桌面端：灵动分组侧边栏 + 搜索框 + 彩蛋徽章 */}
        <SettingsDesktopSidebar
          title={t('settings.title')}
          siteTitle={siteConfig.title}
          appVersion={__APP_VERSION__}
          isEnglish={isEnglish}
          tabs={SETTING_TABS}
          activeTab={activeTab}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchInputRef={searchInputRef}
          onSelectTab={handleSelectTab}
        />

        {/* 右侧内容区 */}
        <div ref={contentRef} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          {/* 关闭按钮 — 桌面端 */}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: '关闭设置' })}
            title={t('common.close', { defaultValue: '关闭设置' })}
            className="nowen-tactile-btn hidden md:flex sticky top-4 ml-auto mr-4 -mb-8 h-8 w-8 items-center justify-center rounded-xl border border-zinc-200/75 bg-white/80 text-zinc-400 shadow-2xs backdrop-blur-sm hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:hover:border-zinc-600 dark:hover:text-zinc-200 z-20"
          >
            <X className="w-4 h-4" />
          </button>

          {/* 动态渲染内容 */}
          <div className="min-w-0 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:p-7 md:pr-14">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              >
                {(() => {
                  const activeItem = SETTING_TABS.find((tab) => tab.id === activeTab);
                  if (!activeItem || activeTab === "shortcuts" || activeTab === "about") return null;
                  const tabMeta = SETTINGS_TAB_META[activeTab];
                  const groupMeta = SETTINGS_NAV_GROUP_META[tabMeta.group];
                  return (
                    <SettingsTabHero
                      icon={activeItem.icon}
                      title={activeItem.label}
                      tagline={isEnglish ? tabMeta.taglineEn : tabMeta.taglineZh}
                      groupLabel={isEnglish ? groupMeta.labelEn : groupMeta.labelZh}
                      badgeTone={tabMeta.badgeTone}
                      heroGlow={tabMeta.heroGlow}
                    />
                  );
                })()}
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
            {activeTab === "appearance" && <AppearancePanel onOpenTimeZone={openTimeZonePreference} />}
            {activeTab === "preferences" && (
              <PreferencesPanel
                isAdmin={isAdmin}
                relatedTabLabels={{ security: securityTabLabel, ai: t('settings.ai'), users: t('settings.users') }}
                onOpenRelatedSetting={openRelatedSetting}
                initialRequest={preferencesJumpRequest}
              />
            )}
            {activeTab === "shortcuts" && shortcutSurface !== "android" && <ShortcutSettingsPanel />}
            {activeTab === "ai" && (
              <AISettingsPanel serverSettings={isAdmin && !isMobileLocalMode() ? <AIMemoryArchiveSetting /> : undefined} />
            )}
            {activeTab === "automations" && <AutomationCenter />}
            {activeTab === "security" && <div className="space-y-6">
              {isAndroidNativeRuntime() && <MobileAccountSettings accountLabel={currentUser?.displayName || currentUser?.username} />}
              {!isMobileLocalMode() && <SecuritySettings />}
            </div>}
            {activeTab === "tokens" && <div className="space-y-6">
              <McpConnectionPanel />
              {!isMobileLocalMode() && <SettingsBentoCard as="div" spotlight={false} className="!overflow-visible">
                <details>
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-text-secondary)]">开发者访问令牌</summary>
                  <div className="border-t border-zinc-200/60 p-4 dark:border-zinc-800/70"><TokenManagement /></div>
                </details>
              </SettingsBentoCard>}
            </div>}
                  {activeTab === "users" && isAdmin && <UserManagement currentUserId={currentUser?.id ?? null} />}
                  {activeTab === "workspaces" && isAdmin && <WorkspaceManagement />}
                  {activeTab === "extensions" && isAdmin && <PluginManagementPanel />}
                  {/* DataManager 内部保留管理员与个人导入/导出的权限限制。 */}
                  {activeTab === "data" && <DataManager />}
                  {activeTab === "sync" && <SyncSettingsTab />}
                  {activeTab === "folderSync" && <FolderSyncSettings />}
                  {activeTab === "download" && <DownloadPanel />}
                  {activeTab === "ecosystem" && <NowenEcosystemPanel />}
                  {activeTab === "about" && <AboutPanel onOpenEcosystem={() => handleSelectTab("ecosystem")} />}
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
