/** Settings > Download clients. Verified R2 mirror first; GitHub official fallback.
 * All R2 links come from the server-validated 10-file release manifest.
 * Files not uploaded to R2 (UPK, AAB, portable/Lite, etc.) stay on GitHub.
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
  Sparkles,
  Zap,
  Terminal,
  Store,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import AppGalleryDownloadLink from "@/components/settings/AppGalleryDownloadLink";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Optional third-party proxy sources; GitHub and verified R2 have dedicated choices. */
type MirrorSource = { id: string; label: string; prefix: string };

const MIRROR_SOURCES: MirrorSource[] = [
  { id: "ghproxy", label: "ghproxy.net", prefix: "https://ghproxy.net/" },
  { id: "llkk", label: "gh.llkk.cc", prefix: "https://gh.llkk.cc/" },
  { id: "mirror", label: "mirror.ghproxy.com", prefix: "https://mirror.ghproxy.com/" },
];

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

/** 检测用户当前设备平台，用于在列表中优先推荐对应安装包。 */
function detectCurrentPlatform(): PlatformCategory | null {
  if (typeof navigator === "undefined") return null;
  const ua = `${navigator.userAgent || ""} ${navigator.platform || ""}`.toLowerCase();
  if (ua.includes("android")) return "android";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) return "ios";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return null;
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

/** Explicit optional proxy; R2 URLs are never guessed from filenames here. */
function resolveDownloadUrl(originalUrl: string, mirror: MirrorSource | null): string {
  return mirror ? mirror.prefix + originalUrl : originalUrl;
}

/** Hide an obsolete FPK when the same release offers a corrected revision. */
export function preferCorrectedFpk<T extends { name: string }>(all: T[]): T[] {
  const hasRevision = all.some(a => /^nowen-note-v?\d+\.\d+\.\d+-fpk-r\d+\.fpk$/i.test(a.name));
  return hasRevision
    ? all.filter(a => !/^nowen-note-v?\d+\.\d+\.\d+\.fpk$/i.test(a.name))
    : all;
}

const PLATFORM_META: Record<
  PlatformCategory,
  {
    icon: LucideIcon;
    iconTone: string;
    headerTint: string;
    accentBorder: string;
  }
> = {
  windows: {
    icon: Monitor,
    iconTone: "from-sky-400/20 to-blue-500/15 text-sky-700 ring-sky-500/20 dark:text-sky-300",
    headerTint: "from-sky-500/[0.06] via-transparent to-transparent",
    accentBorder: "border-sky-500/25 dark:border-sky-400/25",
  },
  macos: {
    icon: Apple,
    iconTone: "from-indigo-400/20 to-violet-500/15 text-indigo-700 ring-indigo-500/20 dark:text-indigo-300",
    headerTint: "from-indigo-500/[0.06] via-transparent to-transparent",
    accentBorder: "border-indigo-500/25 dark:border-indigo-400/25",
  },
  android: {
    icon: Smartphone,
    iconTone: "from-emerald-400/20 to-teal-500/15 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
    headerTint: "from-emerald-500/[0.06] via-transparent to-transparent",
    accentBorder: "border-emerald-500/25 dark:border-emerald-400/25",
  },
  ios: {
    icon: Smartphone,
    iconTone: "from-fuchsia-400/20 to-pink-500/15 text-fuchsia-700 ring-fuchsia-500/20 dark:text-fuchsia-300",
    headerTint: "from-fuchsia-500/[0.06] via-transparent to-transparent",
    accentBorder: "border-fuchsia-500/25 dark:border-fuchsia-400/25",
  },
  linux: {
    icon: Terminal,
    iconTone: "from-amber-400/20 to-orange-500/15 text-amber-700 ring-amber-500/20 dark:text-amber-300",
    headerTint: "from-amber-500/[0.06] via-transparent to-transparent",
    accentBorder: "border-amber-500/25 dark:border-amber-400/25",
  },
  other: {
    icon: HardDrive,
    iconTone: "from-cyan-400/20 to-teal-500/15 text-cyan-700 ring-cyan-500/20 dark:text-cyan-300",
    headerTint: "from-cyan-500/[0.06] via-transparent to-transparent",
    accentBorder: "border-cyan-500/25 dark:border-cyan-400/25",
  },
};

const BASE_PLATFORM_ORDER: PlatformCategory[] = ["windows", "macos", "android", "ios", "linux", "other"];

const GITHUB_RELEASE_URL = "https://github.com/cropflre/nowen-note/releases/latest";
const MICROSOFT_STORE_URL = "https://apps.microsoft.com/detail/9MZ7Z6S39LL3";

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
  const currentPlatform = useMemo(() => detectCurrentPlatform(), []);

  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [htmlUrl, setHtmlUrl] = useState<string>("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [reloadTick, setReloadTick] = useState(0);
  // R2 is the default; unmirrored files automatically use GitHub official URLs.
  const [activeMirror, setActiveMirror] = useState<string>("r2");
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformCategory | "all">("all");
  const [r2Urls, setR2Urls] = useState<Record<string, string>>({});
  const [r2Status, setR2Status] = useState<"loading" | "ready" | "unavailable">("loading");

  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  // 加载 release
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    setR2Urls({});
    setR2Status("loading");
    api
      .getLatestRelease()
      .then((r) => {
        if (cancelled) return;
        if (!r.available) {
          setErrMsg(r.reason || "unavailable");
          return;
        }
        const releaseTag = r.tag || (r.version ? `v${r.version}` : "");
        const visible = preferCorrectedFpk((r.assets || []).filter((a) => isUserDownloadAsset(a.name)));
        setVersion(r.version);
        setHtmlUrl(r.htmlUrl);
        setAssets(visible.map(a => ({
          name: a.name,
          size: a.size,
          browserDownloadUrl: a.browserDownloadUrl,
        })));

        // The backend fetches the manifest, avoiding CORS problems on NAS,
        // desktop local mode and mobile WebViews. A failed lookup keeps GitHub.
        void api.getLatestReleaseMirror().then(mirror => {
          if (cancelled) return;
          if (!mirror.available || mirror.tag !== releaseTag || !/^v\d+\.\d+\.\d+$/.test(releaseTag) ||
              mirror.assets.length !== 10) {
            setR2Status("unavailable");
            return;
          }
          const original = new Map(visible.map(a => [a.name, a]));
          const urls: Record<string, string> = {};
          for (const item of mirror.assets) {
            const github = original.get(item.name);
            const expected = `https://download.nowen.cn/${releaseTag}/${encodeURIComponent(item.name)}`;
            if (!github || github.size !== item.size || item.downloadUrl !== expected ||
                Object.hasOwn(urls, item.name)) {
              setR2Status("unavailable");
              return;
            }
            urls[item.name] = expected;
          }
          setR2Urls(urls);
          setR2Status("ready");
        }).catch(() => {
          if (!cancelled) setR2Status("unavailable");
        });
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

  // 当前设备所在平台自动提前展示，方便用户一眼找到对应安装包。
  const orderedPlatforms = useMemo(() => {
    const present = BASE_PLATFORM_ORDER.filter((p) => (grouped.get(p)?.length ?? 0) > 0);
    if (!currentPlatform || !present.includes(currentPlatform)) return present;
    return [currentPlatform, ...present.filter((p) => p !== currentPlatform)];
  }, [grouped, currentPlatform]);

  const visiblePlatforms = useMemo(
    () => (selectedPlatform === "all" ? orderedPlatforms : orderedPlatforms.filter((p) => p === selectedPlatform)),
    [orderedPlatforms, selectedPlatform],
  );

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
    return MIRROR_SOURCES.find((m) => m.id === activeMirror) ?? null;
  }, [activeMirror]);

  const mirrorPill = (active: boolean) =>
    cn(
      "inline-flex h-7 items-center gap-1 rounded-full px-3 text-xs font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40",
      active
        ? "bg-accent-primary text-white shadow-xs"
        : "bg-white/90 text-zinc-600 ring-1 ring-zinc-200/90 hover:bg-zinc-100 hover:text-zinc-900 dark:bg-zinc-800/80 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-700/70",
    );

  return (
    <div className="space-y-5 pb-2">
      {/* 1. 极光下载中心 Hero（整合标题 + 最新版本 + 加速下载源切换） */}
      <section className="relative overflow-hidden rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-500/[0.09] via-white to-indigo-500/[0.07] p-4 shadow-sm dark:border-sky-400/20 dark:from-sky-500/[0.12] dark:via-zinc-900/80 dark:to-indigo-500/[0.08]">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-gradient-to-br from-sky-400/20 to-indigo-400/15 blur-2xl"
        />

        <div className="relative flex items-start gap-3">
          <span
            aria-hidden
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/20 to-indigo-500/20 text-sky-600 ring-1 ring-inset ring-sky-500/20 dark:text-sky-300"
          >
            <Download size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h3 className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                  {t("download.title", { defaultValue: "下载客户端" })}
                </h3>
                <span className="inline-flex items-center rounded-full bg-accent-primary/12 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-accent-primary tabular-nums">
                  {loading ? "…" : version ? `v${version}` : "—"}
                </span>
                {r2Status === "ready" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    <Zap size={10} aria-hidden />
                    {t("download.r2ReadyBadge", { defaultValue: "R2 加速就绪" })}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <a
                  href={releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-zinc-200/90 bg-white/90 px-2.5 text-xs font-medium text-zinc-700 shadow-2xs transition-colors hover:border-accent-primary/40 hover:text-accent-primary dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200"
                  title={t("download.viewOnGithub", { defaultValue: "在 GitHub 查看完整 release" })}
                >
                  <ExternalLink size={12} aria-hidden />
                  GitHub
                </a>
                <button
                  type="button"
                  onClick={() => setReloadTick((v) => v + 1)}
                  disabled={loading}
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-zinc-200/90 bg-white/90 px-2.5 text-xs font-medium text-zinc-700 shadow-2xs transition-colors hover:border-accent-primary/40 hover:text-accent-primary disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200"
                  title={t("download.refresh", { defaultValue: "刷新" })}
                >
                  <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
                  {t("download.refresh", { defaultValue: "刷新" })}
                </button>
              </div>
            </div>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {t("download.subtitle", {
                defaultValue: "官方 R2 下载源优先，未镜像的安装包自动使用 GitHub 原站。",
              })}
            </p>
          </div>
        </div>

        {/* 加速下载源切换条（内嵌在 Hero 底部，消除孤立信息框） */}
        <div className="relative mt-3.5 space-y-2 border-t border-zinc-200/60 pt-3 dark:border-zinc-800/70">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              <Info size={12} className="text-accent-primary" aria-hidden />
              {t("download.mirrorLabel", { defaultValue: "下载源" })}
            </span>
            <button
              type="button"
              onClick={() => setActiveMirror("r2")}
              className={mirrorPill(activeMirror === "r2")}
            >
              R2 官方下载
            </button>
            <button
              type="button"
              onClick={() => setActiveMirror("")}
              className={mirrorPill(!activeMirror)}
            >
              GitHub
            </button>
            {MIRROR_SOURCES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setActiveMirror(m.id)}
                className={mirrorPill(activeMirror === m.id)}
                title={m.prefix}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {t("download.proxyTip", {
              defaultValue:
                "R2 安装包已与 GitHub 正式版校验；未镜像的 UPK、便携版等继续走 GitHub。也可自行切换下载源。",
            })}
          </p>
        </div>
      </section>

      {/* 2. 官方应用商店双列直达（Windows 微软商店 + HarmonyOS 华为应用市场） */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Store size={14} className="text-accent-primary" aria-hidden />
          <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
            {t("download.storeSectionTitle", { defaultValue: "官方应用商店" })}
          </h4>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {/* 微软商店 */}
          <div className="group/store flex flex-col justify-between gap-3 rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-500/[0.06] via-white to-blue-500/[0.03] p-3.5 shadow-xs transition-all duration-200 hover:border-sky-400/45 hover:shadow-sm motion-safe:hover:-translate-y-0.5 dark:from-sky-500/[0.08] dark:via-zinc-900/70 dark:to-blue-500/[0.04]">
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400/20 to-blue-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/20 transition-transform duration-200 motion-safe:group-hover/store:scale-110 motion-safe:group-hover/store:-rotate-6 dark:text-sky-300"
                >
                  <Monitor size={15} />
                </span>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {t("download.microsoftStoreTitle", { defaultValue: "Microsoft Store" })}
                </div>
              </div>
              <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                {t("download.microsoftStoreDesc", { defaultValue: "适用于 Windows 10 / 11，支持商店一键安装与自动更新。" })}
              </p>
            </div>
            <a
              href={MICROSOFT_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-xl bg-accent-primary px-3 text-xs font-medium text-white shadow-2xs transition-opacity hover:opacity-90"
            >
              {t("download.microsoftStoreLink", { defaultValue: "微软商店下载" })}
              <ExternalLink size={12} aria-hidden />
            </a>
          </div>

          {/* HarmonyOS 华为应用市场 */}
          <div className="group/store flex flex-col justify-between gap-3 rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-500/[0.06] via-white to-amber-500/[0.03] p-3.5 shadow-xs transition-all duration-200 hover:border-rose-400/45 hover:shadow-sm motion-safe:hover:-translate-y-0.5 dark:from-rose-500/[0.08] dark:via-zinc-900/70 dark:to-amber-500/[0.04]">
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-rose-400/20 to-amber-500/15 text-rose-700 ring-1 ring-inset ring-rose-500/20 transition-transform duration-200 motion-safe:group-hover/store:scale-110 motion-safe:group-hover/store:-rotate-6 dark:text-rose-300"
                >
                  <Smartphone size={15} />
                </span>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">HarmonyOS</div>
              </div>
              <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                {t("download.harmonyRequirement")}
              </p>
            </div>
            <AppGalleryDownloadLink className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-xl bg-accent-primary px-3 text-xs font-medium text-white shadow-2xs transition-opacity hover:opacity-90" />
          </div>
        </div>
      </section>

      {/* 错误降级：拿不到 release 列表时给用户兜底链接 */}
      {errMsg && !loading && (
        <div className="rounded-2xl border border-amber-300/60 dark:border-amber-700/60 bg-amber-50/80 dark:bg-amber-900/20 p-4 space-y-2">
          <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {t("download.unavailable", { defaultValue: "无法获取最新版本信息" })}
          </div>
          <div className="text-xs text-amber-700/80 dark:text-amber-400/80 break-all">{errMsg}</div>
          <div className="text-xs font-mono text-amber-800/80 dark:text-amber-200/80 break-all select-all">
            {releaseUrl}
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            <a
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200 hover:underline"
            >
              <ExternalLink size={12} />
              {t("download.openGithubManually", { defaultValue: "前往 GitHub Releases 手动选择" })}
            </a>
            <button
              type="button"
              onClick={() => handleCopyLink(releaseUrl)}
              className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200 hover:underline"
            >
              {copiedLink === releaseUrl ? <Check size={12} /> : <Copy size={12} />}
              {copiedLink === releaseUrl
                ? t("download.copied", { defaultValue: "已复制" })
                : t("download.copyLink", { defaultValue: "复制链接" })}
            </button>
          </div>
        </div>
      )}

      {/* 加载骨架 */}
      {loading && assets.length === 0 && (
        <div className="space-y-3" aria-hidden>
          {[0, 1].map((idx) => (
            <div key={idx} className="rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/40 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-lg bg-zinc-200/70 dark:bg-zinc-800 motion-safe:animate-pulse" />
                <div className="h-3.5 w-24 rounded bg-zinc-200/70 dark:bg-zinc-800 motion-safe:animate-pulse" />
              </div>
              <div className="h-12 w-full rounded-xl bg-zinc-100/90 dark:bg-zinc-800/60 motion-safe:animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* 3. 平台筛选胶囊 + 分组安装包列表 */}
      {orderedPlatforms.length > 0 && (
        <section className="space-y-3">
          {orderedPlatforms.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-pressed={selectedPlatform === "all"}
                onClick={() => setSelectedPlatform("all")}
                className={mirrorPill(selectedPlatform === "all")}
              >
                {t("download.filterAll", { defaultValue: "全部平台" })}
              </button>
              {orderedPlatforms.map((platform) => {
                const Icon = PLATFORM_META[platform].icon;
                const count = grouped.get(platform)?.length ?? 0;
                const active = selectedPlatform === platform;
                return (
                  <button
                    key={platform}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelectedPlatform(platform)}
                    className={mirrorPill(active)}
                  >
                    <Icon size={12} aria-hidden />
                    <span>
                      {t(`download.platform.${platform}`, {
                        defaultValue: defaultPlatformLabel(platform),
                      })}
                    </span>
                    <span className={cn("text-[10px] tabular-nums", active ? "text-white/80" : "text-zinc-400")}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="space-y-3">
            {visiblePlatforms.map((platform) => {
              const items = grouped.get(platform);
              if (!items || items.length === 0) return null;
              const meta = PLATFORM_META[platform];
              const Icon = meta.icon;
              const isCurrent = platform === currentPlatform;
              return (
                <div
                  key={platform}
                  className={cn(
                    "overflow-hidden rounded-2xl border bg-white/80 shadow-xs dark:bg-zinc-900/50",
                    isCurrent ? meta.accentBorder : "border-zinc-200/85 dark:border-zinc-800/85",
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center justify-between gap-2 border-b border-zinc-200/60 bg-gradient-to-r px-4 py-2.5 dark:border-zinc-800/70",
                      meta.headerTint,
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          "inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br ring-1 ring-inset",
                          meta.iconTone,
                        )}
                      >
                        <Icon size={14} />
                      </span>
                      <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                        {t(`download.platform.${platform}`, {
                          defaultValue: defaultPlatformLabel(platform),
                        })}
                      </span>
                      {isCurrent && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-accent-primary/12 px-2 py-0.5 text-[10px] font-semibold text-accent-primary">
                          <Sparkles size={10} aria-hidden />
                          {t("download.currentDeviceBadge", { defaultValue: "当前设备" })}
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500 tabular-nums">
                      {items.length}
                    </span>
                  </div>

                  <div className="divide-y divide-zinc-200/55 dark:divide-zinc-800/65">
                    {items.map(({ asset: a, category }) => {
                      const mirroredUrl = r2Urls[a.name];
                      const usesR2 = activeMirror === "r2" && Boolean(mirroredUrl);
                      const url = usesR2 ? mirroredUrl : resolveDownloadUrl(a.browserDownloadUrl, activeMirrorSource);
                      const fallbackToGithub = activeMirror === "r2" && !mirroredUrl;
                      return (
                        <div
                          key={a.name}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-zinc-50/90 dark:hover:bg-zinc-800/35"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                {t(`download.asset.${category}`, {
                                  defaultValue: defaultAssetLabel(category),
                                })}
                              </span>
                              {a.size > 0 && (
                                <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 tabular-nums">
                                  {formatSize(a.size)}
                                </span>
                              )}
                              {usesR2 && (
                                <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                                  <Zap size={9} aria-hidden />
                                  {t("download.r2VerifiedTag", { defaultValue: "R2 官方加速" })}
                                </span>
                              )}
                              {fallbackToGithub && r2Status !== "loading" && (
                                <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                  {t("download.r2FallbackTip", {
                                    defaultValue: "R2 未镜像，使用 GitHub",
                                  })}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500" title={a.name}>
                              {a.name}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-accent-primary px-3 text-xs font-semibold text-white shadow-2xs transition-all hover:opacity-90"
                              download
                            >
                              <Download size={12} aria-hidden />
                              {usesR2 || activeMirrorSource
                                ? t("download.btnAccelerated", { defaultValue: "加速下载" })
                                : t("download.btnDownload", { defaultValue: "下载" })}
                            </a>
                            <a
                              href={a.browserDownloadUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex h-8 items-center gap-1 rounded-xl border border-zinc-200/90 bg-white/80 px-2.5 text-xs text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700/80 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:text-zinc-100"
                              title={a.browserDownloadUrl}
                            >
                              <ExternalLink size={12} aria-hidden />
                              {t("download.originalLink", { defaultValue: "原始链接" })}
                            </a>
                            <button
                              type="button"
                              onClick={() => handleCopyLink(url)}
                              className={cn(
                                "inline-flex h-8 items-center gap-1 rounded-xl border px-2.5 text-xs transition-colors",
                                copiedLink === url
                                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                  : "border-zinc-200/90 bg-white/80 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700/80 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:text-zinc-100",
                              )}
                              title={url}
                            >
                              {copiedLink === url ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                              {copiedLink === url
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
        </section>
      )}

      {!loading && assets.length === 0 && !errMsg && (
        <div className="rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-800 p-5 text-center text-sm text-zinc-500 dark:text-zinc-400 space-y-2">
          <div>{t("download.noAssets", { defaultValue: "本次发布没有可用的下载资产，请在 GitHub Releases 查看。" })}</div>
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-accent-primary hover:underline"
          >
            <ExternalLink size={12} />
            {t("download.openGithubManually", { defaultValue: "前往 GitHub Releases 手动选择" })}
          </a>
        </div>
      )}

      {/* 4. Docker 自托管一键部署终端卡 */}
      <section className="overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/[0.06] via-white to-slate-500/[0.03] shadow-xs dark:border-cyan-400/20 dark:from-cyan-500/[0.08] dark:via-zinc-900/75 dark:to-slate-900/50">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200/60 px-4 py-2.5 dark:border-zinc-800/70">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400/20 to-sky-500/15 text-cyan-700 ring-1 ring-inset ring-cyan-500/20 dark:text-cyan-300"
            >
              <Container size={14} />
            </span>
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              {t("download.dockerTitle", { defaultValue: "Docker 一键部署" })}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCopyDocker}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors",
              copied
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200",
            )}
            title={t("download.copy", { defaultValue: "复制" })}
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {copied
              ? t("download.copied", { defaultValue: "已复制" })
              : t("download.copy", { defaultValue: "复制" })}
          </button>
        </div>
        <div className="p-4 space-y-2.5">
          <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
            {t("download.dockerDesc", {
              defaultValue:
                "在自己的服务器或 NAS 上跑一个最简洁的实例。启动后访问 http://<host>:3001 完成首次配置。",
            })}
          </p>
          <div className="rounded-xl bg-zinc-950 px-3.5 py-2.5 ring-1 ring-white/10">
            <code className="block font-mono text-xs leading-relaxed text-emerald-300 break-all">
              {DOCKER_RUN_COMMAND}
            </code>
          </div>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
            {t("download.dockerCnTip", {
              defaultValue:
                "提示：国内拉取 Docker Hub 慢可改用阿里云容器镜像代理（自行替换 image 前缀）。",
            })}
          </p>
        </div>
      </section>
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
      return "NAS 与扩展";
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
