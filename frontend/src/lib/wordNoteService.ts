// lib/wordNoteService.ts —— Word 笔记创建、附件替换、导入和导出入口

import { api } from "./api";
import { createBlankDocx, blankDocxFile, tiptapToIr, createDocx } from "@/office";
import type { Note } from "@/types";
import {
  importDocxAsNoteSafe,
  type ImportDocxAsNoteParams,
  type ImportDocxAsNoteResult,
} from "@/lib/docxImportService";
import { runManagedDocxImport } from "@/lib/docxImportProgress";

export type { ImportDocxAsNoteParams, ImportDocxAsNoteResult } from "@/lib/docxImportService";

export interface CreateWordNoteResult {
  note: Note;
  attachmentId: string;
  attachmentUrl: string;
}

interface CreateWordNoteParams {
  notebookId: string;
  title?: string;
  author?: string;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let value = n;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function buildContentJson(params: {
  title: string;
  filename: string;
  url: string;
  size: number;
}): string {
  const { title, filename, url, size } = params;
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: title }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "📎 " },
          {
            type: "text",
            text: `${filename} (${formatBytes(size)})`,
            marks: [
              {
                type: "link",
                attrs: {
                  href: url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                },
              },
            ],
          },
          { type: "text", text: " " },
        ],
      },
    ],
  });
}

/** 创建带空白 .docx 附件的 Word 笔记。 */
export async function createWordNote(
  params: CreateWordNoteParams,
): Promise<CreateWordNoteResult> {
  const title = (params.title || "").trim() || "新建 Word 文档";
  const filename = /\.docx$/i.test(title) ? title : `${title}.docx`;
  const baseNote = (await api.createNote({
    notebookId: params.notebookId,
    title,
  })) as Note;

  let uploaded: Awaited<ReturnType<typeof api.attachments.upload>>;
  try {
    const blob = await createBlankDocx({ title, author: params.author });
    uploaded = await api.attachments.upload(
      baseNote.id,
      blankDocxFile(filename, blob),
    );
  } catch (error) {
    throw new Error(
      `Word 文档创建失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const updated = (await api.updateNote(baseNote.id, {
    content: buildContentJson({
      title,
      filename,
      url: uploaded.url,
      size: uploaded.size,
    }),
    contentText: `📎 ${filename}`,
    version: baseNote.version,
  } as Partial<Note>)) as Note;

  return {
    note: updated,
    attachmentId: uploaded.id,
    attachmentUrl: uploaded.url,
  };
}

/** 用新文件替换 Word 笔记中的 .docx 附件。 */
export async function replaceWordAttachment(params: {
  noteId: string;
  oldAttachmentId: string;
  file: File;
}): Promise<{ attachmentId: string; attachmentUrl: string; note: Note }> {
  const { noteId, oldAttachmentId, file } = params;
  const uploaded = await api.attachments.upload(noteId, file);
  const safeName = /\.docx$/i.test(file.name) ? file.name : `${file.name}.docx`;
  const titleFromName = safeName.replace(/\.docx$/i, "");
  const latest = (await api.getNote(noteId)) as Note;
  const updatedNote = (await api.updateNote(noteId, {
    content: buildContentJson({
      title: titleFromName,
      filename: safeName,
      url: uploaded.url,
      size: uploaded.size,
    }),
    contentText: `📎 ${safeName}`,
    version: latest.version,
  } as Partial<Note>)) as Note;

  try {
    await api.attachments.remove(oldAttachmentId);
  } catch (error) {
    console.warn("旧 .docx 附件清理失败（可由后端 GC 后续清理）:", error);
  }

  return {
    attachmentId: uploaded.id,
    attachmentUrl: uploaded.url,
    note: updatedNote,
  };
}

/** 把任意 Tiptap 笔记导出为 .docx Blob。 */
export async function exportNoteAsDocx(
  noteContent: string,
  title: string,
  author?: string,
): Promise<Blob> {
  let parsed: any = null;
  try {
    parsed = JSON.parse(noteContent);
  } catch {
    parsed = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: noteContent }] },
      ],
    };
  }
  if (!parsed || parsed.type !== "doc") {
    parsed = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: String(noteContent || "") }],
        },
      ],
    };
  }
  const ir = await tiptapToIr(parsed, { title, author });
  return createDocx(ir, { title, author });
}

/** 通过服务端暂存地址下载浏览器生成的 DOCX，避免扩展拦截 Blob。 */
export async function downloadDocxBlob(blob: Blob, filename: string): Promise<void> {
  const safeName = /\.docx$/i.test(filename) ? filename : `${filename}.docx`;
  const staged = await api.stageGeneratedExport(blob, safeName);
  api.downloadMarkdownExport(staged.downloadToken, staged.filename);
}

/**
 * 导入 Word 文档。
 *
 * 所有现有入口继续调用这个函数，但实际执行由全局任务协调器接管：
 * - Worker 中完成 ZIP 预检、Mammoth 解析和图片字节抽取；
 * - 主线程只做去除 Base64 后的 Tiptap DOM 转换；
 * - 失败/取消可使用原 File 重试，并在退出前回滚中间笔记与附件。
 */
export function importDocxAsNote(
  params: ImportDocxAsNoteParams,
): Promise<ImportDocxAsNoteResult> {
  return runManagedDocxImport(params.file, ({ signal, report }) => (
    importDocxAsNoteSafe({
      ...params,
      signal,
      onProgress: report,
    })
  ));
}

/** 弹出文件选择器，取消时返回 null。 */
export function pickDocxFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    input.onchange = () => {
      settled = true;
      const file = input.files?.[0] || null;
      cleanup();
      resolve(file);
    };
    input.oncancel = () => {
      if (settled) return;
      cleanup();
      resolve(null);
    };
    input.click();
  });
}
