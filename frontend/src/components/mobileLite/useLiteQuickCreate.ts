import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import { loadUnlockedFolderIds } from "@/lib/knowledgeTreePassword";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { markNewNoteForImmediateEdit } from "@/lib/newNoteImmediateEdit";
import { cancelNewNoteTitleFocus, requestNewNoteTitleFocus } from "@/lib/noteTitleFocus";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import { resolveLiteQuickCreateTarget } from "@/lib/mobileLiteMode";
import { pushMindMapAppPath } from "@/lib/mindMapDeepLink";
import { pushExcelAppPath } from "@/lib/excelDeepLink";
import { toast } from "@/lib/toast";
import { haptic } from "@/hooks/useCapacitor";
import { useApp, useAppActions } from "@/store/AppContext";

export type LiteQuickCreateKind = "normal" | "markdown" | "plaintext" | "folder" | "mindmap";

export function useLiteQuickCreate({ onOpenDirectory }: { onOpenDirectory?: () => void } = {}) {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  const creatingRef = useRef(false);

  const resolveNotebookId = useCallback(async (): Promise<string | null> => {
    const unlockedIds = loadUnlockedFolderIds();
    const lockedNotebookIds = new Set<string>();
    if (!isMobileLocalMode()) {
      try {
        const tree = await knowledgeTreeApi.list();
        for (const node of tree.nodes) {
          if (node.resourceType === "notebook" && node.isPasswordProtected && !unlockedIds.has(node.id)) {
            lockedNotebookIds.add(node.resourceId);
          }
        }
      } catch {
        // 离线或树未就绪时仍允许按本地已知 notebooks 列表回退，后端权限校验继续生效
      }
    }

    const target = resolveLiteQuickCreateTarget({
      selectedNotebookId: state.selectedNotebookId,
      notebooks: state.notebooks,
      lockedNotebookIds,
      isLocalMode: isMobileLocalMode(),
    });

    if (target.kind === "notebook" && target.notebookId) {
      return target.notebookId;
    }

    if (target.kind === "create-default-local") {
      const notebook = await api.createNotebook({
        name: t("mobileLite.create.defaultNotebookName"),
        icon: "📒",
      });
      actions.addNotebook(notebook);
      actions.setSelectedNotebook(notebook.id);
      return notebook.id;
    }

    if (target.kind === "locked") {
      toast.warning(t("mobileLite.create.lockedNotebook"));
      onOpenDirectory?.();
      return null;
    }

    toast.warning(t("mobileLite.create.needNotebook"));
    onOpenDirectory?.();
    return null;
  }, [actions, onOpenDirectory, state.notebooks, state.selectedNotebookId, t]);

  const createNote = useCallback(async (kind: "normal" | "markdown" | "plaintext" = "normal") => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    haptic.light();
    const focusRequestId = requestNewNoteTitleFocus();

    try {
      const notebookId = await resolveNotebookId();
      if (!notebookId) {
        cancelNewNoteTitleFocus(focusRequestId);
        return;
      }

      let note = kind === "markdown"
        ? await api.createNote({
          notebookId,
          title: t("common.untitledNote"),
          contentFormat: "markdown",
          content: "",
          contentText: "",
        } as any)
        : kind === "plaintext"
          ? await api.createNote({
            notebookId,
            title: t("common.untitledNote"),
            contentFormat: "plaintext",
            content: "",
            contentText: "",
          })
          : await api.createNote({
            notebookId,
            title: t("common.untitledNote"),
          });

      if (state.viewMode === "favorites" && !note.isFavorite) {
        try {
          note = await api.updateNote(note.id, { isFavorite: 1 } as any);
        } catch {
          // 收藏标记失败不阻断新建编辑流程
        }
      }

      markNewNoteForImmediateEdit(note.id);
      actions.setActiveNote(note);
      actions.addNoteToList(note);
      if (state.viewMode !== "all" && state.viewMode !== "favorites" && state.viewMode !== "notebook") {
        actions.setViewMode("all");
      }
      actions.setMobileView("editor");
      actions.setMobileSidebar(false);
      emitKnowledgeTreeRefresh("mobile-lite-quick-create");
      actions.refreshNotebooks();
    } catch (err: any) {
      cancelNewNoteTitleFocus(focusRequestId);
      console.error("[MobileLite] quick create note failed:", err);
      toast.error(err?.message || t("noteList.createFailed"));
    } finally {
      creatingRef.current = false;
    }
  }, [actions, resolveNotebookId, state.viewMode, t]);

  const resolveCurrentParentId = useCallback((): string | null => {
    return state.selectedKnowledgeTreeParentId ?? null;
  }, [state.selectedKnowledgeTreeParentId]);

  const createFolder = useCallback(async (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      if (isMobileLocalMode()) {
        const notebook = await api.createNotebook({ name: trimmed });
        actions.addNotebook(notebook);
        actions.setSelectedNotebook(notebook.id);
        actions.setViewMode("notebook");
        actions.setMobileView("list");
      } else {
        await knowledgeTreeApi.create({
          parentId: resolveCurrentParentId(),
          nodeType: "folder",
          title: trimmed,
        });
        emitKnowledgeTreeRefresh("mobile-lite-folder-created");
        actions.refreshNotebooks();
      }
      toast.success(t("mobileLite.directory.folderCreated"));
    } catch (err: any) {
      console.error("[MobileLite] create folder failed:", err);
      toast.error(err?.message || t("noteList.createFailed"));
    }
  }, [actions, resolveCurrentParentId, t]);

  const createMindMap = useCallback(async (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const node = await knowledgeTreeApi.create({
        parentId: resolveCurrentParentId(),
        nodeType: "mindmap",
        title: trimmed,
      });
      emitKnowledgeTreeRefresh("mobile-lite-mindmap-created");
      pushMindMapAppPath(node.resourceId);
      actions.setViewMode("mindmaps");
    } catch (err: any) {
      console.error("[MobileLite] create mindmap failed:", err);
      toast.error(err?.message || t("noteList.createFailed"));
    }
  }, [actions, resolveCurrentParentId, t]);

  const createExcel = useCallback(async (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const node = await knowledgeTreeApi.create({
        parentId: resolveCurrentParentId(),
        nodeType: "excel",
        title: trimmed,
      });
      emitKnowledgeTreeRefresh("mobile-lite-excel-created");
      actions.refreshNotes();
      actions.refreshNotebooks();
      pushExcelAppPath(node.resourceId);
    } catch (err: any) {
      console.error("[MobileLite] create excel failed:", err);
      toast.error(err?.message || t("noteList.createFailed"));
    }
  }, [actions, resolveCurrentParentId, t]);

  return {
    createNote,
    createFolder,
    createMindMap,
    createExcel,
  };
}
