/**
 * Nowen Motion Design System — framer-motion tokens.
 *
 * Mirrors src/motion.css so CSS transitions and JS animations share one rhythm.
 * Keep the two files in sync; components should import presets from here instead
 * of writing ad-hoc `duration: 0.15` values.
 *
 * Reduced motion: <MotionConfig reducedMotion="user"> in main.tsx disables
 * transform and layout animations for users who ask for it, while opacity
 * cross-fades keep state changes perceivable. Non-transform properties such as
 * `width` still animate there, so callers must zero those themselves
 * (see the desktop sidebar in App.tsx).
 */
import type { TargetAndTransition, Transition } from "framer-motion";

/** Seconds. Same scale as --motion-duration-* in motion.css. */
export const MOTION_DURATION = {
  instant: 0.08,
  fast: 0.14,
  normal: 0.2,
  slow: 0.3,
} as const;

/** Cubic-bezier curves. Same values as --motion-ease-* in motion.css. */
export const MOTION_EASE = {
  /** Generic state changes. */
  standard: [0.2, 0, 0, 1],
  /** Entering UI: quick start, soft landing. */
  enter: [0.16, 1, 0.3, 1],
  /** Exiting UI: accelerates away so it never lingers. */
  exit: [0.4, 0, 1, 1],
} as const;

/**
 * Springs are tuned close to critical damping (ζ ≈ 1): they feel physical when a
 * gesture or rapid re-target interrupts them, without a visible bounce.
 */
export const MOTION_SPRING = {
  /** Small indicators (tab underline, rail marker). ζ≈1.03, settles in ~160ms. */
  snappy: { type: "spring", stiffness: 520, damping: 42, mass: 0.8 },
  /** List reorder / stacked toasts. ζ≈0.97, settles in ~220ms. */
  layout: { type: "spring", stiffness: 380, damping: 38, mass: 1 },
  /** Drawers and panels that travel a long distance. */
  panel: { type: "spring", bounce: 0, duration: 0.32 },
} as const satisfies Record<string, Transition>;

interface PresencePreset {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
}

/** Backdrops / scrims. */
export const overlayMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: MOTION_DURATION.normal, ease: MOTION_EASE.standard } },
  exit: { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.exit } },
} satisfies PresencePreset;

/** Menus and popovers anchored below their trigger. */
export const popoverMotion = {
  initial: { opacity: 0, scale: 0.97, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.enter } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.1, ease: MOTION_EASE.exit } },
} satisfies PresencePreset;

/** Centered dialogs and palettes. */
export const dialogMotion = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: MOTION_DURATION.normal, ease: MOTION_EASE.enter } },
  exit: { opacity: 0, scale: 0.98, y: 4, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.exit } },
} satisfies PresencePreset;

/** Toasts dropping in from the top edge. */
export const toastMotion = {
  initial: { opacity: 0, y: -12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { ...MOTION_SPRING.layout, opacity: { duration: MOTION_DURATION.fast } } },
  exit: { opacity: 0, scale: 0.96, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.exit } },
} satisfies PresencePreset;

/** Inline icon / label swaps (loading → success → error). */
export const swapMotion = {
  initial: { opacity: 0, scale: 0.8 },
  animate: { opacity: 1, scale: 1, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.enter } },
  exit: { opacity: 0, scale: 0.8, transition: { duration: MOTION_DURATION.instant, ease: MOTION_EASE.exit } },
} satisfies PresencePreset;

/**
 * Stagger delay (seconds) for list entrances. Capped so long result lists still
 * finish quickly: the 9th item and later all start together.
 */
export function staggerDelay(index: number, step = 0.02, maxSteps = 8): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), maxSteps) * step;
}
