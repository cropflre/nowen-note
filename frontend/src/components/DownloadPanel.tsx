/**
 * DownloadPanel — 设置页「下载客户端」面板
 *
 * 痛点背景：
 *   用户主要在中国大陆，所有客户端（exe / AppImage / deb / dmg / APK / fpk / upk）
 *   目前只发到 GitHub Releases。GitHub 在国内访问不稳定，80MB+ 的安装包经常
 *   下不动。这里通过「GitHub 直链 + 多个公共加速代理」给用户一个简易换源能力，
 *   不引入额外基础设施（CDN / 镜像同步）即可显著改善国内体验。
 *
 * 数据源：
 *   - /api/releases/latest（后端代理 GitHub API，带成功缓存和失败时旧数据回退）。
 *   - 该接口返回的 assets[].browserDownloadUrl 形如
 *       https://github.com/cropflre/nowen-note/releases/download/v1.1.7/Nowen-Note-1.1.7.apk
 *     前端只做"在这条 URL 前面拼一段加速代理"的字符串变换，不再二次请求 GitHub。
 *
 * 加速源选择策略：
 *   - 把若干公共代理预置成数组，用户可点按钮换源；
 *   - 公共代理寿命短（半年一年级别），加多个备用，减少"全部失效"概率；
 *   - 默认按钮就是 GitHub 直链 —— 海外用户、企业代理用户不被加速代理路由污染；
 *   - 不在设置里持久化"用户偏好的代理"，因为代理可用性会变；下一次会话重新选最稳。
 *
 * 不做的事（保持 MVP 简洁）：
 *   - 不做加速源 HEAD 探活（增加 N 次跨域请求 + 网络抖动判定噪音）；
 *   - 不做下载进度展示（让浏览器自己处理）；
 *   - 不持久化用户的镜像偏好；
 *   - 不做 CDN 自托管（后续如有需求再上）。
 *
 * 镜像源类型（v1.1.7 起新增）：
 *   - kind="proxy"：把 GitHub 直链拼一段公共代理前缀，覆盖所有文件大小；
 *   - kind="gitee"：独立 URL（gitee.com/<owner>/<repo>/releases/download/<tag>/<file>），
 *                   仅小文件（≤95MB），由 .github/workflows/sync-gitee-release.yml 自动同步。
 *                   Gitee 单文件上限约 100MB，所以 .fpk/.upk/.dmg/.AppImage/.rpm 等大文件
 *                   不会被同步过去——前端在这些文件上自动隐藏「Gitee 镜像」按钮，
 *                   避免用户点了 404。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  Monitor,
  Smartphone,
  Apple,
  HardDrive,
  Container,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  Info,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 镜像源定义。
 *   - kind="proxy"：拼前缀模式，所有文件可用；
 *   - kind="gitee"：独立 URL 模式，仅小文件可用。
 * 顺序决定 UI 上按钮顺序；后续要添/删直接改这里。
 */
type MirrorSource =
  | { id: string; label: string; kind: "proxy"; prefix: string }
  | { id: string; label: string; kind: "gitee"; owner: string; repo: string };

const MIRROR_SOURCES: MirrorSource[] = [
  // Gitee 镜像放第一位：国内用户最稳的兜底（自有仓库，速度可控）
  { id: "gitee", label: "Gitee 镜像", kind: "gitee", owner: "cropflre", repo: "nowen-note" },
  { id: "ghproxy", label: "ghproxy.net", kind: "proxy", prefix: "https://ghproxy.net/" },
  { id: "llkk", label: "gh.llkk.cc", kind: "proxy", prefix: "https://gh.llkk.cc/" },
  { id: "mirror", label: "mirror.ghproxy.com", kind: "proxy", prefix: "https://mirror.ghproxy.com/" },
];

/**
 * Gitee 镜像支持的文件后缀白名单。
 * 与 .github/workflows/sync-gitee-release.yml 的过滤规则一致——必须保持同步。
 * 大文件（.fpk/.upk/.dmg/.AppImage/.rpm）传不上 Gitee（100MB 限制），
 * 所以前端在这些文件上不显示 Gitee 选项，避免用户点了 404。
 */
const GITEE_SUPPORTED_EXTS = [".exe", ".apk", ".zip", ".deb"];

function isGiteeSupported(filename: string): boolean {
  const lower = filename.toLowerCase();
  return GITEE_SUPPORTED_EXTS.some((ext) => lower.endsWith(ext));
}

/** 资产分类：只依据文件名和扩展名判断，不绑定具体版本号。 */
type AssetCategory =
  | "win-setup"     // Windows 安装版（NSIS）
  | "win-portable"  // Windows 便携版
  | "android"       // Android APK
  | "mac-arm64"     // macOS Apple Silicon
  | "mac-x64"       // macOS Intel
  | "mac"           // macOS 未识别架构
  | "ios"           // iOS IPA
  | "linux-app"     // Linux AppImage
  | "linux-deb"     // Linux deb
  | "linux-rpm"     // Linux rpm
  | "linux-tar"     // Linux tar.gz / tgz
  | "fpk"           // 飞牛 NAS
  | "upk"           // 绿联 NAS
  | "clipper"       // 浏览器扩展 zip（nowen-clipper）
  | "other";

type PlatformCategory = "windows" | "android" | "macos" | "ios" | "linux" | "other";

interface Asset {
  name: string;
  size: number;
  browserDownloadUrl: string;
}

/** 文件名 → 分类。命名规则与 scripts/release.sh / build-fpk.mjs / build-upk.mjs 一致。 */
function categorize(name: string): AssetCategory {
  const lower = name.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".msi")) {
    if (lower.includes("portable")) return "win-portable";
    return "win-setup"; // 默认归为安装版（Setup / nsis）
  }
  if (lower.endsWith(".apk")) return "android";
  // clipper 浏览器扩展：发布脚本里包名形如 nowen-clipper-x.y.z.zip。
  if (lower.startsWith("nowen-clipper") && lower.endsWith(".zip")) return "clipper";
  if (lower.endsWith(".ipa") || (lower.includes("ios") && lower.endsWith(".zip"))) return "ios";
  if (
    lower.endsWith(".dmg") ||
    lower.endsWith(".pkg") ||
    ((
      lower.includes("mac") ||
      lower.includes("darwin") ||
      lower.includes("osx") ||
      (lower.startsWith("nowen-note") && /(?:arm64|aarch64|x64|x86_64|amd64|intel)/.test(lower))
    ) && lower.endsWith(".zip"))
  ) {
    if (/(?:arm64|aarch64|apple[._ -]?silicon)/.test(lower)) return "mac-arm64";
    if (/(?:x64|x86_64|amd64|intel)/.test(lower)) return "mac-x64";
    return "mac";
  }
  if (lower.endsWith(".appimage")) return "linux-app";
  if (lower.endsWith(".deb")) return "linux-deb";
  if (lower.endsWith(".rpm")) return "linux-rpm";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "linux-tar";
  if (lower.endsWith(".fpk")) return "fpk";
  if (lower.endsWith(".upk")) return "upk";
  return "other";
}

/** 自动更新元数据不是给用户手动下载的安装包，不放入“其他”分组。 */
function isUserDownloadAsset(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.endsWith(".blockmap") && !/^latest(?:-[a-z0-9-]+)?\.ya?ml$/.test(lower);
}

function platformOf(category: AssetCategory): PlatformCategory {
  if (category === "win-setup" || category === "win-portable") return "windows";
  if (category === "android") return "android";
  if (category === "mac-arm64" || category === "mac-x64" || category === "mac") return "macos";
  if (category === "ios") return "ios";
  if (category.startsWith("linux-")) return "linux";
  return "other";
}

const CATEGORY_PRIORITY: AssetCategory[] = [
  "win-setup",
  "win-portable",
  "android",
  "mac-arm64",
  "mac-x64",
  "mac",
  "ios",
  "linux-app",
  "linux-deb",
  "linux-rpm",
  "linux-tar",
  "fpk",
  "upk",
  "clipper",
  "other",
];

/** 字节数转人类可读 */
function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 给定原始 GitHub 直链 + 镜像源，返回最终下载 URL。
 * 三种情况：
 *   - mirror=null：直连 GitHub；
 *   - kind="proxy"：拼前缀；
 *   - kind="gitee"：根据 tag + 文件名拼 Gitee 独立 URL。
 */
function resolveDownloadUrl(
  originalUrl: string,
  filename: string,
  tag: string,
  mirror: MirrorSource | null,
): string {
  if (!mirror) return originalUrl;
  if (mirror.kind === "proxy") return mirror.prefix + originalUrl;
  // Gitee：tag 必须以 v 开头，与 sync-gitee-release.yml 保持一致
  const t = tag.startsWith("v") ? tag : `v${tag}`;
  return `https://gitee.com/${mirror.owner}/${mirror.repo}/releases/download/${t}/${encodeURIComponent(
    filename,
  )}`;
}

/** 平台分组顺序与图标映射 —— 不受 GitHub assets 原始顺序影响。
 *  icon 直接用 lucide-react 自己导出的 LucideIcon，避免手写窄签名（{size:number}）
 *  与库里 size: string|number 不兼容导致 TS2322（更新 @types/react / lucide-react 后会触发）。
 */
const PLATFORM_ORDER: Array<{
  category: PlatformCategory;
  icon: LucideIcon;
}> = [
  { category: "windows", icon: Monitor },
  { category: "android", icon: Smartphone },
  { category: "macos", icon: Apple },
  { category: "ios", icon: Smartphone },
  { category: "linux", icon: Monitor },
  { category: "other", icon: HardDrive },
];

const GITHUB_RELEASE_URL = "https://github.com/cropflre/nowen-note/releases/latest";

const DOCKER_RUN_COMMAND =
  "docker run -d --name nowen-note -p 3001:3001 -v ~/nowen-data:/app/data cropflre/nowen-note:latest";

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // 非 HTTPS 页面可能无法使用 Clipboard API，退回浏览器的同步复制能力。
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export default function DownloadPanel() {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [tag, setTag] = useState<string>("");
  const [htmlUrl, setHtmlUrl] = useState<string>("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [reloadTick, setReloadTick] = useState(0);

  // 当前选中的镜像源 id：'' 表示直连 GitHub。
  // 不持久化：见顶部说明。每次会话默认走 GitHub 直链，国内用户主动点切换。
  const [activeMirror, setActiveMirror] = useState<string>("");

  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  // 加载 release
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    api
      .getLatestRelease()
      .then((r) => {
        if (cancelled) return;
        if (!r.available) {
          setErrMsg(r.reason || "unavailable");
          return;
        }
        setVersion(r.version);
        setTag(r.tag || (r.version ? `v${r.version}` : ""));
        setHtmlUrl(r.htmlUrl);
        setAssets(
          (r.assets || [])
            .filter((a) => isUserDownloadAsset(a.name))
            .map((a) => ({
              name: a.name,
              size: a.size,
              browserDownloadUrl: a.browserDownloadUrl,
            })),
        );
      })
      .catch((e) => {
        if (!cancelled) setErrMsg(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // 资产先按平台分组，再按安装类型、CPU 架构和文件名稳定排序。
  const grouped = useMemo(() => {
    const map = new Map<PlatformCategory, Array<{ asset: Asset; category: AssetCategory }>>();
    for (const a of assets) {
      const cat = categorize(a.name);
      const platform = platformOf(cat);
      if (!map.has(platform)) map.set(platform, []);
      map.get(platform)!.push({ asset: a, category: cat });
    }
    for (const items of map.values()) {
      items.sort((left, right) => {
        const priority = CATEGORY_PRIORITY.indexOf(left.category) - CATEGORY_PRIORITY.indexOf(right.category);
        if (priority !== 0) return priority;
        return left.asset.name.localeCompare(right.asset.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
    }
    return map;
  }, [assets]);

  const releaseUrl = htmlUrl || GITHUB_RELEASE_URL;

  const handleCopyLink = async (url: string) => {
    if (!(await copyText(url))) return;
    setCopiedLink(url);
    setTimeout(() => setCopiedLink((current) => (current === url ? null : current)), 1500);
  };

  const handleCopyDocker = async () => {
    if (!(await copyText(DOCKER_RUN_COMMAND))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const activeMirrorSource = useMemo<MirrorSource | null>(() => {
    if (!activeMirror) return null;
    return MIRROR_SOURCES.find((m) => m.id === activeMirror) ?? null;
  }, [activeMirror]);

  return (
    <div className="space-y-6">
      {/* 标题 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
          <Download size={18} className="text-accent-primary" />
          {t("download.title", { defaultValue: "下载客户端" })}
        </h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("download.subtitle", {
            defaultValue: "在桌面、手机、NAS 多端使用弄文笔记。国内用户建议切换「加速下载」。",
          })}
        </p>
      </div>

      {/* 头部信息卡 */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
        <div className="space-y-1">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {t("download.latestVersion", { defaultValue: "最新版本" })}
          </div>
          <div className="font-mono text-sm text-zinc-900 dark:text-zinc-100">
            {loading ? "…" : version ? `v${version}` : "—"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-700/40 transition-colors"
            title={t("download.viewOnGithub", { defaultValue: "在 GitHub 查看完整 release" })}
          >
            <ExternalLink size={12} />
            GitHub
          </a>
          <button
            type="button"
            onClick={() => setReloadTick((v) => v + 1)}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-700/40 transition-colors disabled:opacity-50"
            title={t("download.refresh", { defaultValue: "刷新" })}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {t("download.refresh", { defaultValue: "刷新" })}
          </button>
        </div>
      </div>

      {/* 加速源切换 */}
      <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 space-y-2.5">
        <div className="flex items-start gap-2">
          <Info size={14} className="text-accent-primary mt-0.5 shrink-0" />
          <div className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
            {t("download.proxyTip", {
              defaultValue:
                "国内网络无法直接下载时，可切换上方加速源；若加速源不可用，可打开或复制每个文件的 GitHub 原始链接。",
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveMirror("")}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-colors border",
              !activeMirror
                ? "bg-accent-primary text-white border-accent-primary"
                : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/40 dark:hover:bg-zinc-700/40",
            )}
          >
            GitHub
          </button>
          {MIRROR_SOURCES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setActiveMirror(m.id)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium transition-colors border",
                activeMirror === m.id
                  ? "bg-accent-primary text-white border-accent-primary"
                  : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/40 dark:hover:bg-zinc-700/40",
                m.kind === "gitee" && activeMirror !== m.id
                  ? "ring-1 ring-emerald-400/40"
                  : "",
              )}
              title={
                m.kind === "proxy"
                  ? m.prefix
                  : `https://gitee.com/${m.owner}/${m.repo}/releases（仅小文件 ≤95MB）`
              }
            >
              {m.label}
              {m.kind === "gitee" && (
                <span className="ml-1 text-[10px] opacity-80">⭐</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 错误降级：拿不到 release 列表时给用户兜底链接 */}
      {errMsg && !loading && (
        <div className="p-4 rounded-xl border border-amber-300/60 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 space-y-2">
          <div className="text-sm text-amber-700 dark:text-amber-300">
            {t("download.unavailable", { defaultValue: "无法获取最新版本信息" })}
          </div>
          <div className="text-xs text-amber-700/80 dark:text-amber-400/80 break-all">{errMsg}</div>
          <div className="text-xs text-amber-800/80 dark:text-amber-200/80 break-all select-all">
            {releaseUrl}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-amber-800 dark:text-amber-200 hover:underline"
            >
              <ExternalLink size={12} />
              {t("download.openGithubManually", { defaultValue: "前往 GitHub Releases 手动选择" })}
            </a>
            <button
              type="button"
              onClick={() => handleCopyLink(releaseUrl)}
              className="inline-flex items-center gap-1 text-xs text-amber-800 dark:text-amber-200 hover:underline"
            >
              {copiedLink === releaseUrl ? <Check size={12} /> : <Copy size={12} />}
              {copiedLink === releaseUrl
                ? t("download.copied", { defaultValue: "已复制" })
                : t("download.copyLink", { defaultValue: "复制链接" })}
            </button>
          </div>
        </div>
      )}

      {/* 资产分组列表 */}
      {assets.length > 0 && (
        <div className="space-y-3">
          {PLATFORM_ORDER.map((g) => {
            const items = grouped.get(g.category);
            if (!items || items.length === 0) return null;
            const Icon = g.icon;
            return (
              <div
                key={g.category}
                className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 overflow-hidden"
              >
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-200/60 dark:border-zinc-800/60">
                  <Icon size={14} className="text-zinc-500 dark:text-zinc-400" />
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {t(`download.platform.${g.category}`, {
                      defaultValue: defaultPlatformLabel(g.category),
                    })}
                  </span>
                </div>
                <div className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
                  {items.map(({ asset: a, category }) => {
                    // Gitee 不支持当前文件时（如 .fpk/.upk/.dmg/.AppImage），
                    // 自动回落到 GitHub 直连，避免用户点了 404。
                    const effectiveMirror =
                      activeMirrorSource?.kind === "gitee" && !isGiteeSupported(a.name)
                        ? null
                        : activeMirrorSource;
                    const url = resolveDownloadUrl(a.browserDownloadUrl, a.name, tag, effectiveMirror);
                    const giteeFallback =
                      activeMirrorSource?.kind === "gitee" && !isGiteeSupported(a.name);
                    return (
                      <div
                        key={a.name}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-2.5"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                            {t(`download.asset.${category}`, {
                              defaultValue: defaultAssetLabel(category),
                            })}
                          </div>
                          <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono truncate mt-0.5" title={a.name}>
                            {a.name}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {a.size > 0 && (
                              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                                {formatSize(a.size)}
                              </span>
                            )}
                            {giteeFallback && (
                              <span
                                className="text-[11px] text-amber-600 dark:text-amber-400"
                                title="Gitee 单文件 100MB 限制，此文件未同步，已自动回落到 GitHub"
                              >
                                {t("download.giteeFallbackTip", {
                                  defaultValue: "Gitee 不支持，已回落 GitHub",
                                })}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-accent-primary text-white text-xs font-medium hover:opacity-90"
                            download
                          >
                            <Download size={12} />
                            {effectiveMirror
                              ? t("download.btnAccelerated", { defaultValue: "加速下载" })
                              : t("download.btnDownload", { defaultValue: "下载" })}
                          </a>
                          <a
                            href={a.browserDownloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/40 dark:hover:bg-zinc-700/40"
                            title={a.browserDownloadUrl}
                          >
                            <ExternalLink size={12} />
                            {t("download.originalLink", { defaultValue: "原始链接" })}
                          </a>
                          <button
                            type="button"
                            onClick={() => handleCopyLink(a.browserDownloadUrl)}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/40 dark:hover:bg-zinc-700/40"
                            title={a.browserDownloadUrl}
                          >
                            {copiedLink === a.browserDownloadUrl ? <Check size={12} /> : <Copy size={12} />}
                            {copiedLink === a.browserDownloadUrl
                              ? t("download.copied", { defaultValue: "已复制" })
                              : t("download.copyLink", { defaultValue: "复制链接" })}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && assets.length === 0 && !errMsg && (
        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 text-sm text-zinc-500 dark:text-zinc-400 space-y-2">
          <div>{t("download.noAssets", { defaultValue: "本次发布没有可用的下载资产，请在 GitHub Releases 查看。" })}</div>
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:underline"
          >
            <ExternalLink size={12} />
            {t("download.openGithubManually", { defaultValue: "前往 GitHub Releases 手动选择" })}
          </a>
        </div>
      )}

      {/* Docker 一键部署 */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-200/60 dark:border-zinc-800/60">
          <Container size={14} className="text-zinc-500 dark:text-zinc-400" />
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {t("download.dockerTitle", { defaultValue: "Docker 一键部署" })}
          </span>
        </div>
        <div className="p-4 space-y-2.5">
          <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t("download.dockerDesc", {
              defaultValue:
                "在自己的服务器或 NAS 上跑一个最简洁的实例。启动后访问 http://<host>:3001 完成首次配置。",
            })}
          </p>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 px-3 py-2 rounded-md bg-zinc-900 text-zinc-100 text-xs font-mono break-all">
              {DOCKER_RUN_COMMAND}
            </code>
            <button
              type="button"
              onClick={handleCopyDocker}
              className="flex items-center gap-1 px-3 rounded-md bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-100 text-xs font-medium hover:opacity-90 shrink-0"
              title={t("download.copy", { defaultValue: "复制" })}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied
                ? t("download.copied", { defaultValue: "已复制" })
                : t("download.copy", { defaultValue: "复制" })}
            </button>
          </div>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
            {t("download.dockerCnTip", {
              defaultValue:
                "提示：国内拉取 Docker Hub 慢可改用阿里云容器镜像代理（自行替换 image 前缀）。",
            })}
          </p>
        </div>
      </div>
    </div>
  );
}

/** 没有 i18n 命中时的回退文案（中文优先，符合主要受众） */
function defaultPlatformLabel(c: PlatformCategory): string {
  switch (c) {
    case "windows":
      return "Windows";
    case "android":
      return "Android";
    case "macos":
      return "macOS";
    case "ios":
      return "iOS";
    case "linux":
      return "Linux";
    case "other":
      return "其他";
  }
}

function defaultAssetLabel(c: AssetCategory): string {
  switch (c) {
    case "win-setup":
      return "Windows 安装版";
    case "win-portable":
      return "Windows 便携版（免安装）";
    case "android":
      return "Android APK";
    case "mac-arm64":
      return "Apple Silicon (arm64)";
    case "mac-x64":
      return "Intel (x64)";
    case "mac":
      return "macOS 安装包";
    case "ios":
      return "iOS 安装包";
    case "linux-app":
      return "AppImage";
    case "linux-deb":
      return "Debian / Ubuntu (.deb)";
    case "linux-rpm":
      return "RHEL / Fedora (.rpm)";
    case "linux-tar":
      return "Linux 压缩包 (tar.gz)";
    case "fpk":
      return "飞牛 NAS (.fpk)";
    case "upk":
      return "绿联 NAS (.upk)";
    case "clipper":
      return "浏览器扩展（剪藏）";
    case "other":
      return "其他文件";
    default:
      return "";
  }
}
