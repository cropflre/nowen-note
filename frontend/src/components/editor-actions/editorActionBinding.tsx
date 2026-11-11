import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEditorActions } from "@/hooks/useEditorActions";
import { editorActionsFor, type RegisteredEditorAction } from "@/lib/editorActions/registry";
import { runEditorAction, type EditorActionUiState } from "@/lib/editorActions/runner";
import type { EditorActionAdapter } from "@/lib/editorActions/types";
import { pluginApi, type PluginEditorActionPlacement } from "@/lib/pluginApi";
import { toast } from "@/lib/toast";
import { EditorActionIcon } from "./EditorActionIcon";
import { EditorActionsHost } from "./EditorActionsHost";
import { EditorActionsMenu } from "./EditorActionsMenu";

export interface EditorActionBindingOptions { noteId: string; editable: boolean; guest: boolean; trashed: boolean }

export interface EditorActionBinding {
  /** Slash entries in a neutral shape; each editor maps them onto its own item type. */
  slashEntries: Array<{ id: string; label: string; description: string; icon: React.ReactNode; category: string; keywords: string[]; run: () => void }>;
  menu(placement: Exclude<PluginEditorActionPlacement, "editor.slash">, options?: { iconSize?: number; compact?: boolean }): React.ReactNode;
  host: React.ReactNode;
}

/** Shared by both editors: one registry, one runner, one preview host. */
export function useEditorActionBinding(adapter: EditorActionAdapter | null, { editable, guest, trashed }: EditorActionBindingOptions): EditorActionBinding {
  const { t } = useTranslation();
  const enabled = Boolean(adapter) && editable && !guest && !trashed;
  const actions = useEditorActions(enabled);
  const [ui, setUi] = useState<EditorActionUiState>({ phase: "idle" });
  const tRef = useRef(t); tRef.current = t;
  const uiRef = useRef(ui); uiRef.current = ui;

  // Leaving the editor cancels a pending run or preview so no snapshot outlives it.
  useEffect(() => () => {
    const current = uiRef.current;
    if (current.phase === "running") current.cancel();
    if (current.phase === "preview") current.resolve("cancel");
  }, [adapter]);

  const run = useCallback((action: RegisteredEditorAction) => {
    if (!adapter) return;
    void runEditorAction(adapter, action, {
      run: pluginApi.runEditorAction,
      notify: { info: (message) => toast.info(message), success: (message) => toast.success(message), error: (message) => toast.error(message) },
      copy: (text) => navigator.clipboard.writeText(text),
      t: (key, options) => tRef.current(key, options) as string,
      onUi: setUi,
    });
  }, [adapter]);

  const visible = useMemo(() => (enabled && adapter ? actions.filter((action) => action.appliesTo.includes(adapter.kind)) : []), [actions, adapter, enabled]);

  const slashEntries = useMemo(() => visible.filter((action) => action.placements.includes("editor.slash")).map((action) => ({
    id: action.runtimeId,
    label: action.label,
    description: action.description || t("editorActions.fromPlugin", { plugin: action.pluginName }),
    icon: <EditorActionIcon icon={action.icon} size={16} />,
    category: t("editorActions.slashCategory"),
    keywords: [...(action.keywords || []), action.pluginName, action.pluginId],
    run: () => run(action),
  })), [visible, run, t]);

  const menu = useCallback<EditorActionBinding["menu"]>((placement, options = {}) => {
    if (!adapter || !visible.some((action) => action.placements.includes(placement))) return null;
    const getEntries = () => editorActionsFor(visible, placement, { kind: adapter.kind, editable, guest, trashed, hasSelection: adapter.hasSelection() });
    return <EditorActionsMenu placement={placement} getEntries={getEntries} onRun={run} iconSize={options.iconSize} compact={options.compact} />;
  }, [adapter, visible, editable, guest, trashed, run]);

  return { slashEntries, menu, host: <EditorActionsHost state={ui} /> };
}
