import JSZip from "jszip";
import { saveAs } from "file-saver";
import TurndownService from "turndown";
import { api } from "./api";

interface ExportNote {
  id: string;
  title: string;
  content: string;
  contentText: string;
  notebookName: string | null;
  createdAt: string;
  updatedAt: string;
}

// 清理文件名中的非法字符
function sanitizeFilename(name: string): string {
  return name.replace(/[\/\\?<>:*|"]/g, "_").replace(/\s+/g, " ").trim() || "无标题";
}

// 初始化 Turndown (HTML → Markdown)
function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // 自定义 task list 转换
  td.addRule("taskListItem", {
    filter: (node) => {
      return (
        node.nodeName === "LI" &&
        node.getAttribute("data-type") === "taskItem"
      );
    },
    replacement: (content, node) => {
      const checked = (node as Element).getAttribute("data-checked") === "true";
      const cleanContent = content.replace(/^\n+/, "").replace(/\n+$/, "");
      return `${checked ? "- [x]" : "- [ ]"} ${cleanContent}\n`;
    },
  });

  // 高亮文本
  td.addRule("highlight", {
    filter: "mark",
    replacement: (content) => `==${content}==`,
  });

  return td;
}

export type ExportProgress = {
  phase: "fetching" | "converting" | "packing" | "done" | "error";
  current: number;
  total: number;
  message: string;
};

export async function exportAllNotes(
  onProgress?: (p: ExportProgress) => void
): Promise<boolean> {
  try {
    // 1. 获取所有笔记
    onProgress?.({ phase: "fetching", current: 0, total: 0, message: "正在获取笔记数据..." });
    const notes = await api.getExportNotes() as ExportNote[];

    if (!notes || notes.length === 0) {
      onProgress?.({ phase: "error", current: 0, total: 0, message: "没有可导出的笔记" });
      return false;
    }

    const total = notes.length;
    const zip = new JSZip();
    const td = createTurndown();

    // 2. 转换并打包
    const folderCounts = new Map<string, number>();

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      onProgress?.({ phase: "converting", current: i + 1, total, message: `正在转换: ${note.title}` });

      // 解析 content (Tiptap JSON -> HTML)
      let html = "";
      try {
        const parsed = JSON.parse(note.content);
        // 如果是 Tiptap JSON，尝试用 contentText 作为 fallback
        html = parsed.content ? note.content : note.contentText || "";
      } catch {
        // content 可能直接是 HTML 或纯文本
        html = note.content || note.contentText || "";
      }

      // 转换为 Markdown
      let markdown: string;
      if (html.startsWith("{") || html.startsWith("[")) {
        // JSON 格式，直接用 contentText
        markdown = note.contentText || "";
      } else {
        markdown = td.turndown(html);
      }

      // 添加 YAML frontmatter
      const frontmatter = [
        "---",
        `title: "${note.title.replace(/"/g, '\\"')}"`,
        `created: ${note.createdAt}`,
        `updated: ${note.updatedAt}`,
        "---",
        "",
      ].join("\n");

      const fullContent = frontmatter + markdown;

      // 确定文件路径
      const folder = note.notebookName ? sanitizeFilename(note.notebookName) : "未分类";
      const count = folderCounts.get(folder) || 0;
      folderCounts.set(folder, count + 1);

      let fileName = sanitizeFilename(note.title);
      // 避免同名文件冲突
      const testPath = `${folder}/${fileName}.md`;
      if (zip.file(testPath)) {
        fileName = `${fileName}_${count + 1}`;
      }

      zip.file(`${folder}/${fileName}.md`, fullContent);
    }

    // 3. 添加元数据
    zip.file(
      "metadata.json",
      JSON.stringify({
        version: "1.0",
        app: "nowen-note",
        exportedAt: new Date().toISOString(),
        totalNotes: total,
        notebooks: Array.from(folderCounts.entries()).map(([name, count]) => ({ name, count })),
      }, null, 2)
    );

    // 4. 生成 ZIP
    onProgress?.({ phase: "packing", current: total, total, message: "正在生成压缩包..." });
    const blob = await zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      },
      (meta) => {
        onProgress?.({
          phase: "packing",
          current: Math.round(meta.percent),
          total: 100,
          message: `压缩中 ${Math.round(meta.percent)}%...`,
        });
      }
    );

    // 5. 触发下载
    const date = new Date().toISOString().slice(0, 10);
    saveAs(blob, `nowen-note_backup_${date}.zip`);

    onProgress?.({ phase: "done", current: total, total, message: "导出成功！" });
    return true;
  } catch (error) {
    console.error("导出失败:", error);
    onProgress?.({ phase: "error", current: 0, total: 0, message: `导出失败: ${(error as Error).message}` });
    return false;
  }
}

// 单篇导出为 Markdown
export async function exportSingleNote(noteId: string): Promise<boolean> {
  try {
    const note = await api.getNote(noteId);
    const td = createTurndown();

    let html = "";
    try {
      JSON.parse(note.content);
      html = note.contentText || "";
    } catch {
      html = note.content || note.contentText || "";
    }

    const markdown = html.startsWith("{") || html.startsWith("[")
      ? note.contentText || ""
      : td.turndown(html);

    const frontmatter = [
      "---",
      `title: "${note.title.replace(/"/g, '\\"')}"`,
      `created: ${note.createdAt}`,
      `updated: ${note.updatedAt}`,
      "---",
      "",
    ].join("\n");

    const blob = new Blob([frontmatter + markdown], { type: "text/markdown;charset=utf-8" });
    saveAs(blob, `${sanitizeFilename(note.title)}.md`);
    return true;
  } catch (error) {
    console.error("导出失败:", error);
    return false;
  }
}
