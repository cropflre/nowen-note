import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOTION_DURATION, MOTION_EASE, MOTION_SPRING, staggerDelay } from "../motion";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

const css = source("../../motion.css");

function cssVar(name: string, scope = css): string {
  const match = scope.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`missing ${name}`);
  return match[1].trim();
}

describe("motion design system", () => {
  it("keeps CSS and framer-motion durations in sync", () => {
    for (const [name, seconds] of Object.entries(MOTION_DURATION)) {
      expect(cssVar(`--motion-duration-${name}`)).toBe(`${Math.round(seconds * 1000)}ms`);
    }
  });

  it("keeps CSS and framer-motion easing curves in sync", () => {
    for (const [name, curve] of Object.entries(MOTION_EASE)) {
      const value = cssVar(`--motion-ease-${name}`).replace(/\s+/g, "");
      expect(value).toBe(`cubic-bezier(${curve.join(",")})`);
    }
  });

  it("removes duration, travel and press scale for reduced motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const name of Object.keys(MOTION_DURATION)) {
      expect(cssVar(`--motion-duration-${name}`, reduced)).toBe("0ms");
    }
    expect(cssVar("--motion-scale-press", reduced)).toBe("1");
    expect(reduced).toMatch(/\.animate-nowen-rise-in[\s\S]*animation: none !important/);
  });

  it("makes every framer-motion animation respect the system reduced-motion setting", () => {
    const main = source("../../main.tsx");
    expect(main).toContain('import "./motion.css";');
    expect(main).toContain('<MotionConfig reducedMotion="user">');
  });

  it("tunes stiffness springs close to critical damping (no visible bounce)", () => {
    for (const spring of [MOTION_SPRING.snappy, MOTION_SPRING.layout]) {
      const dampingRatio = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
      expect(dampingRatio).toBeGreaterThan(0.9);
      expect(dampingRatio).toBeLessThan(1.1);
    }
    expect(MOTION_SPRING.panel.bounce).toBe(0);
  });

  it("caps list stagger so long result lists still settle quickly", () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(3)).toBeCloseTo(0.06);
    expect(staggerDelay(40)).toBeCloseTo(0.16);
    expect(staggerDelay(-1)).toBe(0);
    expect(staggerDelay(Number.NaN)).toBe(0);
  });
});
