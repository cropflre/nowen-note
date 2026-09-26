export const EXPORT_CANVAS_CONTENT_ERROR = "导出失败：未正确渲染文档内容，请重试";

/** A rendered title must not disguise a dropped note body. */
export function assertExportHtmlHasContent(contentText: string, html: string, exportType: string): void {
  if (!contentText.trim()) return;
  const body = document.createElement("div");
  body.innerHTML = html;
  if (body.textContent?.trim() || body.querySelector("img, svg, canvas, video, iframe")) return;
  console.warn("[export-content]", { exportType, reason: "missing-body", sourceLength: contentText.length });
  throw new Error(EXPORT_CANVAS_CONTENT_ERROR);
}

/** Reject a successful-looking download when the rendered canvas contains only background. */
export function assertExportCanvasHasContent(canvas: HTMLCanvasElement, exportType: string): void {
  const fail = (reason: string): never => {
    console.warn("[export-canvas]", {
      exportType,
      reason,
      width: canvas.width,
      height: canvas.height,
    });
    throw new Error(EXPORT_CANVAS_CONTENT_ERROR);
  };

  if (!canvas.width || !canvas.height) fail("zero-size");
  const sampleWidth = Math.min(canvas.width, 2048);
  const sampleHeight = Math.min(canvas.height, 1024);
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    return fail("unreadable-canvas");
  }
  if (!context) return fail("missing-context");
  const offsets = [...new Set([0, Math.floor((canvas.height - sampleHeight) / 2), canvas.height - sampleHeight])];
  let background: number[] | null = null;
  let changed = 0;
  for (const offset of offsets) {
    let pixels: Uint8ClampedArray;
    try {
      pixels = context.getImageData(0, offset, sampleWidth, sampleHeight).data;
    } catch {
      return fail("unreadable-canvas");
    }
    background ||= [pixels[0], pixels[1], pixels[2], pixels[3]];
    for (let index = 0; index < pixels.length; index += 4) {
      const difference = Math.abs(pixels[index] - background[0])
        + Math.abs(pixels[index + 1] - background[1])
        + Math.abs(pixels[index + 2] - background[2])
        + Math.abs(pixels[index + 3] - background[3]);
      if (difference > 36 && ++changed >= 8) return;
    }
  }
  fail("background-only");
}
