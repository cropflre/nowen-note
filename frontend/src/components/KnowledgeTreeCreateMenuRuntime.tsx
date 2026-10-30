import React, { useCallback, useEffect, useRef, useState } from "react";

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
import { useApp, useAppActions } from "@/store/AppContext";

export { FOCUS_KNOWLEDGE_TREE_EVENT, KNOWLEDGE_TREE_CHANGED_EVENT };
export type { KnowledgeTreePanelProps };
export { KnowledgeTreeCreateDropdown } from "./KnowledgeTreeCreateDropdown";
export type { KnowledgeTreeCreateMenuState } from "./KnowledgeTreeCreateDropdown";

const CREATE_SCOPE_ATTR = "data-nowen-create-scope";

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
  const [layoutMode, setLayoutMode] = useState<NoteWorkspaceLayoutMode>(() =>
    loadNoteWorkspaceLayoutMode(state.noteListCollapsed),
  );

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
    };
    syncRuntimeEnhancements();
    const observer = new MutationObserver(syncRuntimeEnhancements);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

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
          layoutMode={layoutMode}
        />
      </div>
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
