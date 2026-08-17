const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 360;
const MAX_PIXEL_RATIO = 2;
const LOAD_TIMEOUT_MS = 10_000;

export interface RasterizedMermaidSvg {
  dataUri: string;
  width: number;
  height: number;
}

function finitePositive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function numericLength(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)(?:px)?$/i);
  return match ? finitePositive(Number.parseFloat(match[1])) : null;
}

function readSvgSize(svg: string): { width: number | null; height: number | null } {
  try {
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg") return { width: null, height: null };

    const viewBox = (root.getAttribute("viewBox") || "")
      .trim()
      .split(/[\s,]+/)
      .map((part) => Number.parseFloat(part));
    if (viewBox.length === 4) {
      const width = finitePositive(viewBox[2]);
      const height = finitePositive(viewBox[3]);
      if (width && height) return { width, height };
    }

    return {
      width: numericLength(root.getAttribute("width")),
      height: numericLength(root.getAttribute("height")),
    };
  } catch {
    return { width: null, height: null };
  }
}

function ensureStandaloneSvg(svg: string): string {
  if (/\sxmlns\s*=/.test(svg)) return svg;
  return svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

async function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const blob = new Blob([ensureStandaloneSvg(svg)], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const image = new Image();

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("MERMAID_SVG_LOAD_TIMEOUT")), LOAD_TIMEOUT_MS);
      image.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      image.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("MERMAID_SVG_LOAD_FAILED"));
      };
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * html2canvas can silently skip an SVG data URL even after the browser has laid out the
 * corresponding <img>. Rasterize Mermaid with the browser first, then let html2canvas deal
 * only with an ordinary PNG. This also gives the export DOM explicit dimensions, avoiding
 * the large blank boxes produced by SVGs whose width is expressed as a percentage.
 */
export async function rasterizeMermaidSvgForExport(
  svg: string,
  maxCssWidth: number,
  pixelRatio = MAX_PIXEL_RATIO,
): Promise<RasterizedMermaidSvg> {
  if (!svg.trim()) throw new Error("MERMAID_SVG_EMPTY");

  const declared = readSvgSize(svg);
  const image = await loadSvgImage(svg);
  const sourceWidth = declared.width || finitePositive(image.naturalWidth) || DEFAULT_WIDTH;
  const sourceHeight = declared.height || finitePositive(image.naturalHeight) || DEFAULT_HEIGHT;
  const cssWidth = Math.min(Math.max(1, maxCssWidth), sourceWidth);
  const cssHeight = Math.max(1, sourceHeight * (cssWidth / sourceWidth));
  const ratio = Math.min(MAX_PIXEL_RATIO, Math.max(1, pixelRatio || 1));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(cssWidth * ratio));
  canvas.height = Math.max(1, Math.ceil(cssHeight * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("MERMAID_CANVAS_CONTEXT_UNAVAILABLE");

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    dataUri: canvas.toDataURL("image/png"),
    width: cssWidth,
    height: cssHeight,
  };
}
