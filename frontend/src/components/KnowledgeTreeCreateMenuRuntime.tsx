import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Files } from "lucide-react";

import { KnowledgeTreeCreateDropdown, type KnowledgeTreeCreateMenuState } from "./KnowledgeTreeCreateDropdown";
import NoteTemplatePickerDialog from "@/components/NoteTemplatePickerDialog";
import EncryptedNoteCreateDialog from "./EncryptedNoteCreateDialog";
import KnowledgeTreePanelBase, {
  FOCUS_KNOWLEDGE_TREE_EVENT,
  KNOWLEDGE_TREE_CHANGED_EVENT,
  type KnowledgeTreeImportRequest,
  type KnowledgeTreeInlineCreateRequest,
  type KnowledgeTreePanelProps,
  type KnowledgeTreeTemplateCreateRequest,
} from "./KnowledgeTreePanel";
import { type KnowledgeTreeInlineCreateKind } from "@/lib/knowledgeTreeInlineCreate";
import {
  loadNoteWorkspaceLayoutMode,
  NOTE_WORKSPACE_LAYOUT_CHANGED_EVENT,
  NOTE_WORKSPACE_LAYOUT_STORAGE_KEY,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";
import { toast } from "@/lib/toast";
import { getCurrentWorkspace } from "@/lib/api";
import { pluginApi } from "@/lib/pluginApi";
import { cn } from "@/lib/utils";
import { useApp, useAppActions } from "@/store/AppContext";

export { FOCUS_KNOWLEDGE_TREE_EVENT, KNOWLEDGE_TREE_CHANGED_EVENT };
export type { KnowledgeTreePanelProps };
export { KnowledgeTreeCreateDropdown } from "./KnowledgeTreeCreateDropdown";
export type { KnowledgeTreeCreateMenuState } from "./KnowledgeTreeCreateDropdown";

const CREATE_SCOPE_ATTR = "data-nowen-create-scope";
const ALL_NOTES_HOST_ATTR = "data-knowledge-tree-all-notes-host";

function markCreateButtons(root: HTMLElement): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('button[title="新建根文件夹"]')) {
    button.setAttribute(CREATE_SCOPE_ATTR, "root");
    button.title = "新建";
    button.setAttribute("aria-label", "在根目录新建");
    button.setAttribute("aria-haspopup", "menu");
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('button[title="新建文档"]')) {
    button.setAttribute(CREATE_SCOPE_ATTR, "node");
    button.title = "新建";
    const row = button.closest<HTMLElement>("[data-knowledge-tree-node-id]");
    const title = row?.querySelector<HTMLButtonElement>('button[title]:not([data-nowen-create-scope])')?.title;
    button.setAttribute("aria-label", title ? `在“${title}”下新建` : "在当前节点下新建");
    button.setAttribute("aria-haspopup", "menu");
  }
}

function ensureAllNotesHost(root: HTMLElement): HTMLElement | null {
  const panel = root.querySelector<HTMLElement>('[data-nowen-knowledge-tree="embedded"]');
  if (!panel) return null;
  const scroll = panel.querySelector<HTMLElement>('[data-swipe-blocker="knowledge-tree-scroll"]');
  if (!scroll || scroll.parentElement !== panel) return null;

  const mobileToolbarHost = panel.querySelector<HTMLElement>(
    `[${ALL_NOTES_HOST_ATTR}="mobile-toolbar"]`,
  );
  if (mobileToolbarHost) {
    for (const host of panel.querySelectorAll<HTMLElement>(`[${ALL_NOTES_HOST_ATTR}]`)) {
      if (host !== mobileToolbarHost) host.remove();
    }
    return mobileToolbarHost;
  }

  let host = panel.querySelector<HTMLElement>(`[${ALL_NOTES_HOST_ATTR}]`);
  if (!host) {
    host = document.createElement("div");
    host.setAttribute(ALL_NOTES_HOST_ATTR, "");
    host.className = "shrink-0 px-2 pb-1.5";
    panel.insertBefore(host, scroll);
  }
  return host;
}

function AllNotesEntry({
  variant,
  compact,
}: {
  variant: "desktop" | "mobile";
  compact: boolean;
}) {
  const { state } = useApp();
  const actions = useAppActions();
  const active = state.viewMode === "all"
    && state.selectedNotebookId === null
    && state.selectedTagIds.length === 0;
  const allNotesCount = useMemo(() => {
    const countedNotebooks = state.notebooks.filter(
      (notebook) => typeof notebook.noteCount === "number",
    );
    if (countedNotebooks.length === state.notebooks.length) {
      return countedNotebooks.reduce(
        (total, notebook) => total + Math.max(0, notebook.noteCount || 0),
        0,
      );
    }
    return active ? state.notes.length : null;
  }, [active, state.notebooks, state.notes.length]);

  const openAllNotes = useCallback(() => {
    actions.setSelectedNotebook(null);
    actions.clearSelectedTags();
    actions.setSearchQuery("");
    actions.setViewMode("all");
    actions.setMobileView("list");
    if (variant === "desktop" && state.noteListCollapsed) {
      actions.toggleNoteListCollapsed();
    }
    if (variant === "mobile") actions.setMobileSidebar(false);
  }, [actions, state.noteListCollapsed, variant]);

  return (
    <button
      type="button"
      onClick={openAllNotes}
      className={cn(
        "group flex w-full items-center text-left font-medium transition-colors",
        compact
          ? "h-8 gap-1.5 rounded-md px-2 text-[11px]"
          : "h-9 gap-2 rounded-lg border px-2.5 text-xs",
        active
          ? compact
            ? "bg-accent-primary/10 text-accent-primary"
            : "border-accent-primary/15 bg-accent-primary/10 text-accent-primary"
          : compact
            ? "text-tx-secondary hover:bg-app-bg hover:text-tx-primary"
            : "border-transparent text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
      )}
      aria-current={active ? "page" : undefined}
      aria-label={allNotesCount === null ? "查看所有笔记" : `查看所有笔记，共 ${allNotesCount} 条`}
      data-knowledge-tree-all-notes=""
    >
      <Files size={compact ? 14 : 15} className="shrink-0 text-accent-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">所有笔记</span>
      {!compact && allNotesCount !== null && (
        <span
          className={cn(
            "shrink-0 rounded-full text-center tabular-nums",
            compact
              ? "min-w-4 px-1 text-[9px] leading-4"
              : "min-w-6 px-1.5 text-[10px] leading-5",
            active ? "bg-accent-primary/10 text-accent-primary" : "bg-app-hover text-tx-tertiary",
          )}
          data-knowledge-tree-all-notes-count=""
        >
          {allNotesCount}
        </span>
      )}
    </button>
  );
}

export function KnowledgeTreePanel(props: KnowledgeTreePanelProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const rootRef = useRef<HTMLDivElement>(null);
  const requestCounterRef = useRef(0);
  const [createMenu, setCreateMenu] = useState<KnowledgeTreeCreateMenuState | null>(null);
  const [createRequest, setCreateRequest] = useState<KnowledgeTreeInlineCreateRequest | undefined>();
  const [importRequest, setImportRequest] = useState<KnowledgeTreeImportRequest | undefined>();
  const [templateCreateRequest, setTemplateCreateRequest] = useState<KnowledgeTreeTemplateCreateRequest | undefined>();
  const [templatePicker, setTemplatePicker] = useState<{ parentId: string | null } | null>(null);
  const [encryptedCreate, setEncryptedCreate] = useState<{ parentId: string | null } | null>(null);
  const [allNotesHost, setAllNotesHost] = useState<HTMLElement | null>(null);
  const [layoutMode, setLayoutMode] = useState<NoteWorkspaceLayoutMode>(() =>
    loadNoteWorkspaceLayoutMode(state.noteListCollapsed),
  );
  const variant = props.variant ?? "desktop";
  const showAllNotesEntry = variant === "mobile"
    || (layoutMode === "three-column" && !state.editorFullscreen);

  useEffect(() => {
    const updateFromPreference = (event: Event) => {
      const mode = (event as CustomEvent<NoteWorkspaceLayoutMode>).detail;
      if (mode === "standard" || mode === "three-column") setLayoutMode(mode);
    };
    const updateFromStorage = (event: StorageEvent) => {
      if (event.key !== NOTE_WORKSPACE_LAYOUT_STORAGE_KEY) return;
      setLayoutMode(loadNoteWorkspaceLayoutMode(state.noteListCollapsed));
    };
    window.addEventListener(NOTE_WORKSPACE_LAYOUT_CHANGED_EVENT, updateFromPreference);
    window.addEventListener("storage", updateFromStorage);
    return () => {
      window.removeEventListener(NOTE_WORKSPACE_LAYOUT_CHANGED_EVENT, updateFromPreference);
      window.removeEventListener("storage", updateFromStorage);
    };
  }, [state.noteListCollapsed]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const syncRuntimeEnhancements = () => {
      markCreateButtons(root);
      if (!showAllNotesEntry) {
        for (const host of root.querySelectorAll<HTMLElement>(`[${ALL_NOTES_HOST_ATTR}]`)) {
          // The compact toolbar host belongs to React. Removing it directly leaves
          // React's virtual tree out of sync, so a later three-column switch can
          // only recreate "All notes" in the fallback position.
          if (host.getAttribute(ALL_NOTES_HOST_ATTR) !== "mobile-toolbar") host.remove();
        }
      }
      const host = showAllNotesEntry ? ensureAllNotesHost(root) : null;
      setAllNotesHost((current) => current === host ? current : host);
    };
    syncRuntimeEnhancements();
    const observer = new MutationObserver(syncRuntimeEnhancements);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [showAllNotesEntry]);

  const requestInlineCreate = useCallback((
    parentId: string | null,
    kind: KnowledgeTreeInlineCreateKind,
  ) => {
    setCreateMenu(null);
    requestCounterRef.current += 1;
    setCreateRequest({
      requestId: requestCounterRef.current,
      parentId,
      kind,
    });
  }, []);

  const requestImport = useCallback((
    parentId: string | null,
    kind: KnowledgeTreeImportRequest["kind"],
  ) => {
    setCreateMenu(null);
    requestCounterRef.current += 1;
    setImportRequest({
      requestId: requestCounterRef.current,
      parentId,
      kind,
    });
  }, []);

  const openTemplatePicker = useCallback((parentId: string | null) => {
    setCreateMenu(null);
    setTemplatePicker({ parentId });
  }, []);

  const requestTemplateCreate = useCallback((templateId: string): Promise<void> => {
    const parentId = templatePicker?.parentId ?? null;
    requestCounterRef.current += 1;
    return new Promise<void>((resolve, reject) => {
      setTemplateCreateRequest({
        requestId: requestCounterRef.current,
        parentId,
        templateId,
        onCompleted: resolve,
        onFailed: reject,
      });
    });
  }, [templatePicker?.parentId]);

  const requestPluginTemplateCreate = useCallback(async (pluginId: string, templateId: string, values: Record<string, unknown>) => {
    const parentId = templatePicker?.parentId ?? null;
    await pluginApi.createNoteFromTemplate(pluginId, templateId, { workspaceId: getCurrentWorkspace(), parentId, values });
    window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, { detail: { reason: "plugin-template-created", parentId } }));
    actions.refreshNotebooks(); actions.refreshNotes(); toast.success("已从插件模板创建笔记");
  }, [actions, templatePicker?.parentId]);

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(`button[${CREATE_SCOPE_ATTR}]`);
    if (!button || !rootRef.current?.contains(button)) return;

    event.preventDefault();
    event.stopPropagation();
    const scope = button.getAttribute(CREATE_SCOPE_ATTR);
    const parentId = scope === "node"
      ? button.closest<HTMLElement>("[data-knowledge-tree-node-id]")?.dataset.knowledgeTreeNodeId || null
      : null;
    const anchor = button.getBoundingClientRect();
    setCreateMenu((current) => current?.parentId === parentId ? null : { parentId, anchor });
  }, []);

  return (
    <>
      <div ref={rootRef} className="contents" onClickCapture={handleClickCapture}>
        <KnowledgeTreePanelBase {...props} createRequest={createRequest}
          importRequest={importRequest}
          templateCreateRequest={templateCreateRequest}
          showAllNotesToolbar={showAllNotesEntry}
          layoutMode={layoutMode}
        />
      </div>
      {allNotesHost && createPortal(
        <AllNotesEntry
          variant={variant}
          compact={allNotesHost.getAttribute(ALL_NOTES_HOST_ATTR) === "mobile-toolbar"}
        />,
        allNotesHost,
      )}
      <KnowledgeTreeCreateDropdown
        menu={createMenu}
        onClose={() => setCreateMenu(null)}
        onCreate={requestInlineCreate}
        onCreateFromTemplate={openTemplatePicker}
        onCreateEncrypted={(parentId) => { setCreateMenu(null); setEncryptedCreate({ parentId }); }}
        onImport={requestImport}
      />
      <NoteTemplatePickerDialog
        open={Boolean(templatePicker)}
        onClose={() => setTemplatePicker(null)}
        onCreate={requestTemplateCreate}
        onCreatePlugin={requestPluginTemplateCreate}
      />
      {encryptedCreate && <EncryptedNoteCreateDialog parentId={encryptedCreate.parentId} onClose={() => setEncryptedCreate(null)} />}
    </>
  );
}

export default KnowledgeTreePanel;
