import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { Sparkles } from "lucide-react";
import { MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";
import "@/components/shortcuts/shortcut-keycaps.css";
import "./settings-playful.css";

const SPARKLE_VECTORS = [
  { x: -18, y: -18, color: "#6366f1" },
  { x: 0, y: -24, color: "#38bdf8" },
  { x: 18, y: -16, color: "#f472b6" },
  { x: -14, y: 12, color: "#f59e0b" },
  { x: 16, y: 10, color: "#34d399" },
] as const;

export interface PlayfulSettingsEmblemProps {
  icon: LucideIcon;
  toneClass: string;
  size?: "sm" | "md" | "lg";
  title?: string;
  onBoop?: (count: number) => void;
  className?: string;
}

/**
 * Playful 3D tactile emblem with press skirt, gentle hover tilt, and optional click sparkle burst.
 */
export function PlayfulSettingsEmblem({
  icon: Icon,
  toneClass,
  size = "md",
  title,
  onBoop,
  className,
}: PlayfulSettingsEmblemProps) {
  const reducedMotion = useReducedMotion();
  const [booped, setBooped] = useState(false);
  const [burstKey, setBurstKey] = useState(0);
  const countRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleClick = () => {
    countRef.current += 1;
    setBooped(true);
    if (!reducedMotion) setBurstKey((value) => value + 1);
    onBoop?.(countRef.current);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setBooped(false), 180);
  };

  const sizeClass = size === "sm"
    ? "h-8 w-8 rounded-xl"
    : size === "lg"
      ? "h-12 w-12 rounded-2xl"
      : "h-10 w-10 rounded-2xl";
  const iconSize = size === "sm" ? 15 : size === "lg" ? 21 : 18;

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title}
      aria-label={title}
      className={cn(
        "nowen-playful-emblem inline-flex shrink-0 cursor-pointer select-none items-center justify-center bg-gradient-to-br ring-1 ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
        sizeClass,
        toneClass,
        booped && "nowen-playful-emblem--booped",
        className,
      )}
    >
      <Icon size={iconSize} aria-hidden />
      {!reducedMotion && burstKey > 0 && (
        <span key={burstKey} aria-hidden className="pointer-events-none absolute inset-0 overflow-visible">
          {SPARKLE_VECTORS.map((vec, index) => (
            <span
              key={index}
              className="nowen-sparkle-burst absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: vec.color,
                ["--spark-x" as string]: `${vec.x}px`,
                ["--spark-y" as string]: `${vec.y}px`,
              }}
            />
          ))}
        </span>
      )}
    </button>
  );
}

export interface SettingsBentoCardProps {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  spotlight?: boolean;
  as?: "section" | "div";
}

/**
 * NOWEN glass Bento card with RAF-throttled CSS-variable pointer Spotlight on desktop.
 */
export function SettingsBentoCard({
  children,
  className,
  interactive = false,
  spotlight = true,
  as = "section",
}: SettingsBentoCardProps) {
  const reducedMotion = useReducedMotion();
  const cardRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  const handleMouseMove = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!spotlight || reducedMotion || !cardRef.current) return;
    const { clientX, clientY } = event;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const node = cardRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      node.style.setProperty("--spot-x", `${clientX - rect.left}px`);
      node.style.setProperty("--spot-y", `${clientY - rect.top}px`);
    });
  }, [reducedMotion, spotlight]);

  const Component = as;
  return (
    <Component
      ref={cardRef as React.RefObject<never>}
      onMouseMove={spotlight ? handleMouseMove : undefined}
      className={cn(
        "nowen-settings-card rounded-2xl",
        interactive && "nowen-settings-card--interactive",
        spotlight && !reducedMotion && "nowen-settings-card--spotlight",
        className,
      )}
    >
      {children}
    </Component>
  );
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
}

export interface PlayfulSegmentedControlProps<T extends string | number> {
  layoutId: string;
  ariaLabel: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
  fullWidth?: boolean;
}

/**
 * Spring-animated tactile segmented control with shared-layout sliding thumb.
 */
export function PlayfulSegmentedControl<T extends string | number>({
  layoutId,
  ariaLabel,
  options,
  value,
  onChange,
  className,
  buttonClassName,
  fullWidth = false,
}: PlayfulSegmentedControlProps<T>) {
  const reducedMotion = useReducedMotion();

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "nowen-segmented-track inline-flex items-center gap-1 rounded-xl p-1",
        fullWidth && "grid w-full",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative z-0 inline-flex items-center justify-center rounded-lg px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60",
              selected
                ? "text-accent-primary dark:text-sky-200"
                : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
              buttonClassName,
            )}
          >
            {selected && (
              <motion.span
                layoutId={layoutId}
                transition={reducedMotion ? { duration: 0 } : MOTION_SPRING.snappy}
                aria-hidden
                className="nowen-segmented-thumb absolute inset-0 -z-10 rounded-lg"
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tiny 3D mechanical keycap hint reused across settings search and close controls.
 */
export function PlayfulKbdHint({
  children,
  className,
  onClick,
  title,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <kbd
      onClick={onClick}
      title={title}
      className={cn(
        "nowen-keycap nowen-keycap--sm nowen-keycap--modifier !h-5 !min-w-[1.35rem] !px-1.5 !text-[10px]",
        onClick && "nowen-keycap--interactive",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export interface SettingsTabHeroProps {
  icon: LucideIcon;
  title: string;
  tagline: string;
  groupLabel: string;
  badgeTone: string;
  heroGlow: string;
}

/**
 * Playful atmosphere header shown at the top of the active settings panel.
 */
export function SettingsTabHero({
  icon,
  title,
  tagline,
  groupLabel,
  badgeTone,
  heroGlow,
}: SettingsTabHeroProps) {
  const [boopCount, setBoopCount] = useState(0);

  return (
    <div
      className={cn(
        "relative mb-5 overflow-hidden rounded-2xl border border-zinc-200/75 bg-gradient-to-r px-4 py-3.5 dark:border-zinc-800/80",
        heroGlow,
      )}
    >
      <div className="relative flex items-center gap-3.5">
        <PlayfulSettingsEmblem
          icon={icon}
          toneClass={badgeTone}
          size="md"
          title={title}
          onBoop={setBoopCount}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              {title}
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-900/[0.05] px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-white/[0.07] dark:text-zinc-400">
              <Sparkles size={10} className="opacity-75" aria-hidden />
              {groupLabel}
            </span>
            {boopCount >= 3 && (
              <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                手感不错 ×{boopCount}
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
            {tagline}
          </p>
        </div>
      </div>
    </div>
  );
}
