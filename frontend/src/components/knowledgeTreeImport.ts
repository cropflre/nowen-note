import { prompt as appPrompt } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  importMarkdownFileIntoKnowledgeTree,
  MAX_MARKDOWN_DROP_FILES,
  MAX_MARKDOWN_DROP_FILE_SIZE,
  MAX_MARKDOWN_DROP_TOTAL_SIZE,
  pickMarkdownFiles,
} from "@/lib/knowledgeTreeMarkdownDrop";
import { toast } from "@/lib/toast";

type LoadedNote = Awaited<ReturnType<typeof api.getNote>>;

interface KnowledgeTreeImportOptions {
  parent: KnowledgeTreeNode | null;
  nodes: KnowledgeTreeNode[];
  fallbackNotebookId: string | null;
}

async function resolvePhysicalNotebookId({
  parent,
  nodes,
  fallbackNotebookId,
}: KnowledgeTreeImportOptions): Promise<string> {
  if (parent) {
    let cursor: KnowledgeTreeNode | undefined = parent;
    const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.resourceType === "notebook") return cursor.resourceId;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    if (parent.resourceType === "note") {
      return (await api.getNote(parent.resourceId)).notebookId;
    }
  }
  if (fallbackNotebookId) return fallbackNotebookId;
  const notebooks = await api.getNotebooks();
  if (notebooks[0]?.id) return notebooks[0].id;
  throw new Error("请先创建一个目录，再导入内容");
}

async function moveImportedNote(
  noteId: string,
  notebookId: string,
  parent: KnowledgeTreeNode | null,
): Promise<void> {
  const targetParentId = parent?.id ?? null;
  if (targetParentId !== `notebook:${notebookId}`) {
    await knowledgeTreeApi.move(`note:${noteId}`, { parentId: targetParentId });
  }
}

export async function importWordIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const notebookId = await resolvePhysicalNotebookId(options);
  const { pickDocxFile, importDocxAsNote } = await import("@/lib/wordNoteService");
  const file = await pickDocxFile();
  if (!file) return null;
  const toastId = toast.info("正在导入 Word 文档…", 0);
  try {
    const { note } = await importDocxAsNote({ notebookId, file });
    await moveImportedNote(note.id, notebookId, options.parent);
    toast.dismiss(toastId);
    toast.success("导入成功");
    return note as LoadedNote;
  } catch (error) {
    toast.dismiss(toastId);
    throw error;
  }
}

export async function importMarkdownIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const files = await pickMarkdownFiles();
  if (files.length === 0) return null;
  if (files.length > MAX_MARKDOWN_DROP_FILES) {
    throw new Error(`单次最多导入 ${MAX_MARKDOWN_DROP_FILES} 个 Markdown 文件`);
  }
  if (files.some((file) => file.size > MAX_MARKDOWN_DROP_FILE_SIZE)) {
    throw new Error("单个 Markdown 文件不能超过 20 MB");
  }
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_MARKDOWN_DROP_TOTAL_SIZE) {
    throw new Error("本次 Markdown 文件总大小不能超过 100 MB");
  }

  const toastId = toast.info(`正在导入 ${files.length} 个 Markdown 文件…`, 0);
  const imported: LoadedNote[] = [];
  const failures: Array<{ name: string; reason: string }> = [];
  try {
    for (const file of files) {
      try {
        imported.push(await importMarkdownFileIntoKnowledgeTree(file, options.parent?.id ?? null));
      } catch (error) {
        failures.push({
          name: file.name,
          reason: error instanceof Error ? error.message : String(error || "导入失败"),
        });
      }
    }
  } finally {
    toast.dismiss(toastId);
  }

  if (imported.length === 0) {
    const first = failures[0];
    throw new Error(first ? `${first.name}：${first.reason}` : "Markdown 文件导入失败");
  }
  if (failures.length > 0) {
    toast.warning(`已导入 ${imported.length} 个，失败 ${failures.length} 个`, 6000);
  } else {
    toast.success(`已导入 ${imported.length} 个 Markdown 文件`);
  }
  return imported[0];
}

export async function importWeChatArticleIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const raw = await appPrompt({
    title: "导入公众号文章",
    description: "请输入微信公众号文章链接",
    placeholder: "https://mp.weixin.qq.com/s/...",
    confirmText: "导入",
    validate: (value) => {
      const url = value.trim();
      if (!url) return "请输入文章链接";
      return /^https:\/\/mp\.weixin\.qq\.com\/s[\/?]/.test(url) ? null : "暂只支持微信公众号文章链接";
    },
  });
  if (raw == null) return null;
  const notebookId = await resolvePhysicalNotebookId(options);
  const toastId = toast.info("正在导入文章…", 0);
  try {
    const result = await api.urlImport(raw.trim(), notebookId);
    await moveImportedNote(result.noteId, notebookId, options.parent);
    const note = await api.getNote(result.noteId);
    toast.dismiss(toastId);
    toast.success(`已导入：${result.title}`);
    return note;
  } catch (error) {
    toast.dismiss(toastId);
    throw error;
  }
}
