from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one target in {path}, found {count}: {old[:160]!r}")
    file.write_text(text.replace(old, new, 1))


helper = Path("frontend/src/lib/threeColumnFolderContents.ts")
helper.write_text('''import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export type ThreeColumnFolderScopeMode = "current" | "recursive";

export const THREE_COLUMN_FOLDER_SCOPE_STORAGE_KEY = "nowen.noteList.threeColumnFolderScope";
export const KNOWLEDGE_TREE_OPEN_FOLDER_EVENT = "nowen:knowledge-tree-open-folder";

export interface KnowledgeTreeOpenFolderDetail {
  node: KnowledgeTreeNode;
}

export interface ThreeColumnChildFolder {
  node: KnowledgeTreeNode;
  directNoteCount: number;
  totalNoteCount: number;
}

export interface ThreeColumnFolderContents {
  selectedFolder: KnowledgeTreeNode | null;
  childFolders: ThreeColumnChildFolder[];
  directNoteCount: number;
  totalNoteCount: number;
}

export function normalizeThreeColumnFolderScopeMode(value: unknown): ThreeColumnFolderScopeMode {
  return value === "recursive" ? "recursive" : "current";
}

export function loadThreeColumnFolderScopeMode(): ThreeColumnFolderScopeMode {
  try {
    return normalizeThreeColumnFolderScopeMode(
      window.localStorage.getItem(THREE_COLUMN_FOLDER_SCOPE_STORAGE_KEY),
    );
  } catch {
    return "current";
  }
}

export function saveThreeColumnFolderScopeMode(mode: ThreeColumnFolderScopeMode): void {
  try {
    window.localStorage.setItem(THREE_COLUMN_FOLDER_SCOPE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in hardened WebViews; keep the in-memory choice usable.
  }
}

export function requestKnowledgeTreeFolderOpen(node: KnowledgeTreeNode): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<KnowledgeTreeOpenFolderDetail>(
    KNOWLEDGE_TREE_OPEN_FOLDER_EVENT,
    { detail: { node } },
  ));
}

export function buildThreeColumnFolderContents(
  nodes: KnowledgeTreeNode[],
  selectedNotebookId: string | null | undefined,
): ThreeColumnFolderContents {
  const empty: ThreeColumnFolderContents = {
    selectedFolder: null,
    childFolders: [],
    directNoteCount: 0,
    totalNoteCount: 0,
  };
  if (!selectedNotebookId) return empty;

  const activeNodes = nodes.filter((node) => !node.isDeleted);
  const selectedFolder = activeNodes.find((node) => (
    node.nodeType === "folder"
    && node.resourceType === "notebook"
    && node.resourceId === selectedNotebookId
  ));
  if (!selectedFolder) return empty;

  const childrenByParent = new Map<string | null, KnowledgeTreeNode[]>();
  for (const node of activeNodes) {
    const siblings = childrenByParent.get(node.parentId) || [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => (
      (a.sortOrder || 0) - (b.sortOrder || 0)
      || a.title.localeCompare(b.title)
      || a.id.localeCompare(b.id)
    ));
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const countDescendantNotes = (folderNodeId: string): number => {
    const cached = memo.get(folderNodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(folderNodeId)) return 0;
    visiting.add(folderNodeId);
    let total = 0;
    for (const child of childrenByParent.get(folderNodeId) || []) {
      if (child.nodeType === "folder") {
        total += countDescendantNotes(child.id);
      } else if (child.resourceType === "note") {
        total += 1;
      }
    }
    visiting.delete(folderNodeId);
    memo.set(folderNodeId, total);
    return total;
  };

  const directChildren = childrenByParent.get(selectedFolder.id) || [];
  const directNoteCount = directChildren.filter((node) => (
    node.nodeType !== "folder" && node.resourceType === "note"
  )).length;
  const childFolders = directChildren
    .filter((node) => node.nodeType === "folder" && node.resourceType === "notebook")
    .map((node) => ({
      node,
      directNoteCount: (childrenByParent.get(node.id) || []).filter((child) => (
        child.nodeType !== "folder" && child.resourceType === "note"
      )).length,
      totalNoteCount: countDescendantNotes(node.id),
    }));

  return {
    selectedFolder,
    childFolders,
    directNoteCount,
    totalNoteCount: countDescendantNotes(selectedFolder.id),
  };
}
''')


tests = Path("frontend/src/lib/__tests__/threeColumnFolderContents.test.ts")
tests.write_text('''import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  buildThreeColumnFolderContents,
  normalizeThreeColumnFolderScopeMode,
} from "@/lib/threeColumnFolderContents";

const access = {
  nodeId: "",
  rolePreset: "admin" as const,
  source: "owner" as const,
  sourceNodeId: null,
  capabilities: {
    canView: true,
    canComment: true,
    canCreate: true,
    canEdit: true,
    canDelete: true,
    canMove: true,
    canDownload: true,
    canReshare: true,
    canManageMembers: true,
  },
};

function treeNode(input: Partial<KnowledgeTreeNode> & Pick<KnowledgeTreeNode, "id" | "parentId" | "nodeType" | "resourceType" | "resourceId" | "title">): KnowledgeTreeNode {
  return {
    userId: "user-1",
    workspaceId: null,
    scopeKey: "personal:user-1",
    icon: null,
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isPasswordProtected: 0,
    contentFormat: null,
    sortOrder: 0,
    isExpanded: 0,
    isDeleted: 0,
    childCount: 0,
    createdAt: "2026-08-05 00:00:00",
    updatedAt: "2026-08-05 00:00:00",
    access: { ...access, nodeId: input.id },
    ...input,
  } as KnowledgeTreeNode;
}

describe("three-column folder contents", () => {
  it("returns direct child folders and separates direct from recursive note counts", () => {
    const nodes = [
      treeNode({ id: "root", parentId: null, nodeType: "folder", resourceType: "notebook", resourceId: "nb-root", title: "技术学习" }),
      treeNode({ id: "direct-note", parentId: "root", nodeType: "note", resourceType: "note", resourceId: "note-1", title: "RSC" }),
      treeNode({ id: "child", parentId: "root", nodeType: "folder", resourceType: "notebook", resourceId: "nb-child", title: "前端笔记" }),
      treeNode({ id: "child-note", parentId: "child", nodeType: "markdown", resourceType: "note", resourceId: "note-2", title: "Tiptap" }),
      treeNode({ id: "grandchild", parentId: "child", nodeType: "folder", resourceType: "notebook", resourceId: "nb-grandchild", title: "React" }),
      treeNode({ id: "grandchild-note", parentId: "grandchild", nodeType: "note", resourceType: "note", resourceId: "note-3", title: "React 19" }),
      treeNode({ id: "other", parentId: null, nodeType: "folder", resourceType: "notebook", resourceId: "nb-other", title: "无关目录" }),
    ];

    const contents = buildThreeColumnFolderContents(nodes, "nb-root");
    expect(contents.selectedFolder?.id).toBe("root");
    expect(contents.directNoteCount).toBe(1);
    expect(contents.totalNoteCount).toBe(3);
    expect(contents.childFolders).toHaveLength(1);
    expect(contents.childFolders[0]).toMatchObject({
      directNoteCount: 1,
      totalNoteCount: 2,
      node: { id: "child", resourceId: "nb-child" },
    });
  });

  it("defaults invalid persisted scope values to the current level", () => {
    expect(normalizeThreeColumnFolderScopeMode("recursive")).toBe("recursive");
    expect(normalizeThreeColumnFolderScopeMode("current")).toBe("current");
    expect(normalizeThreeColumnFolderScopeMode("legacy")).toBe("current");
    expect(normalizeThreeColumnFolderScopeMode(null)).toBe("current");
  });

  it("locks the middle-column and tree-panel integration contract", () => {
    const noteList = readFileSync(
      fileURLToPath(new URL("../../components/NoteList.tsx", import.meta.url)),
      "utf8",
    );
    const treePanel = readFileSync(
      fileURLToPath(new URL("../../components/KnowledgeTreePanel.tsx", import.meta.url)),
      "utf8",
    );

    expect(noteList).toContain("data-three-column-child-folders");
    expect(noteList).toContain('currentFolderOnly ? { includeDescendants: "0" } : {}');
    expect(noteList).toContain("requestKnowledgeTreeFolderOpen(folder.node)");
    expect(noteList).toContain("saveThreeColumnFolderScopeMode(nextMode)");
    expect(treePanel).toContain("KNOWLEDGE_TREE_OPEN_FOLDER_EVENT");
    expect(treePanel).toContain("void openDocument(requestedNode)");
  });
});
''')


note_list = "frontend/src/components/NoteList.tsx"
replace_once(
    note_list,
    '''import {
  loadNoteWorkspaceLayoutMode,
  NOTE_WORKSPACE_LAYOUT_CHANGED_EVENT,
  NOTE_WORKSPACE_LAYOUT_STORAGE_KEY,
  usesThreeColumnFolderNavigation,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";''',
    '''import {
  loadNoteWorkspaceLayoutMode,
  NOTE_WORKSPACE_LAYOUT_CHANGED_EVENT,
  NOTE_WORKSPACE_LAYOUT_STORAGE_KEY,
  usesThreeColumnFolderNavigation,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import {
  hideLockedFolderDescendants,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  loadUnlockedFolderIds,
} from "@/lib/knowledgeTreePassword";
import {
  buildThreeColumnFolderContents,
  loadThreeColumnFolderScopeMode,
  requestKnowledgeTreeFolderOpen,
  saveThreeColumnFolderScopeMode,
  type ThreeColumnFolderScopeMode,
} from "@/lib/threeColumnFolderContents";''',
)

replace_once(
    note_list,
    '''  const [desktopFolderNavigationSurface, setDesktopFolderNavigationSurface] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia("(min-width: 768px)").matches,
  );''',
    '''  const [desktopFolderNavigationSurface, setDesktopFolderNavigationSurface] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia("(min-width: 768px)").matches,
  );
  const [folderScopeMode, setFolderScopeMode] = useState<ThreeColumnFolderScopeMode>(
    loadThreeColumnFolderScopeMode,
  );
  const [folderTreeNodes, setFolderTreeNodes] = useState<KnowledgeTreeNode[]>([]);
  const [unlockedFolderIds, setUnlockedFolderIds] = useState<Set<string>>(
    loadUnlockedFolderIds,
  );''',
)

replace_once(
    note_list,
    '''  const directNotebookScope = usesThreeColumnFolderNavigation({
    mode: layoutMode,
    noteListCollapsed: state.noteListCollapsed,
    desktopSurface: desktopFolderNavigationSurface,
  });
  const { loadNote, cancelNoteLoad } = useNoteLoader();''',
    '''  const directNotebookScope = usesThreeColumnFolderNavigation({
    mode: layoutMode,
    noteListCollapsed: state.noteListCollapsed,
    desktopSurface: desktopFolderNavigationSurface,
  });
  const showThreeColumnFolderContents = directNotebookScope
    && state.viewMode === "notebook"
    && !!state.selectedNotebookId;
  const currentFolderOnly = showThreeColumnFolderContents && folderScopeMode === "current";

  useEffect(() => {
    const syncUnlockedFolders = () => setUnlockedFolderIds(loadUnlockedFolderIds());
    window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, syncUnlockedFolders);
    return () => window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, syncUnlockedFolders);
  }, []);

  useEffect(() => {
    if (!showThreeColumnFolderContents) {
      setFolderTreeNodes([]);
      return;
    }

    let active = true;
    const reload = async () => {
      try {
        const [ownedResult, sharedResult] = await Promise.allSettled([
          knowledgeTreeApi.list(),
          knowledgeTreeApi.listShared(),
        ]);
        if (ownedResult.status === "rejected") throw ownedResult.reason;
        const sharedNodes = sharedResult.status === "fulfilled" ? sharedResult.value.nodes : [];
        const merged = Array.from(new Map(
          [...ownedResult.value.nodes, ...sharedNodes].map((node) => [node.id, node]),
        ).values());
        if (active) setFolderTreeNodes(merged);
      } catch (error) {
        console.warn("[NoteList] load three-column folder contents failed", error);
        if (active) setFolderTreeNodes([]);
      }
    };

    const refresh = () => void reload();
    void reload();
    window.addEventListener("nowen:workspace-changed", refresh);
    window.addEventListener("nowen:knowledge-tree-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("nowen:workspace-changed", refresh);
      window.removeEventListener("nowen:knowledge-tree-changed", refresh);
    };
  }, [showThreeColumnFolderContents, state.notesRefreshToken]);

  const visibleFolderTreeNodes = useMemo(
    () => hideLockedFolderDescendants(folderTreeNodes, unlockedFolderIds),
    [folderTreeNodes, unlockedFolderIds],
  );
  const threeColumnFolderContents = useMemo(
    () => buildThreeColumnFolderContents(visibleFolderTreeNodes, state.selectedNotebookId),
    [state.selectedNotebookId, visibleFolderTreeNodes],
  );
  const visibleChildFolders = showThreeColumnFolderContents
    ? threeColumnFolderContents.childFolders
    : [];
  const hasVisibleChildFolders = visibleChildFolders.length > 0;

  const { loadNote, cancelNoteLoad } = useNoteLoader();''',
)

replace_once(
    note_list,
    '''    sortBy: sortPref.by,
    sortDir: sortPref.dir,
  }), [''',
    '''    sortBy: sortPref.by,
    sortDir: sortPref.dir,
    folderScope: currentFolderOnly ? "current" : "recursive",
  }), [''',
)
replace_once(
    note_list,
    '''    sortPref.by,
    sortPref.dir,
  ]);''',
    '''    sortPref.by,
    sortPref.dir,
    currentFolderOnly,
  ]);''',
)

text = Path(note_list).read_text()
old = '...(directNotebookScope ? { includeDescendants: "0" } : {})'
if text.count(old) != 2:
    raise SystemExit(f"expected two directNotebookScope query flags, found {text.count(old)}")
text = text.replace(old, '...(currentFolderOnly ? { includeDescendants: "0" } : {})')
text = text.replace('sortPref.by, sortPref.dir, directNotebookScope, t]);', 'sortPref.by, sortPref.dir, currentFolderOnly, t]);', 1)
text = text.replace('    directNotebookScope,\n  ]);', '    currentFolderOnly,\n  ]);', 1)
Path(note_list).write_text(text)

replace_once(
    note_list,
    '''  }, [state.notes, sortPref.by, sortPref.dir, state.viewMode]);

  const showNotebookLabel = state.viewMode === "all";''',
    '''  }, [state.notes, sortPref.by, sortPref.dir, state.viewMode]);

  const displayedDirectNoteCount = currentFolderOnly
    ? sortedNotes.length
    : threeColumnFolderContents.directNoteCount;
  const displayedTotalNoteCount = currentFolderOnly
    ? Math.max(
        sortedNotes.length,
        threeColumnFolderContents.totalNoteCount
          - threeColumnFolderContents.directNoteCount
          + sortedNotes.length,
      )
    : sortedNotes.length;

  const showNotebookLabel = state.viewMode === "all";''',
)

old_count = '''      {/* Count */}
      <div className="px-4 py-1.5">
        <span className="text-[10px] text-tx-tertiary">{t('common.noteCount', { count: sortedNotes.length })}</span>
      </div>'''
new_count = '''      {/* 三栏布局：明确区分当前层级和递归范围，避免左侧总数与中栏结果产生“文件丢失”错觉。 */}
      {showThreeColumnFolderContents ? (
        <div className="flex min-w-0 items-center justify-between gap-2 border-b border-app-border/50 px-3 py-1.5">
          <span className="min-w-0 truncate text-[10px] text-tx-tertiary">
            {currentFolderOnly
              ? t("noteList.currentFolderCount", {
                  direct: displayedDirectNoteCount,
                  total: displayedTotalNoteCount,
                  folders: visibleChildFolders.length,
                  defaultValue: "本层 {{direct}} 篇 · 共 {{total}} 篇 · {{folders}} 个子文件夹",
                })
              : t("noteList.recursiveFolderCount", {
                  total: displayedTotalNoteCount,
                  folders: visibleChildFolders.length,
                  defaultValue: "共 {{total}} 篇 · {{folders}} 个直属子文件夹",
                })}
          </span>
          <div
            className="flex shrink-0 items-center rounded-md bg-app-hover p-0.5"
            role="group"
            aria-label={t("noteList.folderScope", { defaultValue: "文件夹展示范围" })}
          >
            {(["current", "recursive"] as const).map((mode) => {
              const active = folderScopeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    const nextMode: ThreeColumnFolderScopeMode = mode;
                    setFolderScopeMode(nextMode);
                    saveThreeColumnFolderScopeMode(nextMode);
                  }}
                  className={cn(
                    "rounded px-2 py-1 text-[10px] font-medium transition-colors",
                    active
                      ? "bg-app-elevated text-tx-primary shadow-sm"
                      : "text-tx-tertiary hover:text-tx-secondary",
                  )}
                >
                  {mode === "current"
                    ? t("noteList.currentLevel", { defaultValue: "当前层级" })
                    : t("noteList.includeSubfolders", { defaultValue: "包含子文件夹" })}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-4 py-1.5">
          <span className="text-[10px] text-tx-tertiary">{t('common.noteCount', { count: sortedNotes.length })}</span>
        </div>
      )}

      {showThreeColumnFolderContents && hasVisibleChildFolders && (
        <section
          data-three-column-child-folders
          className="border-b border-app-border/50 px-2 py-2"
          aria-label={t("noteList.childFolders", { defaultValue: "子文件夹" })}
        >
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-tx-tertiary">
              {t("noteList.childFolders", { defaultValue: "子文件夹" })}
            </span>
            <span className="text-[10px] text-tx-tertiary">{visibleChildFolders.length}</span>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto pr-0.5">
            {visibleChildFolders.map((folder) => (
              <button
                key={folder.node.id}
                type="button"
                onClick={() => requestKnowledgeTreeFolderOpen(folder.node)}
                className="group flex w-full items-center gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-app-border hover:bg-app-hover"
                title={folder.node.title}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-500">
                  {folder.node.icon
                    ? <span className="text-sm leading-none">{folder.node.icon}</span>
                    : <Folder size={15} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-xs font-medium text-tx-primary">{folder.node.title}</span>
                    {!!folder.node.isPasswordProtected && <Lock size={11} className="shrink-0 text-tx-tertiary" />}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-tx-tertiary">
                    {t("noteList.folderNoteCount", {
                      count: folder.totalNoteCount,
                      defaultValue: "{{count}} 篇笔记",
                    })}
                  </span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-tx-tertiary transition-transform group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
        </section>
      )}'''
replace_once(note_list, old_count, new_count)

replace_once(
    note_list,
    '''          {state.notes.length === 0 && !state.isLoading && !notesLoadError && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">''',
    '''          {state.notes.length === 0 && !state.isLoading && !notesLoadError && hasVisibleChildFolders && (
            <div className="flex flex-col items-center justify-center px-6 py-8 text-center">
              <Folder size={22} className="mb-2 text-amber-500/60" />
              <p className="text-xs font-medium text-tx-secondary">
                {currentFolderOnly
                  ? t("noteList.noDirectNotes", { defaultValue: "当前层级暂无文档，可进入上方子文件夹" })
                  : t("noteList.noRecursiveNotes", { defaultValue: "当前目录及子文件夹暂无文档" })}
              </p>
            </div>
          )}
          {state.notes.length === 0 && !state.isLoading && !notesLoadError && !hasVisibleChildFolders && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">''',
)

panel = "frontend/src/components/KnowledgeTreePanel.tsx"
replace_once(
    panel,
    '''import {
  detectNoteWorkspaceSurface,
  usesThreeColumnFolderNavigation,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";''',
    '''import {
  detectNoteWorkspaceSurface,
  usesThreeColumnFolderNavigation,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";
import {
  KNOWLEDGE_TREE_OPEN_FOLDER_EVENT,
  type KnowledgeTreeOpenFolderDetail,
} from "@/lib/threeColumnFolderContents";''',
)

replace_once(
    panel,
    '''  const toggleDisclosure = async (node: KnowledgeTreeNode) => {''',
    '''  useEffect(() => {
    if (!surfaceActive || !threeColumnFolderNavigation) return;
    const openRequestedFolder = (event: Event) => {
      const detail = (event as CustomEvent<KnowledgeTreeOpenFolderDetail>).detail;
      const requestedNode = detail?.node
        || nodes.find((node) => node.id === (detail as any)?.nodeId);
      if (!requestedNode || requestedNode.nodeType !== "folder") return;
      void openDocument(requestedNode);
    };
    window.addEventListener(KNOWLEDGE_TREE_OPEN_FOLDER_EVENT, openRequestedFolder);
    return () => window.removeEventListener(KNOWLEDGE_TREE_OPEN_FOLDER_EVENT, openRequestedFolder);
  }, [nodes, surfaceActive, threeColumnFolderNavigation, openDocument]);

  const toggleDisclosure = async (node: KnowledgeTreeNode) => {''',
)
