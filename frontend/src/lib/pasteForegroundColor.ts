export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface RiskyForegroundColorReport {
  total: number;
  dark: number;
  light: number;
  colors: string[];
}

const NAMED_COLORS: Readonly<Record<string, [number, number, number]>> = Object.freeze({
  black: [0, 0, 0], white: [255, 255, 255], silver: [192, 192, 192], gray: [128, 128, 128],
  grey: [128, 128, 128], maroon: [128, 0, 0], red: [255, 0, 0], purple: [128, 0, 128],
  fuchsia: [255, 0, 255], green: [0, 128, 0], lime: [0, 255, 0], olive: [128, 128, 0],
  yellow: [255, 255, 0], navy: [0, 0, 128], blue: [0, 0, 255], teal: [0, 128, 128],
  aqua: [0, 255, 255], orange: [255, 165, 0], transparent: [0, 0, 0],
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseAlpha(raw: string | undefined): number {
  if (!raw) return 1;
  const value = raw.trim();
  if (value.endsWith("%")) return clamp(Number.parseFloat(value) / 100, 0, 1);
  return clamp(Number.parseFloat(value), 0, 1);
}

function parseRgbChannel(raw: string): number {
  const value = raw.trim();
  if (value.endsWith("%")) return clamp(Math.round(Number.parseFloat(value) * 2.55), 0, 255);
  return clamp(Math.round(Number.parseFloat(value)), 0, 255);
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);
  if (s === 0) {
    const channel = Math.round(l * 255);
    return [channel, channel, channel];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ];
}

export function parseCssForegroundColor(rawValue: string): RgbColor | null {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (!raw || /^(?:inherit|initial|unset|revert|revert-layer|currentcolor)$/.test(raw)) return null;
  if (raw.includes("var(")) return null;
  if (raw === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const named = NAMED_COLORS[raw];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };

  const hex = raw.match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
        a: hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
  }

  const rgb = raw.match(/^rgba?\((.*)\)$/i)?.[1];
  if (rgb != null) {
    const [channelsRaw, slashAlpha] = rgb.split(/\s*\/\s*/, 2);
    const parts = channelsRaw.includes(",")
      ? channelsRaw.split(",").map((part) => part.trim())
      : channelsRaw.trim().split(/\s+/);
    const commaAlpha = parts.length === 4 ? parts.pop() : undefined;
    if (parts.length === 3 && parts.every((part) => Number.isFinite(Number.parseFloat(part)))) {
      return {
        r: parseRgbChannel(parts[0]),
        g: parseRgbChannel(parts[1]),
        b: parseRgbChannel(parts[2]),
        a: parseAlpha(slashAlpha || commaAlpha),
      };
    }
  }

  const hsl = raw.match(/^hsla?\((.*)\)$/i)?.[1];
  if (hsl != null) {
    const [channelsRaw, slashAlpha] = hsl.split(/\s*\/\s*/, 2);
    const parts = channelsRaw.includes(",")
      ? channelsRaw.split(",").map((part) => part.trim())
      : channelsRaw.trim().split(/\s+/);
    const commaAlpha = parts.length === 4 ? parts.pop() : undefined;
    if (parts.length === 3 && parts[1].endsWith("%") && parts[2].endsWith("%")) {
      const [r, g, b] = hslToRgb(
        Number.parseFloat(parts[0]),
        Number.parseFloat(parts[1]) / 100,
        Number.parseFloat(parts[2]) / 100,
      );
      return { r, g, b, a: parseAlpha(slashAlpha || commaAlpha) };
    }
  }

  return null;
}

/** Convert legacy <font color> into a span style before the paste sanitizer removes the tag. */
export function normalizeLegacyFontColors(html: string): string {
  if (!html || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("font[color]").forEach((font) => {
    const span = doc.createElement("span");
    const color = font.getAttribute("color") || "";
    if (parseCssForegroundColor(color)) span.style.color = color;
    for (const child of Array.from(font.childNodes)) span.appendChild(child);
    font.replaceWith(span);
  });
  return doc.body.innerHTML;
}

export function analyzeRiskyForegroundColors(html: string): RiskyForegroundColorReport {
  const report: RiskyForegroundColorReport = { total: 0, dark: 0, light: 0, colors: [] };
  if (!html || typeof DOMParser === "undefined") return report;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const samples = new Set<string>();

  doc.body.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const raw = element.style.getPropertyValue("color").trim();
    if (!raw) return;
    const parsed = parseCssForegroundColor(raw);
    if (!parsed || parsed.a <= 0.05) return;
    const average = (parsed.r + parsed.g + parsed.b) / 3;
    if (average < 50) {
      report.total += 1;
      report.dark += 1;
      samples.add(raw);
    } else if (average > 200) {
      report.total += 1;
      report.light += 1;
      samples.add(raw);
    }
  });

  doc.body.querySelectorAll("font[color]").forEach((element) => {
    const raw = element.getAttribute("color")?.trim() || "";
    const parsed = parseCssForegroundColor(raw);
    if (!parsed || parsed.a <= 0.05) return;
    const average = (parsed.r + parsed.g + parsed.b) / 3;
    if (average < 50) {
      report.total += 1;
      report.dark += 1;
      samples.add(raw);
    } else if (average > 200) {
      report.total += 1;
      report.light += 1;
      samples.add(raw);
    }
  });

  report.colors = Array.from(samples).slice(0, 8);
  return report;
}

/** Remove only explicit foreground colors; all other markup and inline styles are preserved. */
export function stripExplicitForegroundColors(html: string): string {
  if (!html || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.body.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    if (!element.style.getPropertyValue("color")) return;
    element.style.removeProperty("color");
    if (!element.getAttribute("style")?.trim()) element.removeAttribute("style");
  });
  doc.body.querySelectorAll("font[color]").forEach((element) => element.removeAttribute("color"));
  return doc.body.innerHTML;
}
