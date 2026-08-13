export * from "./exportServiceCore";

import { saveAs } from "file-saver";
import { api, resolveAttachmentUrl } from "./api";
import { normalizeToMarkdown } from "./contentFormat";
import { exportSingleNote as exportSingleNoteCore } from "./exportServiceCore";

function sanitizeSingleNoteExportFilename(name: string): string {
  return name.replace(/[\/\\?<>:*|"]/g, "_").replace(/\s+/g, " ").trim() || "未命名";
}

function buildSingleNoteFrontmatter(note: {
  title: string;
  contentFormat?: string;
  createdAt: string;
  updatedAt: string;
}): string {
  return [
    "---",
    `title: "${note.title.replace(/"/g, '\\"')}"`,
    `contentFormat: "${note.contentFormat || "tiptap-json"}"`,
    `created: ${note.createdAt}`,
    `updated: ${note.updatedAt}`,
    "---",
    "",
  ].join("\n");
}

async function waitForMarkdownExportJob(job: Awaited<ReturnType<typeof api.createMarkdownExportJob>>["job"]) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let current = job;
  while (current.state === "queued" || current.state === "building") {
    if (Date.now() > deadline) throw new Error("导出任务超时，请稍后重试");
    await new Promise((resolve) => setTimeout(resolve, 300));
    current = (await api.getMarkdownExportJob(current.id)).job;
  }
  if (current.state === "error") throw new Error(current.message || "生成 ZIP 失败");
  if (!current.downloadToken) throw new Error("导出任务完成但没有生成下载链接");
  return current;
}

function markdownAttachmentImageRegex(): RegExp {
  return /(!\[[^\]]*\]\(\s*)(<?[^)\s>]*\/api\/attachments\/[^)\s>]+>?)(?=\s*(?:["'][^"']*["'])?\))/gi;
}

function attachmentRuntimePath(src: string): string {
  const clean = src.replace(/^<|>$/g, "");
  const match = clean.match(/\/api\/attachments\/[^/?#\s)>]+/i);
  return match?.[0] || clean;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(offset, offset + chunkSize) as unknown as number[],
    );
  }
  return btoa(binary);
}

async function inlineMarkdownAttachmentImages(markdown: string): Promise<{
  markdown: string;
  inlined: number;
  failed: number;
}> {
  const matches = Array.from(markdown.matchAll(markdownAttachmentImageRegex()));
  if (matches.length === 0) return { markdown, inlined: 0, failed: 0 };

  const token = typeof localStorage !== "undefined" ? localStorage.getItem("nowen-token") : null;
  const replacements = new Map<string, string>();
  let failed = 0;

  for (const match of matches) {
    const rawSrc = match[2];
    if (replacements.has(rawSrc)) continue;
    try {
      const response = await fetch(resolveAttachmentUrl(attachmentRuntimePath(rawSrc)), {
        credentials: "include",
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mime = (response.headers.get("content-type") || "").split(";")[0].trim();
      if (!/^image\//i.test(mime)) throw new Error(`unexpected MIME: ${mime || "unknown"}`);
      const body = await response.arrayBuffer();
      if (body.byteLength === 0) throw new Error("empty image body");
      replacements.set(rawSrc, `data:${mime};base64,${arrayBufferToBase64(body)}`);
    } catch (error) {
      failed += 1;
      console.warn(`[exportSingleNote] failed to inline fallback image: ${rawSrc}`, error);
    }
  }

  const inlined = replacements.size;
  const output = markdown.replace(markdownAttachmentImageRegex(), (full, prefix: string, src: string) => {
    const replacement = replacements.get(src);
    return replacement ? `${prefix}${replacement}` : full;
  });
  return { markdown: output, inlined, failed };
}

async function saveSelfContainedImageMarkdownFallback(
  note: Awaited<ReturnType<typeof api.getNote>>,
  markdown: string,
  safeTitle: string,
  cause: unknown,
): Promise<boolean> {
  const fallback = await inlineMarkdownAttachmentImages(markdown);
  if (fallback.inlined === 0 || fallback.failed > 0 || /\/api\/attachments\//i.test(fallback.markdown)) {
    return false;
  }

  console.warn(
    "[exportSingleNote] server ZIP export failed; saved a self-contained Markdown fallback instead.",
    cause,
  );
  const content = buildSingleNoteFrontmatter(note) + fallback.markdown;
  saveAs(new Blob([content], { type: "text/markdown;charset=utf-8" }), `${safeTitle}.md`);
  return true;
}

/**
 * 单篇导出必须区分原生 Markdown 与富文本：
 * - 原生 Markdown 直接保留源码，只让后端 ZIP 任务处理附件 URL；
 * - Tiptap/HTML 继续复用原有 HTML → Turndown 转换链路；
 * - forceZip 复用同一后端任务，即使没有附件也生成单篇 ZIP；
 * - 若“图片 → 后端 ZIP”链路失败（桌面端/共享权限/反代环境最容易触发），
 *   再把可访问图片内嵌成 data URI，保存为自包含 .md，避免整次导出直接失败。
 *
 * 这避免 Markdown 被当作 HTML 文本节点后发生空白折叠，以及标题被转义为 `\\###`。
 */
export async function exportSingleNote(
  noteId: string,
  options?: { inlineImages?: boolean; forceZip?: boolean },
): Promise<boolean> {
  try {
    const note = await api.getNote(noteId);
    if (note.contentFormat !== "markdown") {
      const exported = await exportSingleNoteCore(noteId, options);
      if (exported) return true;

      // 用户明确选择 ZIP 时不能悄悄降级成 .md；让菜单显示真实失败。
      if (options?.forceZip) return false;

      // Core 会把服务器打包错误收敛为 false。只对“正文里确实有 Nowen 图片”的场景
      // 做兜底，避免把无关的格式/权限错误伪装成成功。
      const markdown = normalizeToMarkdown(note.content, note.contentText);
      const safeTitle = sanitizeSingleNoteExportFilename(note.title);
      return saveSelfContainedImageMarkdownFallback(
        note,
        markdown,
        safeTitle,
        new Error("rich-text Markdown package export failed"),
      );
    }

    const inlineImages = options?.inlineImages === true;
    const forceZip = options?.forceZip === true;
    const markdown = note.content || note.contentText || "";
    const safeTitle = sanitizeSingleNoteExportFilename(note.title);
    const hasServerAssets = /\/api\/attachments\//i.test(markdown);

    if (!inlineImages && (forceZip || hasServerAssets)) {
      try {
        const created = await api.createMarkdownExportJob([{
          id: note.id,
          title: note.title,
          notebookName: null,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
          contentFormat: note.contentFormat,
          markdown,
          inlineAssets: [],
        }], {
          inlineImages: false,
          layout: "flat",
          filenameBase: safeTitle,
        });
        const job = await waitForMarkdownExportJob(created.job);
        api.downloadMarkdownExport(job.downloadToken!, job.filename);
        if (job.warnings > 0) console.warn(`[exportSingleNote] ${job.message}`);
        return true;
      } catch (packageError) {
        if (!forceZip && await saveSelfContainedImageMarkdownFallback(note, markdown, safeTitle, packageError)) {
          return true;
        }
        throw packageError;
      }
    }

    const content = buildSingleNoteFrontmatter(note) + markdown;
    saveAs(new Blob([content], { type: "text/markdown;charset=utf-8" }), `${safeTitle}.md`);
    return true;
  } catch (error) {
    console.error("导出失败:", error);
    return false;
  }
}
