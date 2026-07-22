export * from "./exportServiceCore";

import { saveAs } from "file-saver";
import { api } from "./api";
import { exportSingleNote as exportSingleNoteCore } from "./exportServiceCore";

function sanitizeSingleNoteExportFilename(name: string): string {
  return name.replace(/[\/\\?<>:*|"]/g, "_").replace(/\s+/g, " ").trim() || "未命名";
}

function buildSingleNoteFrontmatter(note: {
  title: string;
  createdAt: string;
  updatedAt: string;
}): string {
  return [
    "---",
    `title: "${note.title.replace(/"/g, '\\"')}"`,
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

/**
 * 单篇导出必须区分原生 Markdown 与富文本：
 * - 原生 Markdown 直接保留源码，只让后端 ZIP 任务处理附件 URL；
 * - Tiptap/HTML 继续复用原有 HTML → Turndown 转换链路。
 *
 * 这避免 Markdown 被当作 HTML 文本节点后发生空白折叠，以及标题被转义为 `\\###`。
 */
export async function exportSingleNote(
  noteId: string,
  options?: { inlineImages?: boolean },
): Promise<boolean> {
  try {
    const note = await api.getNote(noteId);
    if (note.contentFormat !== "markdown") {
      return exportSingleNoteCore(noteId, options);
    }

    const inlineImages = options?.inlineImages === true;
    const markdown = note.content || note.contentText || "";
    const safeTitle = sanitizeSingleNoteExportFilename(note.title);
    const hasServerAssets = /\/api\/attachments\//i.test(markdown);

    if (!inlineImages && hasServerAssets) {
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
    }

    const content = buildSingleNoteFrontmatter(note) + markdown;
    saveAs(new Blob([content], { type: "text/markdown;charset=utf-8" }), `${safeTitle}.md`);
    return true;
  } catch (error) {
    console.error("导出失败:", error);
    return false;
  }
}
