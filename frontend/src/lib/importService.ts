import { api } from "./api";

export interface ImportFileInfo {
  name: string;
  title: string;
  content: string;
  size: number;
  selected: boolean;
}

export type ImportProgress = {
  phase: "reading" | "uploading" | "done" | "error";
  current: number;
  total: number;
  message: string;
};

// 读取拖入的文件列表
export async function readMarkdownFiles(
  files: FileList | File[]
): Promise<ImportFileInfo[]> {
  const result: ImportFileInfo[] = [];
  const fileArray = Array.from(files);

  for (const file of fileArray) {
    // 只处理 .md 和 .txt 文件
    if (!file.name.endsWith(".md") && !file.name.endsWith(".txt") && !file.name.endsWith(".markdown")) {
      continue;
    }

    const text = await file.text();
    // 从文件名推导标题（去掉扩展名）
    const title = file.name.replace(/\.(md|txt|markdown)$/i, "");

    result.push({
      name: file.name,
      title,
      content: text,
      size: file.size,
      selected: true,
    });
  }

  return result;
}

// 从 ZIP 文件中读取 Markdown
export async function readMarkdownFromZip(file: File): Promise<ImportFileInfo[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);
  const result: ImportFileInfo[] = [];

  for (const [path, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (!path.endsWith(".md") && !path.endsWith(".txt") && !path.endsWith(".markdown")) continue;
    // 跳过 metadata.json
    if (path === "metadata.json") continue;

    const text = await zipEntry.async("text");
    // 从路径推导标题
    const fileName = path.split("/").pop() || path;
    const title = fileName.replace(/\.(md|txt|markdown)$/i, "");

    result.push({
      name: path,
      title,
      content: text,
      size: text.length,
      selected: true,
    });
  }

  return result;
}

// 将 Markdown 转为简单的 HTML（用于存储到 Tiptap 格式）
function markdownToSimpleHtml(md: string): string {
  // 去除 YAML frontmatter
  let content = md.replace(/^---[\s\S]*?---\n*/m, "");

  // 基本的 Markdown → HTML 转换
  content = content
    // 标题
    .replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
    .replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
    .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
    // 粗体和斜体
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // 删除线
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    // 高亮
    .replace(/==(.+?)==/g, "<mark>$1</mark>")
    // 行内代码
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // 待办列表
    .replace(/^- \[x\]\s+(.+)$/gm, '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div>$1</div></li></ul>')
    .replace(/^- \[ \]\s+(.+)$/gm, '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div>$1</div></li></ul>')
    // 无序列表
    .replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>")
    // 有序列表
    .replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>")
    // 链接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // 图片
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
    // 水平线
    .replace(/^---$/gm, "<hr />")
    // 段落（将非 HTML 行包裹在 <p> 中）
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("<")) return trimmed;
      return `<p>${trimmed}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  return content;
}

// 执行导入
export async function importNotes(
  fileInfos: ImportFileInfo[],
  notebookId?: string,
  onProgress?: (p: ImportProgress) => void
): Promise<{ success: boolean; count: number }> {
  const selected = fileInfos.filter((f) => f.selected);

  if (selected.length === 0) {
    onProgress?.({ phase: "error", current: 0, total: 0, message: "没有选择要导入的文件" });
    return { success: false, count: 0 };
  }

  try {
    onProgress?.({ phase: "uploading", current: 0, total: selected.length, message: "正在上传..." });

    const notes = selected.map((f) => {
      const html = markdownToSimpleHtml(f.content);
      // 提取纯文本（去掉 HTML 标签）用于搜索
      const contentText = f.content
        .replace(/^---[\s\S]*?---\n*/m, "")
        .replace(/[#*_~`\[\]()>|-]/g, "")
        .trim();

      return {
        title: f.title,
        content: html,
        contentText,
      };
    });

    const result = await api.importNotes(notes, notebookId);

    onProgress?.({
      phase: "done",
      current: result.count,
      total: selected.length,
      message: `成功导入 ${result.count} 篇笔记`,
    });

    return { success: true, count: result.count };
  } catch (error) {
    console.error("导入失败:", error);
    onProgress?.({
      phase: "error",
      current: 0,
      total: selected.length,
      message: `导入失败: ${(error as Error).message}`,
    });
    return { success: false, count: 0 };
  }
}
