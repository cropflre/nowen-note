import { api } from "@/lib/api";
import type { Note } from "@/types";

export type MarkdownNoteTemplate = "heading" | "code" | "sql";

let nextMarkdownNoteTemplate: MarkdownNoteTemplate | null = null;
let installed = false;

function markdownTemplatePayload(template: MarkdownNoteTemplate): Partial<Note> {
  if (template === "code") {
    return {
      title: "无标题代码笔记",
      contentFormat: "markdown",
      content: "```text\n\n```\n",
      contentText: "",
    } as Partial<Note>;
  }

  if (template === "sql") {
    return {
      title: "无标题 SQL",
      contentFormat: "markdown",
      content: "```sql\n\n```\n",
      contentText: "",
    } as Partial<Note>;
  }

  return {
    title: "无标题 Markdown",
    contentFormat: "markdown",
    content: "# 无标题 Markdown\n\n",
    contentText: "无标题 Markdown",
  } as Partial<Note>;
}

export function setNextMarkdownNoteTemplate(template: MarkdownNoteTemplate): void {
  nextMarkdownNoteTemplate = template;
}

export function installNewNoteTemplatePatch(): void {
  if (installed) return;
  installed = true;

  const originalCreateNote = api.createNote.bind(api);
  api.createNote = ((data: Partial<Note>) => {
    const template = nextMarkdownNoteTemplate;
    if (template) {
      // 一次性模板：只影响当前这次新建，避免后续普通 Markdown 笔记被意外污染。
      nextMarkdownNoteTemplate = null;
    }

    if (template && data?.contentFormat === "markdown") {
      return originalCreateNote({
        ...data,
        ...markdownTemplatePayload(template),
        contentFormat: "markdown",
      });
    }

    return originalCreateNote(data);
  }) as typeof api.createNote;
}

installNewNoteTemplatePatch();
