from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


create_menu = '''import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileCode, FileText, FileType2, FileUp, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export type NoteType = "normal" | "markdown" | "markdown-file" | "word" | "wechat";

export interface CreateNoteMenuProps {
  onPick: (type: NoteType) => void | Promise<void>;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

type CreateNoteMenuItem = {
  id: NoteType;
  label: string;
  desc: string;
  icon: React.ReactNode;
};

/**
 * 笔记列表的新建与导入菜单。
 *
 * 创建：富文本、Markdown。
 * 导入：Markdown 文件、Word 文档、微信公众号文章。
 * 所有动作都交给 NoteList 统一解析当前目录和工作区，避免菜单自己猜测目标位置。
 */
export default function CreateNoteMenu({ onPick, onClose, anchorRef }: CreateNoteMenuProps) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const menuWidth = 248;
      const estimatedHeight = 304;
      const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
      const top = Math.max(8, Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 4));
      setPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!pos) return null;

  const createItems: CreateNoteMenuItem[] = [
    {
      id: "normal",
      label: t("sidebar.newNote", { defaultValue: "新建笔记" }),
      desc: t("sidebar.newNoteDesc", { defaultValue: "富文本编辑器" }),
      icon: <FileText size={15} />,
    },
    {
      id: "markdown",
      label: t("sidebar.newMarkdownNote", { defaultValue: "新建 Markdown 笔记" }),
      desc: t("sidebar.newMarkdownNoteDesc", { defaultValue: "原生 Markdown 编辑器" }),
      icon: <FileCode size={15} />,
    },
  ];

  const importItems: CreateNoteMenuItem[] = [
    {
      id: "markdown-file",
      label: t("sidebar.importMarkdownNote", { defaultValue: "导入 Markdown 文件" }),
      desc: t("sidebar.importMarkdownNoteDesc", { defaultValue: "支持 .md / .markdown，可多选" }),
      icon: <FileUp size={15} />,
    },
    {
      id: "word",
      label: t("sidebar.importWordNote", { defaultValue: "导入 Word 文档" }),
      desc: t("sidebar.importWordNoteDesc", { defaultValue: "选择 .docx 转为可编辑笔记" }),
      icon: <FileType2 size={15} />,
    },
    {
      id: "wechat",
      label: t("sidebar.importUrlNote", { defaultValue: "导入公众号文章" }),
      desc: t("sidebar.importUrlNoteDesc", { defaultValue: "输入微信公众号文章链接" }),
      icon: <Link2 size={15} />,
    },
  ];

  const renderItem = (item: CreateNoteMenuItem) => (
    <button
      key={item.id}
      type="button"
      role="menuitem"
      data-note-menu-action={item.id}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        void Promise.resolve(onPick(item.id)).catch((error) => {
          console.error("Failed to handle create/import menu pick:", error);
        });
      }}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
    >
      <span className="mt-0.5 shrink-0 text-tx-tertiary">{item.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{item.label}</span>
        <span className="mt-0.5 block truncate text-[10px] text-tx-tertiary">{item.desc}</span>
      </span>
    </button>
  );

  return createPortal(
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 9998, background: "transparent" }}
    >
      <div
        role="menu"
        aria-label={t("noteList.createAndImport", { defaultValue: "新建与导入" })}
        className="rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl"
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: 248,
          zIndex: 9999,
          animation: "contextMenuIn 0.12s ease-out",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {createItems.map(renderItem)}
        <div className="my-1 border-t border-app-border" role="separator" />
        {importItems.map(renderItem)}
      </div>
    </div>,
    document.body,
  );
}
'''
(ROOT / "frontend/src/components/CreateNoteMenu.tsx").write_text(create_menu, encoding="utf-8")

knowledge_import = '''import { prompt as appPrompt } from "@/components/ui/confirm";
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

export interface KnowledgeTreeImportOptions {
  parent: KnowledgeTreeNode | null;
  nodes: KnowledgeTreeNode[];
  fallbackNotebookId: string | null;
}

async function loadAllKnowledgeTreeNodes(): Promise<KnowledgeTreeNode[]> {
  const [ownedResult, sharedResult] = await Promise.allSettled([
    knowledgeTreeApi.list(),
    knowledgeTreeApi.listShared(),
  ]);
  const nodes: KnowledgeTreeNode[] = [];
  if (ownedResult.status === "fulfilled") nodes.push(...ownedResult.value.nodes);
  if (sharedResult.status === "fulfilled") nodes.push(...sharedResult.value.nodes);
  if (nodes.length > 0) {
    return Array.from(new Map(nodes.map((node) => [node.id, node])).values());
  }
  const reason = ownedResult.status === "rejected"
    ? ownedResult.reason
    : sharedResult.status === "rejected"
      ? sharedResult.reason
      : new Error("无法读取内容树");
  throw reason;
}

/**
 * 将三栏中间列表当前选中的 legacy notebook 映射回统一知识树节点。
 * 导入必须使用真实 tree parent，不能只向 notes 表写 notebookId，否则知识树和列表会不同步。
 */
export async function resolveKnowledgeTreeImportOptionsForNotebook(
  notebookId: string,
): Promise<KnowledgeTreeImportOptions> {
  const nodes = await loadAllKnowledgeTreeNodes();
  const parent = nodes.find((node) => (
    node.resourceType === "notebook" && node.resourceId === notebookId
  )) || null;
  if (!parent) throw new Error("当前目录已不存在，请刷新后重试");
  if (!parent.access.capabilities.canCreate) {
    throw new Error("你没有在当前目录中导入内容的权限");
  }
  return { parent, nodes, fallbackNotebookId: notebookId };
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

export async function importMarkdownFilesIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote[]> {
  const files = await pickMarkdownFiles();
  if (files.length === 0) return [];
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
  return imported;
}

export async function importMarkdownIntoKnowledgeTree(
  options: KnowledgeTreeImportOptions,
): Promise<LoadedNote | null> {
  return (await importMarkdownFilesIntoKnowledgeTree(options))[0] || null;
}

export async function importMarkdownFilesIntoNotebook(notebookId: string): Promise<LoadedNote[]> {
  return importMarkdownFilesIntoKnowledgeTree(
    await resolveKnowledgeTreeImportOptionsForNotebook(notebookId),
  );
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
      return /^https:\\/\\/mp\\.weixin\\.qq\\.com\\/s[\\/?]/.test(url) ? null : "暂只支持微信公众号文章链接";
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

export async function importWeChatArticleIntoNotebook(notebookId: string): Promise<LoadedNote | null> {
  return importWeChatArticleIntoKnowledgeTree(
    await resolveKnowledgeTreeImportOptionsForNotebook(notebookId),
  );
}
'''
(ROOT / "frontend/src/components/knowledgeTreeImport.ts").write_text(knowledge_import, encoding="utf-8")

note_list_path = ROOT / "frontend/src/components/NoteList.tsx"
note_list = note_list_path.read_text(encoding="utf-8")
note_list = replace_once(
    note_list,
    'const [pendingNoteType, setPendingNoteType] = useState<"normal" | "markdown" | "word">("normal");',
    'const [pendingNoteType, setPendingNoteType] = useState<NoteType>("normal");',
    "pending note type",
)
note_list = replace_once(
    note_list,
    'const handleCreateNote = async (noteType: "normal" | "markdown" | "word" | "journal" = "normal") => {',
    'const handleCreateNote = async (noteType: NoteType | "journal" = "normal") => {',
    "create handler type",
)

new_create_block = '''  // 实际执行创建或导入的逻辑，供当前目录和笔记本选择器共同复用。
  // Markdown 文件与公众号文章走统一知识树导入服务，确保中间列表和左侧目录使用同一父节点。
  const createNoteInNotebook = async (
    notebookId: string,
    noteType: NoteType = "normal",
  ) => {
    try {
      let notes: any[] = [];
      let treeImportReason: string | null = null;

      if (noteType === "word") {
        const { pickDocxFile, importDocxAsNote } = await import("@/lib/wordNoteService");
        const file = await pickDocxFile();
        if (!file) return;
        const toastId = toast.info("正在导入 Word 文档…", 0);
        try {
          const result = await importDocxAsNote({ notebookId, file });
          notes = [result.note];
          toast.dismiss(toastId);
          toast.success("导入成功");
        } catch (error) {
          toast.dismiss(toastId);
          throw error;
        }
      } else if (noteType === "markdown-file") {
        const { importMarkdownFilesIntoNotebook } = await import("@/components/knowledgeTreeImport");
        notes = await importMarkdownFilesIntoNotebook(notebookId);
        if (notes.length === 0) return;
        treeImportReason = "note-list-markdown-files-imported";
      } else if (noteType === "wechat") {
        const { importWeChatArticleIntoNotebook } = await import("@/components/knowledgeTreeImport");
        const imported = await importWeChatArticleIntoNotebook(notebookId);
        if (!imported) return;
        notes = [imported];
        treeImportReason = "note-list-wechat-article-imported";
      } else if (noteType === "markdown") {
        notes = [await api.createNote({
          notebookId,
          title: "无标题 Markdown",
          contentFormat: "markdown",
          content: "# 无标题 Markdown\\n\\n",
          contentText: "无标题 Markdown",
        } as any)];
      } else {
        notes = [await api.createNote({ notebookId, title: t('common.untitledNote') })];
      }

      const prepared: Array<{ note: any; isFavorite: number }> = [];
      for (const importedNote of notes) {
        let note = importedNote;
        let isFavorite = note.isFavorite || 0;
        // 收藏视图中的新建与导入结果都应留在当前结果集，而不是只处理批量导入的第一篇。
        if (state.viewMode === "favorites" && !isFavorite) {
          try {
            note = await api.updateNote(note.id, { isFavorite: 1 } as any);
            isFavorite = 1;
          } catch {
            // 收藏设置失败不阻断创建或导入流程。
          }
        }
        prepared.push({ note, isFavorite });
      }

      const primary = prepared[0]?.note;
      if (!primary) return;
      actions.setActiveNote(primary);
      for (const { note, isFavorite } of prepared) {
        actions.addNoteToList({
          id: note.id,
          userId: note.userId,
          title: note.title,
          contentText: note.contentText || "",
          notebookId: note.notebookId,
          workspaceId: note.workspaceId ?? null,
          isPinned: note.isPinned || 0,
          isFavorite,
          isLocked: note.isLocked || 0,
          isArchived: note.isArchived || 0,
          isTrashed: note.isTrashed || 0,
          version: note.version || 1,
          sortOrder: note.sortOrder || 0,
          updatedAt: note.updatedAt,
          createdAt: note.createdAt,
          contentFormat: note.contentFormat,
        } as NoteListItem);
      }
      actions.setMobileView("editor");
      actions.refreshNotebooks();

      if (treeImportReason) {
        actions.refreshNotes();
        window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", {
          detail: {
            reason: treeImportReason,
            notebookId,
            imported: prepared.length,
          },
        }));
      }

      // 若动作发生在「所有笔记/收藏/标签」视图且系统自动选择了归属，提示用户。
      if (!state.selectedNotebookId && state.viewMode !== "notebook") {
        const notebook = state.notebooks.find((candidate) => candidate.id === notebookId);
        if (notebook) {
          toast.info(t('noteList.noteCreatedInNotebook', { name: notebook.name }));
        }
      }
    } catch (error: any) {
      console.error("创建或导入笔记失败:", error);
      toast.error(error?.message || t('noteList.createFailed'));
    }
  };
'''
pattern = re.compile(
    r"  // 实际执行创建笔记的逻辑，抽出供选择器回调复用\n"
    r"  // noteType=\"word\" 时：弹文件选择器，走 importDocxAsNote（解析 \.docx 为富文本笔记）。\n"
    r"  const createNoteInNotebook = async \([\s\S]*?\n  };\n\n  // =========================================================================",
)
note_list, count = pattern.subn(new_create_block + "\n  // =========================================================================", note_list, count=1)
if count != 1:
    raise RuntimeError(f"createNoteInNotebook block: expected one match, found {count}")
note_list = note_list.replace(
    "{/* 新建按钮的下拉（普通笔记 / Word 文档），在 split-button 的 ▾ 旁边 portal 弹出 */}",
    "{/* 新建与导入下拉：富文本、Markdown、Markdown 文件、Word、公众号文章 */}",
    1,
)
note_list_path.write_text(note_list, encoding="utf-8")

for locale_path, old, new in [
    (
        ROOT / "frontend/src/i18n/locales/zh-CN.json",
        '    "newNote": "新建笔记",\n    "newMarkdownNote": "新建 Markdown 笔记",\n    "importWordNote": "导入 Word 文档",\n    "importUrlNote": "导入公众号文章",',
        '    "newNote": "新建笔记",\n    "newNoteDesc": "富文本编辑器",\n    "newMarkdownNote": "新建 Markdown 笔记",\n    "newMarkdownNoteDesc": "原生 Markdown 编辑器",\n    "importMarkdownNote": "导入 Markdown 文件",\n    "importMarkdownNoteDesc": "支持 .md / .markdown，可多选",\n    "importWordNote": "导入 Word 文档",\n    "importWordNoteDesc": "选择 .docx 转为可编辑笔记",\n    "importUrlNote": "导入公众号文章",\n    "importUrlNoteDesc": "输入微信公众号文章链接",',
    ),
    (
        ROOT / "frontend/src/i18n/locales/en.json",
        '    "newNote": "New Note",\n    "newMarkdownNote": "New Markdown Note",\n    "importWordNote": "Import Word Document",\n    "importUrlNote": "Import Article from URL",',
        '    "newNote": "New Note",\n    "newNoteDesc": "Rich text editor",\n    "newMarkdownNote": "New Markdown Note",\n    "newMarkdownNoteDesc": "Native Markdown editor",\n    "importMarkdownNote": "Import Markdown Files",\n    "importMarkdownNoteDesc": "Select one or more .md / .markdown files",\n    "importWordNote": "Import Word Document",\n    "importWordNoteDesc": "Convert a .docx file into an editable note",\n    "importUrlNote": "Import WeChat Article",\n    "importUrlNoteDesc": "Paste a WeChat Official Account article URL",',
    ),
]:
    locale = locale_path.read_text(encoding="utf-8")
    locale_path.write_text(replace_once(locale, old, new, locale_path.name), encoding="utf-8")

workflow_path = ROOT / ".github/workflows/knowledge-tree-p0-ci.yml"
workflow = workflow_path.read_text(encoding="utf-8")
for section_marker in ['  push:\n', '  pull_request:\n']:
    # Insert source paths once in each paths block, directly after NoteWorkspaceLayoutController.
    target = '      - "frontend/src/components/NoteWorkspaceLayoutController.tsx"\n'
    start = workflow.index(section_marker)
    next_section = workflow.find('\n  pull_request:', start) if section_marker.startswith('  push') else workflow.find('\npermissions:', start)
    segment = workflow[start:next_section]
    addition = (
        '      - "frontend/src/components/CreateNoteMenu.tsx"\n'
        '      - "frontend/src/components/knowledgeTreeImport.ts"\n'
        '      - "frontend/src/components/NoteList.tsx"\n'
        '      - "frontend/src/components/__tests__/CreateNoteMenu.test.tsx"\n'
        '      - "frontend/src/components/__tests__/knowledgeTreeImportNotebook.test.ts"\n'
        '      - "frontend/src/i18n/locales/en.json"\n'
        '      - "frontend/src/i18n/locales/zh-CN.json"\n'
    )
    if addition not in segment:
        replaced = segment.replace(target, target + addition, 1)
        if replaced == segment:
            raise RuntimeError(f"workflow path insertion failed for {section_marker.strip()}")
        workflow = workflow[:start] + replaced + workflow[next_section:]

old_command = 'run: npm run test:run -- src/lib/__tests__/editorWorkspaceLayout.test.ts src/lib/__tests__/noteWorkspaceLayout.test.ts src/lib/__tests__/unifiedTreeOnlyLayout.test.ts src/components/__tests__/NoteWorkspaceLayoutController.test.tsx src/components/__tests__/MobileDrawerUxBridge.layout.test.tsx'
new_command = old_command + ' src/components/__tests__/CreateNoteMenu.test.tsx src/components/__tests__/knowledgeTreeImportNotebook.test.ts'
workflow = replace_once(workflow, old_command, new_command, "workflow test command")
workflow_path.write_text(workflow, encoding="utf-8")

create_menu_test = '''// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

import CreateNoteMenu, { type NoteType } from "@/components/CreateNoteMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("CreateNoteMenu", () => {
  let container: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    document.body.innerHTML = "";
    anchor = document.createElement("button");
    anchor.getBoundingClientRect = () => ({
      x: 300,
      y: 30,
      top: 30,
      right: 340,
      bottom: 62,
      left: 300,
      width: 40,
      height: 32,
      toJSON: () => ({}),
    });
    document.body.appendChild(anchor);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("exposes both create actions and all three import actions", () => {
    const picked: NoteType[] = [];
    act(() => {
      root.render(
        <CreateNoteMenu
          anchorRef={{ current: anchor }}
          onClose={() => undefined}
          onPick={(type) => { picked.push(type); }}
        />,
      );
    });

    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-note-menu-action]"))
      .map((element) => element.dataset.noteMenuAction)).toEqual([
        "normal",
        "markdown",
        "markdown-file",
        "word",
        "wechat",
      ]);
    expect(document.body.textContent).toContain("导入 Markdown 文件");
    expect(document.body.textContent).toContain("导入公众号文章");

    const markdownImport = document.querySelector<HTMLButtonElement>('[data-note-menu-action="markdown-file"]');
    const wechatImport = document.querySelector<HTMLButtonElement>('[data-note-menu-action="wechat"]');
    act(() => markdownImport?.click());
    act(() => wechatImport?.click());
    expect(picked).toEqual(["markdown-file", "wechat"]);
  });
});
'''
(ROOT / "frontend/src/components/__tests__/CreateNoteMenu.test.tsx").write_text(create_menu_test, encoding="utf-8")

knowledge_import_test = '''import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
const listShared = vi.hoisted(() => vi.fn());

vi.mock("@/lib/knowledgeTreeApi", () => ({
  knowledgeTreeApi: {
    list,
    listShared,
  },
}));

vi.mock("@/lib/api", () => ({
  api: {},
}));

vi.mock("@/components/ui/confirm", () => ({
  prompt: vi.fn(),
}));

vi.mock("@/lib/knowledgeTreeMarkdownDrop", () => ({
  importMarkdownFileIntoKnowledgeTree: vi.fn(),
  MAX_MARKDOWN_DROP_FILES: 100,
  MAX_MARKDOWN_DROP_FILE_SIZE: 20 * 1024 * 1024,
  MAX_MARKDOWN_DROP_TOTAL_SIZE: 100 * 1024 * 1024,
  pickMarkdownFiles: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    info: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import { resolveKnowledgeTreeImportOptionsForNotebook } from "@/components/knowledgeTreeImport";

function notebookNode(id: string, notebookId: string, canCreate = true) {
  return {
    id,
    resourceType: "notebook",
    resourceId: notebookId,
    access: { capabilities: { canCreate } },
  } as any;
}

describe("resolveKnowledgeTreeImportOptionsForNotebook", () => {
  beforeEach(() => {
    list.mockReset();
    listShared.mockReset();
  });

  it("maps a three-column notebook selection to the matching owned tree node", async () => {
    const parent = notebookNode("notebook:nb-1", "nb-1");
    list.mockResolvedValue({ nodes: [parent] });
    listShared.mockResolvedValue({ nodes: [] });

    const result = await resolveKnowledgeTreeImportOptionsForNotebook("nb-1");
    expect(result.parent).toBe(parent);
    expect(result.fallbackNotebookId).toBe("nb-1");
  });

  it("also resolves shared notebook nodes and enforces create permission", async () => {
    list.mockResolvedValue({ nodes: [] });
    listShared.mockResolvedValue({ nodes: [notebookNode("shared:nb-2", "nb-2", false)] });

    await expect(resolveKnowledgeTreeImportOptionsForNotebook("nb-2"))
      .rejects.toThrow("没有在当前目录中导入内容的权限");
  });

  it("does not silently import at the root when the selected directory disappeared", async () => {
    list.mockResolvedValue({ nodes: [] });
    listShared.mockResolvedValue({ nodes: [] });

    await expect(resolveKnowledgeTreeImportOptionsForNotebook("missing"))
      .rejects.toThrow("当前目录已不存在");
  });
});
'''
(ROOT / "frontend/src/components/__tests__/knowledgeTreeImportNotebook.test.ts").write_text(knowledge_import_test, encoding="utf-8")

print("three-column import integration applied")
