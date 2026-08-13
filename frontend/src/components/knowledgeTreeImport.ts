import { prompt as appPrompt } from "@/components/ui/confirm";
import { api, getCurrentWorkspace } from "@/lib/api";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  formatMarkdownImportFailures,
  importMarkdownFilesIntoKnowledgeTree,
  importMarkdownZipFilesIntoKnowledgeTree,
  markdownBatchImportedCount,
  pickMarkdownFiles,
  pickMarkdownZipFiles,
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

  const toastId = toast.info(`正在导入 ${files.length} 个 Markdown 文件…`, 0);
  let result: Awaited<ReturnType<typeof importMarkdownFilesIntoKnowledgeTree>>;
  try {
    result = await importMarkdownFilesIntoKnowledgeTree(files, options.parent?.id ?? null);
  } finally {
    toast.dismiss(toastId);
  }

  if (result.imported.length === 0) {
    throw new Error(
      result.failures.length > 0
        ? formatMarkdownImportFailures(result.failures)
        : "Markdown 文件导入失败",
    );
  }
  if (result.failures.length > 0) {
    toast.warning(
      `成功导入 ${result.imported.length} 个文件，${result.failures.length} 个失败：${formatMarkdownImportFailures(result.failures)}`,
      8000,
    );
  } else {
    toast.success(`已导入 ${result.imported.length} 个 Markdown 文件`);
  }
  return result.imported[0];
}

export async function importMarkdownZipIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  const files = await pickMarkdownZipFiles();
  if (files.length === 0) return null;

  const toastId = toast.info(`正在导入 ${files.length} 个 Markdown 附件 ZIP…`, 0);
  let result: Awaited<ReturnType<typeof importMarkdownZipFilesIntoKnowledgeTree>>;
  try {
    result = await importMarkdownZipFilesIntoKnowledgeTree(files, {
      parentId: options.parent?.id ?? null,
      targetNotebookId: options.parent?.resourceType === "notebook"
        ? options.parent.resourceId
        : undefined,
      workspaceId: options.parent
        ? options.parent.workspaceId || "personal"
        : getCurrentWorkspace(),
      targetLabel: options.parent?.title || "当前空间根目录",
    });
  } finally {
    toast.dismiss(toastId);
  }

  if (result.cancelled) return null;
  const importedCount = markdownBatchImportedCount(result);
  if (importedCount === 0) {
    throw new Error(
      result.failures.length > 0
        ? formatMarkdownImportFailures(result.failures)
        : "Markdown 附件 ZIP 导入失败",
    );
  }
  if (result.failures.length > 0) {
    toast.warning(
      `成功导入 ${importedCount} 篇笔记，${result.failures.length} 个失败：${formatMarkdownImportFailures(result.failures)}`,
      8000,
    );
  } else {
    toast.success(`已从 ZIP 导入 ${importedCount} 篇笔记`);
  }
  return result.imported[0];
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
