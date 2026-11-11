// 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/contribution-contract.json 生成，请勿手动修改。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type PluginContributionRuntime = "declarative" | "sandbox-js" | "node-action";
export type PluginContributionType = "automationTemplates" | "commands" | "editorActions" | "inboundWebhooks" | "menus" | "noteTemplates" | "noteThemes" | "promptPacks" | "settings" | "uiComponents";

export interface PluginContributionContractEntry {
  id: PluginContributionType;
  since: string;
  runtimes: readonly PluginContributionRuntime[];
  declarative: boolean;
  description: string;
}

export const CONTRIBUTION_CONTRACT_VERSION = 5 as const;
export const CONTRIBUTION_NAMESPACE_TEMPLATE = "<pluginId>/<contributionId>" as const;
export const CONTRIBUTION_CONTRACT: readonly PluginContributionContractEntry[] = deepFreeze([
  {
    "id": "automationTemplates",
    "since": "2.0",
    "runtimes": [
      "declarative",
      "sandbox-js",
      "node-action"
    ],
    "declarative": true,
    "description": "Static automation templates installed by explicit user action"
  },
  {
    "id": "commands",
    "since": "2.0",
    "runtimes": [
      "sandbox-js",
      "node-action"
    ],
    "declarative": false,
    "description": "Command palette and host command registrations"
  },
  {
    "id": "editorActions",
    "since": "2.2",
    "runtimes": [
      "sandbox-js",
      "node-action"
    ],
    "declarative": false,
    "description": "Host-rendered editor actions (slash menu, selection bubble, editor toolbar) that run a declared command or prompt and return bounded Markdown text"
  },
  {
    "id": "inboundWebhooks",
    "since": "2.0",
    "runtimes": [
      "sandbox-js",
      "node-action"
    ],
    "declarative": false,
    "description": "Host-owned capability-token HTTP callbacks with bounded requests and responses"
  },
  {
    "id": "menus",
    "since": "2.0",
    "runtimes": [
      "sandbox-js",
      "node-action"
    ],
    "declarative": false,
    "description": "Host-owned menu placements referencing declared commands"
  },
  {
    "id": "noteTemplates",
    "since": "2.1",
    "runtimes": [
      "declarative",
      "sandbox-js",
      "node-action"
    ],
    "declarative": true,
    "description": "Static note templates rendered/imported by the host"
  },
  {
    "id": "noteThemes",
    "since": "2.1",
    "runtimes": [
      "declarative",
      "sandbox-js",
      "node-action"
    ],
    "declarative": true,
    "description": "Safe note-scoped visual themes rendered by the host without changing app chrome"
  },
  {
    "id": "promptPacks",
    "since": "2.1",
    "runtimes": [
      "declarative",
      "sandbox-js",
      "node-action"
    ],
    "declarative": true,
    "description": "Static prompt packs with explicit variable schemas"
  },
  {
    "id": "settings",
    "since": "2.0",
    "runtimes": [
      "declarative",
      "sandbox-js",
      "node-action"
    ],
    "declarative": true,
    "description": "Host-rendered extension settings"
  },
  {
    "id": "uiComponents",
    "since": "2.1",
    "runtimes": [
      "declarative",
      "sandbox-js",
      "node-action"
    ],
    "declarative": true,
    "description": "Host-rendered UI actions placed in user-controlled extension slots"
  }
]);
export const NOTE_THEME_CONTRIBUTION_LIMITS = deepFreeze({
  "schemaVersion": 1,
  "bases": [
    "nowen.default"
  ],
  "editableTokens": [
    "surface",
    "text",
    "heading",
    "muted",
    "border",
    "accent",
    "accentHover",
    "inlineCodeBackground",
    "inlineCodeText",
    "preBackground",
    "preText",
    "quoteBorder",
    "quoteText",
    "softBackground",
    "tableStripe",
    "markBackground",
    "selection",
    "contentMaxWidth",
    "lineHeight"
  ],
  "maxThemesPerPlugin": 20
} as const);
export const NOTE_TEMPLATE_CONTRIBUTION_LIMITS = deepFreeze({
  "schemaVersion": 1,
  "maxTemplatesPerPlugin": 100,
  "maxBodyBytes": 262144
} as const);
export const PROMPT_PACK_CONTRIBUTION_LIMITS = deepFreeze({
  "schemaVersion": 1,
  "maxPromptsPerPlugin": 100,
  "maxPromptBytes": 65536
} as const);
export const UI_COMPONENT_CONTRIBUTION_LIMITS = deepFreeze({
  "schemaVersion": 1,
  "kinds": [
    "action"
  ],
  "slots": [
    "floating-layer"
  ],
  "actions": [
    "navigation.open"
  ],
  "maxComponentsPerPlugin": 50
} as const);
export const EDITOR_ACTION_CONTRIBUTION_LIMITS = deepFreeze({
  "schemaVersion": 1,
  "placements": [
    "editor.slash",
    "editor.selection",
    "editor.toolbar.actions"
  ],
  "editors": [
    "tiptap",
    "markdown"
  ],
  "selectionModes": [
    "none",
    "text",
    "optional-text"
  ],
  "resultModes": [
    "none",
    "insert",
    "replace-selection",
    "open-preview"
  ],
  "icons": [
    "sparkles",
    "wand",
    "quote",
    "list",
    "case",
    "template",
    "translate",
    "summary",
    "text"
  ],
  "maxActionsPerPlugin": 30,
  "maxInputBytes": 32768,
  "maxResultBytes": 65536
} as const);
