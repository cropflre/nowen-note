import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssSource = readFileSync(
  path.resolve(__dirname, "../daily-records/daily-records-mobile.css"),
  "utf8",
);

describe("daily records responsive action controls", () => {
  it("responds to the daily-records container instead of viewport width", () => {
    expect(cssSource).toContain("container-type: inline-size");
    expect(cssSource).toContain("container-name: daily-records");
    expect(cssSource).toContain("@container daily-records (max-width: 639px)");
    expect(cssSource).toContain("@container daily-records (max-width: 359px)");
    expect(cssSource).not.toContain("@media (max-width: 639px)");
    expect(cssSource).not.toContain("@media (max-width: 359px)");
  });

  it("keeps edit and delete actions reachable on touch and narrow layouts", () => {
    expect(cssSource).toMatch(
      /\[data-diary-card-actions="true"\]\s*>\s*div:last-child\s*>\s*button\s*\{[\s\S]*?min-width:\s*2\.5rem;[\s\S]*?min-height:\s*2\.5rem;[\s\S]*?opacity:\s*1\s*!important;[\s\S]*?touch-action:\s*manipulation;/,
    );
    expect(cssSource).toMatch(
      /@container daily-records \(max-width: 639px\)[\s\S]*?\[data-diary-card-actions="true"\][\s\S]*?opacity:\s*1\s*!important;/,
    );
  });

  it("only de-emphasizes actions for real mouse hover on wide containers", () => {
    expect(cssSource).toContain("@media (hover: hover) and (pointer: fine)");
    expect(cssSource).toContain("@container daily-records (min-width: 640px)");
    expect(cssSource).toContain("opacity: 0.55 !important");
    expect(cssSource).toContain('[data-diary-card="true"]:hover');
    expect(cssSource).toContain('[data-diary-card="true"]:focus-within');
    expect(cssSource).not.toContain("pointer-events: none");
  });

  it("keeps the action column from being squeezed or clipped", () => {
    expect(cssSource).toMatch(
      /\[data-diary-card-actions="true"\]\s*\{[\s\S]*?overflow:\s*visible;/,
    );
    expect(cssSource).toMatch(
      /\[data-diary-card-actions="true"\]\s*>\s*div:last-child\s*\{[\s\S]*?flex-shrink:\s*0;/,
    );
  });
});
