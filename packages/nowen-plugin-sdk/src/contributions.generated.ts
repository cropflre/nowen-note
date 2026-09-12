// 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/contribution-contract.json 生成，请勿手动修改。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type PluginContributionRuntime = "declarative" | "sandbox-js" | "node-action";
export type PluginContributionType = "appearances" | "automationTemplates" | "commands" | "menus" | "noteTemplates" | "promptPacks" | "settings";

export interface PluginContributionContractEntry {
  id: PluginContributionType;
  since: string;
  runtimes: readonly PluginContributionRuntime[];
  declarative: boolean;
  description: string;
}

export const CONTRIBUTION_CONTRACT_VERSION = 1 as const;
export const CONTRIBUTION_NAMESPACE_TEMPLATE = "<pluginId>/<contributionId>" as const;
export const CONTRIBUTION_CONTRACT: readonly PluginContributionContractEntry[] = deepFreeze([
  {
    "id": "appearances",
    "since": "2.1",
    "runtimes": [
      "declarative",
      "sandbox-js",
      "node-action"
    ],
    "declarative": true,
    "description": "Safe semantic appearance tokens rendered by the host"
  },
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
export const APPEARANCE_CONTRIBUTION_LIMITS = deepFreeze({
  "schemaVersion": 1,
  "bases": [
    "default",
    "macos",
    "paper",
    "minimal",
    "eye-care",
    "developer",
    "magazine"
  ],
  "editableTokens": [
    "bg",
    "surface",
    "sidebar",
    "elevated",
    "border",
    "hover",
    "active",
    "textPrimary",
    "textSecondary",
    "textTertiary",
    "textQuaternary",
    "accentPrimary",
    "accentSecondary",
    "accentWarning",
    "accentDanger",
    "accentMuted",
    "pmText",
    "pmHeading",
    "pmCodeBg",
    "pmCodeText",
    "pmPreBg",
    "pmPreBorder",
    "pmPreText",
    "pmBlockquoteBorder",
    "pmBlockquoteText",
    "pmHr",
    "pmPlaceholder",
    "pmTaskDone",
    "pmScrollbar",
    "pmScrollbarHover",
    "pmSelection",
    "radiusWindow",
    "radiusCard",
    "radiusButton",
    "radiusInput",
    "fontFamily",
    "editorFontFamily"
  ],
  "fontCategories": [
    "system",
    "sans",
    "serif",
    "mono"
  ],
  "maxAppearancesPerPlugin": 20
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
