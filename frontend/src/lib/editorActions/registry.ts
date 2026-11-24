import type { PluginContributionRecord, PluginEditorActionContribution, PluginEditorActionPlacement, PluginEditorKind } from "@/lib/pluginApi";

/** Host-side copy of the contract v5 limit; the server enforces the same value. */
export const EDITOR_ACTION_MAX_INPUT_BYTES = 32768;

export interface RegisteredEditorAction extends PluginEditorActionContribution {
  runtimeId: string;
  pluginId: string;
  pluginName: string;
  /** Prompt actions run on the host AI model; the plugin code never sees their text. */
  ai: boolean;
}

export interface EditorActionContext {
  kind: PluginEditorKind;
  editable: boolean;
  guest: boolean;
  trashed: boolean;
  hasSelection: boolean;
}

export interface EditorActionEntry { action: RegisteredEditorAction; disabledReason?: "NEEDS_SELECTION" }

const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PLACEMENTS = new Set<string>(["editor.slash", "editor.selection", "editor.toolbar.actions"]);
const EDITORS = new Set<string>(["tiptap", "markdown"]);
const SELECTION_MODES = new Set<string>(["none", "text", "optional-text"]);
const RESULT_MODES = new Set<string>(["none", "insert", "replace-selection", "open-preview"]);
const PLATFORMS = new Set<string>(["web", "desktop", "android", "ios"]);

function stringList(value: unknown, allowed?: Set<string>): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || (allowed && !allowed.has(item)))) return null;
  return [...new Set(value as string[])];
}

/** Re-validates server data so a malformed or older contribution can never reach an editor. */
export function registerEditorActions(records: readonly PluginContributionRecord[], platform: "web" | "desktop" | "android" | "ios"): RegisteredEditorAction[] {
  const result: RegisteredEditorAction[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const pluginId = String(record?.pluginId || "");
    if (!PLUGIN_ID.test(pluginId) || !Array.isArray(record.editorActions)) continue;
    for (const item of record.editorActions as unknown[]) {
      const action = item as Partial<PluginEditorActionContribution> | null;
      if (!action || !LOCAL_ID.test(String(action.id)) || typeof action.label !== "string" || !action.label.trim()) continue;
      if (Boolean(action.command) === Boolean(action.prompt)) continue;
      const placements = stringList(action.placements, PLACEMENTS), appliesTo = stringList(action.appliesTo, EDITORS);
      const uiPlatform = action.uiPlatform === undefined ? [] : stringList(action.uiPlatform, PLATFORMS);
      if (!placements?.length || !appliesTo?.length || !uiPlatform || !SELECTION_MODES.has(String(action.selectionMode)) || !RESULT_MODES.has(String(action.resultMode))) continue;
      if (uiPlatform.length && !uiPlatform.includes(platform)) continue;
      const runtimeId = `${pluginId}/${action.id}`;
      if (seen.has(runtimeId)) { console.warn(`[editor-actions] duplicate action ignored: ${runtimeId}`); continue; }
      seen.add(runtimeId);
      result.push({
        id: action.id as string,
        ...(action.command ? { command: action.command } : { prompt: action.prompt }),
        label: action.label.slice(0, 60),
        ...(typeof action.description === "string" ? { description: action.description.slice(0, 200) } : {}),
        ...(typeof action.icon === "string" ? { icon: action.icon } : {}),
        keywords: stringList(action.keywords)?.slice(0, 10) ?? [],
        placements: placements as PluginEditorActionPlacement[],
        appliesTo: appliesTo as PluginEditorKind[],
        selectionMode: action.selectionMode as RegisteredEditorAction["selectionMode"],
        resultMode: action.resultMode as RegisteredEditorAction["resultMode"],
        requiresConfirmation: action.requiresConfirmation === true,
        runtimeId,
        pluginId,
        pluginName: typeof record.pluginName === "string" && record.pluginName.trim() ? record.pluginName : pluginId,
        ai: Boolean(action.prompt),
      });
    }
  }
  return result;
}

/** Actions are hidden on read-only, guest or trashed notes; selection-only actions stay visible but disabled. */
export function editorActionsFor(actions: readonly RegisteredEditorAction[], placement: PluginEditorActionPlacement, context: EditorActionContext): EditorActionEntry[] {
  if (!context.editable || context.guest || context.trashed) return [];
  return actions
    .filter((action) => action.appliesTo.includes(context.kind) && action.placements.includes(placement))
    .map((action) => (action.selectionMode === "text" && !context.hasSelection ? { action, disabledReason: "NEEDS_SELECTION" as const } : { action }));
}

/** Whether the result is shown before it touches the document. */
export function needsPreview(action: Pick<RegisteredEditorAction, "resultMode" | "requiresConfirmation">): boolean {
  return action.resultMode === "open-preview" || action.requiresConfirmation === true;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
