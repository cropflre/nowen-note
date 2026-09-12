// 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/contribution-contract.json 生成，请勿手动修改。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type PluginContributionRuntime = "declarative" | "sandbox-js" | "node-action";
export type PluginContributionType = "automationTemplates" | "commands" | "menus" | "noteTemplates" | "noteThemes" | "promptPacks" | "settings";

export interface PluginContributionContractEntry {
  id: PluginContributionType;
  since: string;
  runtimes: readonly PluginContributionRuntime[];
  declarative: boolean;
  description: string;
}

export const CONTRIBUTION_CONTRACT_VERSION = 2 as const;
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
  }
]);
export const NOTE_THEME_CONTRIBUTION_LIMITS = deepFreeze({
  "schemaVersion": 1,
  "bases": [
    "nowen.default"
  ],
  "editableTokens": [
    "canvasBackground",
    "contentBackground",
    "contentText",
    "mutedText",
    "headingText",
    "linkColor",
    "linkWeight",
    "quoteBackground",
    "quoteBorder",
    "tableBorder",
    "tableHeaderBackground",
    "tableStripeBackground",
    "codeBackground",
    "inlineCodeBackground",
    "contentMaxWidth",
    "contentPaddingInline",
    "contentPaddingBlock",
    "fontCategory",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "paragraphSpacing",
    "radius",
    "controlBackground",
    "controlBorder"
  ],
  "fontCategories": [
    "system",
    "sans",
    "serif",
    "mono"
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
