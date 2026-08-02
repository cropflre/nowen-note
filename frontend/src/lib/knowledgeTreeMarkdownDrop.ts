import { api } from "@/lib/api";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import { toast } from "@/lib/toast";

const TREE_SELECTOR = '[data-nowen-knowledge-tree="embedded"]';
const TREE_NODE_SELECTOR = "[data-knowledge-tree-node-id]";
const ACTIVE_DROP_CLASS = "knowledge-tree-markdown-drop-target";
const TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

export const MAX_MARKDOWN_DROP_FILES = 100;
export const MAX_MARKDOWN_DROP_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_MARKDOWN_DROP_TOTAL_SIZE = 100 * 1024 * 1024;

let installed = false;
let importing = false;
let activeDropRow: HTMLElement | null = null;

export function isMarkdownDropFile(file: Pick<File, "name">): boolean {
  return /\.(?:md|markdown)$/i.test(String(file.name || "").trim());
}

export function isWordDropFile(file: Pick<File, "name">): boolean {
  return /\.docx$/i.test(String(file.name || "").trim());
}

export function markdownDropTitle(fileName: string): string {
  const normalized = String(fileName || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.(?:md|markdown)$/i, "")
    .trim();
  return normalized || "未命名 Markdown";
}

export function hasExternalFilePayload(dataTransfer: Pick<DataTransfer, "types" | "items">): boolean {
  if (Array.from(dataTransfer.types || []).some((type) => type === "Files")) return true;
  return Array.from(dataTransfer.items || []).some((item) => item.kind === "file");
}

export function markdownFilesFromDataTransfer(dataTransfer: Pick<DataTransfer, "files">): File[] {
  return Array.from(dataTransfer.files || []).filter(isMarkdownDropFile);
}

export function knowledgeTreeFilesFromDataTransfer(dataTransfer: Pick<DataTransfer, "files">): File[] {
  return Array.from(dataTransfer.files || []).filter((file) => (
    isMarkdownDropFile(file) || isWordDropFile(file)
  ));
}

/** 打开系统文件选择器，支持一次选择多个 Markdown 文件。 */
export function pickMarkdownFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,text/markdown,text/x-markdown";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => input.remove();
    input.onchange = () => {
      settled = true;
      const files = Array.from(input.files || []).filter(isMarkdownDropFile);
      cleanup();
      resolve(files);
    };
    input.oncancel = () => {
      if (settled) return;
      cleanup();
      resolve([]);
    };
    input.click();
  });
}

export function findKnowledgeTreeDropRow(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(TREE_NODE_SELECTOR);
  if (!row || !row.closest(TREE_SELECTOR)) return null;
  return row;
}

function setActiveDropRow(row: HTMLElement | null): void {
  if (activeDropRow === row) return;
  activeDropRow?.classList.remove(ACTIVE_DROP_CLASS);
  activeDropRow = row;
  activeDropRow?.classList.add(ACTIVE_DROP_CLASS);
}

function clearActiveDropRow(): void {
  setActiveDropRow(null);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

interface KnowledgeTreeDropTarget {
  node: KnowledgeTreeNode;
  nodes: KnowledgeTreeNode[];
}

async function resolveTargetNode(nodeId: string): Promise<KnowledgeTreeDropTarget | null> {
  const [ownedResult, sharedResult] = await Promise.allSettled([
    knowledgeTreeApi.list(),
    knowledgeTreeApi.listShared(),
  ]);
  const nodes: KnowledgeTreeNode[] = [];
  if (ownedResult.status === "fulfilled") nodes.push(...ownedResult.value.nodes);
  if (sharedResult.status === "fulfilled") nodes.push(...sharedResult.value.nodes);
  if (nodes.length === 0) {
    const reason = ownedResult.status === "rejected"
      ? ownedResult.reason
      : sharedResult.status === "rejected"
        ? sharedResult.reason
        : new Error("无法读取内容树");
    throw reason;
  }
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node ? { node, nodes } : null;
}

async function readMarkdownFile(file: File): Promise<string> {
  if (file.size > MAX_MARKDOWN_DROP_FILE_SIZE) {
    throw new Error(`文件超过 ${formatBytes(MAX_MARKDOWN_DROP_FILE_SIZE)} 限制`);
  }
  const text = await file.text();
  return text.replace(/^\uFEFF/, "");
}

interface MarkdownImportDocument {
  title: string | null;
  content: string;
  targetFormat: "markdown" | "tiptap-json";
}

function parseFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

export function parseMarkdownImportDocument(source: string): MarkdownImportDocument {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { title: null, content: source, targetFormat: "markdown" };

  const metadata = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (field) metadata.set(field[1].toLowerCase(), parseFrontmatterValue(field[2]));
  }

  const declaredFormat = (
    metadata.get("sourcecontentformat")
    || metadata.get("contentformat")
    || ""
  ).toLowerCase();
  const isNowenExport = Boolean(declaredFormat);
  const targetFormat = declaredFormat === "tiptap-json"
    || declaredFormat === "html"
    ? "tiptap-json"
    : "markdown";

  return {
    title: isNowenExport ? metadata.get("title")?.trim() || null : null,
    content: isNowenExport ? source.slice(match[0].length) : source,
    targetFormat,
  };
}

export async function importMarkdownFileIntoKnowledgeTree(
  file: File,
  parentId: string | null,
): Promise<Awaited<ReturnType<typeof api.getNote>>> {
  const imported = parseMarkdownImportDocument(await readMarkdownFile(file));
  const title = imported.title || markdownDropTitle(file.name);
  const isRichText = imported.targetFormat === "tiptap-json";
  const content = isRichText
    ? JSON.stringify((await import("@/lib/contentFormat")).markdownToTiptapJSON(imported.content))
    : imported.content;
  let createdNode: KnowledgeTreeNode | null = null;

  try {
    createdNode = await knowledgeTreeApi.create({
      parentId,
      nodeType: isRichText ? "note" : "markdown",
      title,
    });
    const createdNote = await api.getNote(createdNode.resourceId);
    return await api.updateNoteConfirmed(createdNode.resourceId, {
      title,
      content,
      contentFormat: imported.targetFormat,
      version: createdNote.version,
    });
  } catch (error) {
    if (createdNode) {
      await knowledgeTreeApi.remove(createdNode.id, "subtree").catch(() => undefined);
    }
    throw error;
  }
}

async function importWordFileIntoKnowledgeTree(
  file: File,
  target: KnowledgeTreeNode,
  nodes: KnowledgeTreeNode[],
): Promise<void> {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  let cursor: KnowledgeTreeNode | undefined = target;
  let notebookId: string | null = null;

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.resourceType === "notebook") {
      notebookId = cursor.resourceId;
      break;
    }
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  if (!notebookId && target.resourceType === "note") {
    notebookId = (await api.getNote(target.resourceId)).notebookId;
  }
  if (!notebookId) throw new Error("无法确定 Word 文档的目标目录");

  const { importDocxAsNote } = await import("@/lib/wordNoteService");
  const { note } = await importDocxAsNote({ notebookId, file });
  if (target.id !== `notebook:${notebookId}`) {
    await knowledgeTreeApi.move(`note:${note.id}`, { parentId: target.id });
  }
}

function emitTreeChanged(targetNodeId: string, imported: number): void {
  window.dispatchEvent(new CustomEvent(TREE_CHANGED_EVENT, {
    detail: {
      reason: "knowledge-tree-files-dropped",
      targetNodeId,
      imported,
    },
  }));
}

function expandTargetAfterRefresh(targetNodeId: string, attempt = 0): void {
  window.setTimeout(() => {
    const activeTrees = Array.from(document.querySelectorAll<HTMLElement>(
      `${TREE_SELECTOR}[data-sidebar-surface-active="true"]`,
    ));
    const rows = activeTrees.flatMap((tree) => Array.from(tree.querySelectorAll<HTMLElement>(TREE_NODE_SELECTOR)));
    const row = rows.find((candidate) => candidate.dataset.knowledgeTreeNodeId === targetNodeId);
    const toggle = row?.querySelector<HTMLButtonElement>('button[aria-label="展开"]');
    if (toggle) {
      toggle.click();
      return;
    }
    if (attempt < 4) expandTargetAfterRefresh(targetNodeId, attempt + 1);
  }, attempt === 0 ? 120 : 180);
}

async function handleKnowledgeTreeFileDrop(row: HTMLElement, dataTransfer: DataTransfer): Promise<void> {
  const nodeId = row.dataset.knowledgeTreeNodeId || "";
  const allFiles = Array.from(dataTransfer.files || []);
  const supportedFiles = knowledgeTreeFilesFromDataTransfer(dataTransfer);
  const skippedCount = allFiles.length - supportedFiles.length;

  if (!nodeId) return;
  if (supportedFiles.length === 0) {
    toast.warning("这里只支持拖入 .md、.markdown 或 .docx 文件");
    return;
  }
  if (supportedFiles.length > MAX_MARKDOWN_DROP_FILES) {
    toast.error(`单次最多拖入 ${MAX_MARKDOWN_DROP_FILES} 个文档`);
    return;
  }
  const totalSize = supportedFiles.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_MARKDOWN_DROP_TOTAL_SIZE) {
    toast.error(`本次文件总大小超过 ${formatBytes(MAX_MARKDOWN_DROP_TOTAL_SIZE)} 限制`);
    return;
  }
  if (importing) {
    toast.warning("已有文档正在导入，请稍后再试");
    return;
  }

  importing = true;
  const progressToast = toast.info(`正在导入 ${supportedFiles.length} 个文档…`, 0);
  let target: KnowledgeTreeNode | null = null;
  let successCount = 0;
  const failures: Array<{ file: string; reason: string }> = [];

  try {
    const resolvedTarget = await resolveTargetNode(nodeId);
    if (!resolvedTarget) throw new Error("目标目录已不存在，请刷新后重试");
    target = resolvedTarget.node;
    if (!target.access.capabilities.canCreate) {
      throw new Error("你没有在该目录下创建文档的权限");
    }

    for (const file of supportedFiles) {
      try {
        if (isMarkdownDropFile(file)) {
          await importMarkdownFileIntoKnowledgeTree(file, target.id);
        } else {
          await importWordFileIntoKnowledgeTree(file, target, resolvedTarget.nodes);
        }
        successCount += 1;
      } catch (error) {
        failures.push({ file: file.name, reason: errorMessage(error) });
      }
    }

    if (successCount > 0) {
      emitTreeChanged(target.id, successCount);
      expandTargetAfterRefresh(target.id);
    }
  } catch (error) {
    failures.push({ file: "", reason: errorMessage(error) });
  } finally {
    importing = false;
    toast.dismiss(progressToast);
  }

  if (successCount === supportedFiles.length) {
    const skippedHint = skippedCount > 0 ? `，已忽略 ${skippedCount} 个不支持的文件` : "";
    toast.success(`已将 ${successCount} 个文档导入“${target?.title || "目标目录"}”${skippedHint}`);
    return;
  }

  const firstFailure = failures[0];
  if (successCount > 0) {
    toast.warning(
      `已导入 ${successCount} 个，失败 ${failures.length} 个${firstFailure ? `：${firstFailure.file || "导入"} ${firstFailure.reason}` : ""}`,
      6000,
    );
    return;
  }

  toast.error(firstFailure?.reason || "文档导入失败", 6000);
}

export function installKnowledgeTreeMarkdownDrop(): () => void {
  if (installed || typeof document === "undefined") return () => undefined;
  installed = true;

  const onDragOver = (event: DragEvent) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !hasExternalFilePayload(dataTransfer)) return;
    const row = findKnowledgeTreeDropRow(event.target);
    setActiveDropRow(row);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !hasExternalFilePayload(dataTransfer)) return;
    const row = findKnowledgeTreeDropRow(event.target);
    clearActiveDropRow();
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    void handleKnowledgeTreeFileDrop(row, dataTransfer);
  };

  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget === null) clearActiveDropRow();
  };

  const onDragEnd = () => clearActiveDropRow();

  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  document.addEventListener("dragleave", onDragLeave, true);
  document.addEventListener("dragend", onDragEnd, true);

  return () => {
    document.removeEventListener("dragover", onDragOver, true);
    document.removeEventListener("drop", onDrop, true);
    document.removeEventListener("dragleave", onDragLeave, true);
    document.removeEventListener("dragend", onDragEnd, true);
    clearActiveDropRow();
    installed = false;
  };
}
