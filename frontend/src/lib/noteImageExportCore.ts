/**
 * Public note-image export facade.
 *
 * Mermaid diagrams are runtime-rendered in the editor, while the raster export engine
 * works from serialized note content. Resolve Mermaid code blocks to self-contained SVG
 * images before delegating to the stable raster/SVG engine so PNG/JPEG/SVG exports match
 * what the user sees in the browser.
 */
export * from "./noteImageExportCoreBase";

import {
  exportNoteImageDetailed as exportNoteImageDetailedBase,
  type NoteImageExportOptions,
  type NoteImageExportResult,
} from "./noteImageExportCoreBase";
import { noteContentToExportHtml } from "@/lib/exportService";
import { isMermaidLang, renderMermaid } from "@/lib/mermaidRenderer";
import { sanitizeSvg } from "@/lib/sanitizeHtml";
import type { ExportableNoteImageSource } from "@/lib/noteImageExportBridge";

interface MermaidExportPreparation {
  note: ExportableNoteImageSource;
  rendered: number;
  failed: number;
}

function mayContainMermaid(note: ExportableNoteImageSource): boolean {
  const source = `${note.content || ""}\n${note.contentText || ""}`;
  return /(?:```[ \t]*(?:mermaid|mmd)\b|language-(?:mermaid|mmd)\b|data-language=["'](?:mermaid|mmd)["']|"language"\s*:\s*"(?:mermaid|mmd)")/i.test(source);
}

function codeBlockLanguage(code: HTMLElement): string {
  const languageClass = Array.from(code.classList).find(
    (name) => name.startsWith("language-") || name.startsWith("lang-"),
  );
  if (languageClass?.startsWith("language-")) return languageClass.slice("language-".length);
  if (languageClass?.startsWith("lang-")) return languageClass.slice("lang-".length);
  return code.parentElement?.getAttribute("data-language") || "";
}

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function prepareMermaidForImageExport(
  note: ExportableNoteImageSource,
): Promise<MermaidExportPreparation> {
  if (!mayContainMermaid(note)) return { note, rendered: 0, failed: 0 };

  const html = noteContentToExportHtml(
    note.content || "",
    note.contentText || "",
    note.contentFormat,
  );
  const template = document.createElement("template");
  template.innerHTML = html;

  const codeBlocks = Array.from(template.content.querySelectorAll("pre > code")) as HTMLElement[];
  let rendered = 0;
  let failed = 0;

  // Render serially. Mermaid keeps process-wide render/config state and rendering multiple
  // blocks concurrently can make IDs/configuration race in some browsers.
  for (const code of codeBlocks) {
    if (!isMermaidLang(codeBlockLanguage(code))) continue;

    const source = code.textContent || "";
    if (!source.trim()) continue;

    const pre = code.parentElement;
    if (!pre) continue;

    const result = await renderMermaid(source);
    if (!result.svg) {
      failed += 1;
      console.warn(
        "[note-image-export] Mermaid render failed; keeping source code in exported image.",
        result.error,
      );
      continue;
    }

    const svg = sanitizeSvg(result.svg);
    if (!/<svg\b/i.test(svg)) {
      failed += 1;
      console.warn(
        "[note-image-export] Mermaid SVG was empty after sanitization; keeping source code.",
      );
      continue;
    }

    const figure = document.createElement("figure");
    figure.className = "nowen-note-image-export-mermaid";
    figure.setAttribute("data-nowen-mermaid-export", "rendered");

    const image = document.createElement("img");
    image.src = svgToDataUri(svg);
    image.alt = "Mermaid diagram";
    image.setAttribute("data-nowen-mermaid-export-image", "true");
    figure.appendChild(image);

    pre.replaceWith(figure);
    rendered += 1;
  }

  if (rendered === 0) return { note, rendered, failed };

  return {
    note: {
      ...note,
      content: template.innerHTML,
      contentText: "",
      // The Mermaid blocks have already been materialized into data-URI SVG images.
      // Treat the prepared document as HTML so the base exporter does not parse it again
      // as Markdown/Tiptap JSON and turn the diagram back into source code.
      contentFormat: "html",
    },
    rendered,
    failed,
  };
}

export async function exportNoteImageDetailed(
  note: ExportableNoteImageSource,
  options: NoteImageExportOptions,
): Promise<NoteImageExportResult> {
  const prepared = await prepareMermaidForImageExport(note);
  const result = await exportNoteImageDetailedBase(prepared.note, options);

  if (prepared.failed === 0) return result;

  return {
    ...result,
    warnings: [
      ...result.warnings,
      `有 ${prepared.failed} 个 Mermaid 图表渲染失败，导出结果中已保留源码。`,
    ],
  };
}
