import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BookOpenText,
  BookmarkCheck,
  Check,
  Clapperboard,
  Copy,
  ExternalLink,
  Globe,
  Search,
  Smartphone,
  Sparkles,
  X,
  ZoomIn,
} from "lucide-react";
import miniProgramQr from "@/assets/community/nowen-miniprogram.png";
import { MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  PlayfulSettingsEmblem,
  SettingsBentoCard,
} from "./shell/SettingsVisualKit";

const MINI_PROGRAM_NAME = "NOWEN弄文";

interface EcosystemProductConfig {
  id: "video" | "reader" | "bookmark" | "miniprogram";
  icon: typeof Clapperboard;
  toneClass: string;
  cardTint: string;
  pillTone: string;
  githubUrl?: string;
  siteUrl?: string;
  isMiniProgram?: boolean;
}

const ECOSYSTEM_PRODUCTS: EcosystemProductConfig[] = [
  {
    id: "video",
    icon: Clapperboard,
    toneClass: "from-rose-500/25 to-amber-500/20 text-rose-600 ring-rose-500/25 dark:text-rose-300",
    cardTint: "from-rose-500/[0.07] via-white/90 to-amber-500/[0.04] dark:from-rose-500/[0.11] dark:via-zinc-900/75 dark:to-amber-500/[0.06]",
    pillTone: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
    githubUrl: "https://github.com/cropflre/nowen-video",
    siteUrl: "http://video.nowen.cn/",
  },
  {
    id: "reader",
    icon: BookOpenText,
    toneClass: "from-violet-500/25 to-indigo-500/20 text-violet-600 ring-violet-500/25 dark:text-violet-300",
    cardTint: "from-violet-500/[0.07] via-white/90 to-indigo-500/[0.04] dark:from-violet-500/[0.11] dark:via-zinc-900/75 dark:to-indigo-500/[0.06]",
    pillTone: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    githubUrl: "https://github.com/cropflre/nowen-reader",
    siteUrl: "http://reader.nowen.cn/",
  },
  {
    id: "bookmark",
    icon: BookmarkCheck,
    toneClass: "from-sky-500/25 to-cyan-500/20 text-sky-600 ring-sky-500/25 dark:text-sky-300",
    cardTint: "from-sky-500/[0.07] via-white/90 to-cyan-500/[0.04] dark:from-sky-500/[0.11] dark:via-zinc-900/75 dark:to-cyan-500/[0.06]",
    pillTone: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    githubUrl: "https://github.com/cropflre/NOWEN",
    siteUrl: "http://nowen.nowen.cn/",
  },
  {
    id: "miniprogram",
    icon: Smartphone,
    toneClass: "from-emerald-500/25 to-teal-500/20 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300",
    cardTint: "from-emerald-500/[0.08] via-white/90 to-teal-500/[0.05] dark:from-emerald-500/[0.12] dark:via-zinc-900/75 dark:to-teal-500/[0.06]",
    pillTone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    isMiniProgram: true,
  },
];

function MiniProgramQrLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={alt}
        className="absolute right-4 top-4 rounded-xl border border-white/15 bg-black/60 p-2 text-white/90 transition-colors hover:bg-white/15"
      >
        <X size={16} />
      </button>
      <div className="flex flex-col items-center gap-3 rounded-3xl bg-white p-5 shadow-2xl">
        <img
          src={src}
          alt={alt}
          className="h-64 w-64 object-contain sm:h-72 sm:w-72"
          draggable={false}
        />
        <span className="rounded-full bg-emerald-500/10 px-3 py-1 font-mono text-xs font-semibold text-emerald-700">
          {MINI_PROGRAM_NAME}
        </span>
      </div>
    </div>,
    document.body,
  );
}

export default function NowenEcosystemPanel() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [miniCopied, setMiniCopied] = useState(false);
  const [qrPreviewOpen, setQrPreviewOpen] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const handleCopyMiniProgram = () => {
    const finish = () => {
      setMiniCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setMiniCopied(false), 2400);
    };
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(MINI_PROGRAM_NAME).then(finish).catch(finish);
      return;
    }
    finish();
  };

  return (
    <div className="space-y-4 pb-2">
      {/* 氛围总览卡 */}
      <SettingsBentoCard className="bg-gradient-to-br from-indigo-500/[0.08] via-white/90 to-emerald-500/[0.07] p-4 dark:from-indigo-500/[0.12] dark:via-zinc-900/75 dark:to-emerald-500/[0.08]">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-12 h-36 w-36 rounded-full bg-gradient-to-br from-sky-400/20 to-indigo-500/15 blur-2xl"
        />
        <div className="relative space-y-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-inset ring-indigo-500/20 dark:text-indigo-300">
            <Sparkles size={11} aria-hidden />
            {t("ecosystem.bannerBadge")}
          </span>
          <h3 className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {t("ecosystem.bannerTitle")}
          </h3>
          <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            {t("ecosystem.bannerDesc")}
          </p>
        </div>
      </SettingsBentoCard>

      {/* 2×2 生态产品 Bento 矩阵 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ECOSYSTEM_PRODUCTS.map((product, index) => {
          const name = t(`ecosystem.products.${product.id}.name`);
          const subName = t(`ecosystem.products.${product.id}.subName`);
          const badge = t(`ecosystem.products.${product.id}.badge`);
          const desc = t(`ecosystem.products.${product.id}.desc`);
          const rawTags = String(t(`ecosystem.products.${product.id}.tags`) || "");
          const tags = rawTags ? rawTags.split("|").map((item) => item.trim()).filter(Boolean) : [];

          return (
            <motion.div
              key={product.id}
              initial={reducedMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reducedMotion ? { duration: 0 } : { ...MOTION_SPRING.layout, delay: index * 0.04 }}
              className="flex"
            >
              <SettingsBentoCard
                as="div"
                interactive
                className={cn(
                  "flex w-full flex-col justify-between gap-3.5 bg-gradient-to-br p-4",
                  product.cardTint,
                )}
              >
                <div className="relative z-10 space-y-3">
                  {/* 顶部：可按压 3D 图标 + 名称 + 定位标签 */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <PlayfulSettingsEmblem
                        icon={product.icon}
                        toneClass={product.toneClass}
                        size="md"
                        title={name}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h4 className="text-sm font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                            {name}
                          </h4>
                          <span className="font-mono text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                            {subName}
                          </span>
                        </div>
                        <span
                          className={cn(
                            "mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
                            product.pillTone,
                          )}
                        >
                          {badge}
                        </span>
                      </div>
                    </div>

                    {product.isMiniProgram && (
                      <button
                        type="button"
                        onClick={() => setQrPreviewOpen(true)}
                        title={t("ecosystem.miniProgramScanAlt")}
                        aria-label={t("ecosystem.miniProgramScanAlt")}
                        className="group/qr relative shrink-0 overflow-hidden rounded-2xl bg-white p-1.5 shadow-sm ring-1 ring-emerald-500/20 cursor-zoom-in transition-transform duration-200 motion-safe:hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                      >
                        <img
                          src={miniProgramQr}
                          alt={t("ecosystem.miniProgramScanAlt")}
                          className="h-14 w-14 object-contain"
                          loading="lazy"
                          draggable={false}
                        />
                        <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover/qr:bg-black/25 group-hover/qr:opacity-100">
                          <ZoomIn size={14} className="text-white" aria-hidden />
                        </span>
                      </button>
                    )}
                  </div>

                  {/* 一句话介绍 */}
                  <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                    {desc}
                  </p>

                  {/* 能力标签 */}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-lg border border-zinc-200/80 bg-white/75 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700/70 dark:bg-zinc-900/60 dark:text-zinc-300"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 底部 CTA 区域 */}
                <div className="relative z-10 border-t border-zinc-200/60 pt-3 dark:border-zinc-800/70">
                  {product.isMiniProgram ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/25 bg-white/85 px-2.5 py-1.5 dark:bg-zinc-900/80">
                        <div className="flex min-w-0 items-center gap-1.5 text-xs">
                          <Search size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                          <span className="shrink-0 text-[11px] text-zinc-500 dark:text-zinc-400">
                            {t("ecosystem.miniProgramSearchLabel")}
                          </span>
                          <span className="truncate font-mono font-bold text-emerald-700 dark:text-emerald-300">
                            {MINI_PROGRAM_NAME}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={handleCopyMiniProgram}
                          className={cn(
                            "nowen-tactile-btn inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
                            miniCopied
                              ? "bg-emerald-500 text-white shadow-xs"
                              : "bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300",
                          )}
                        >
                          {miniCopied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                          <span>
                            {miniCopied ? t("ecosystem.copiedMiniProgram") : t("ecosystem.copyMiniProgram")}
                          </span>
                        </button>
                      </div>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {t("ecosystem.miniProgramHint")}
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {product.siteUrl && (
                        <a
                          href={product.siteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="nowen-tactile-btn inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-xl bg-zinc-900 px-3 text-xs font-semibold text-white shadow-xs hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                        >
                          <Globe size={13} aria-hidden />
                          <span>{t("ecosystem.visitSite")}</span>
                          <ArrowUpRight size={12} className="opacity-70" aria-hidden />
                        </a>
                      )}
                      {product.githubUrl && (
                        <a
                          href={product.githubUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="nowen-tactile-btn inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-xl border border-zinc-200/90 bg-white/90 px-3 text-xs font-medium text-zinc-700 shadow-2xs hover:border-accent-primary/45 hover:text-accent-primary dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                        >
                          <span>{t("ecosystem.githubRepo")}</span>
                          <ExternalLink size={12} className="opacity-75" aria-hidden />
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </SettingsBentoCard>
            </motion.div>
          );
        })}
      </div>

      {qrPreviewOpen && (
        <MiniProgramQrLightbox
          src={miniProgramQr}
          alt={t("ecosystem.miniProgramScanAlt")}
          onClose={() => setQrPreviewOpen(false)}
        />
      )}
    </div>
  );
}
