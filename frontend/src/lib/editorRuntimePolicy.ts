import {
  buildEditorComplexityProfile,
  type EditorComplexityProfile,
} from "@/lib/editorComplexityProfile";

export type EditorRuntimeMode =
  | "normal"
  | "viewport-optimized"
  | "lightweight-edit"
  | "emergency-readonly";

export type EditorComplexityReason =
  | "serialized-size"
  | "line-count"
  | "long-line"
  | "node-count"
  | "media-count"
  | "code-block-count"
  | "initialization-timeout"
  | "runtime-long-task";

export type EditorRuntimeCapability =
  | "editable"
  | "live-preview"
  | "syntax-highlight"
  | "eager-heavy-nodes"
  | "whole-document-analysis"
  | "realtime-decorations"
  | "collaboration"
  | "rich-node-toolbars";

export interface EditorRuntimeCapabilities {
  editable: boolean;
  livePreview: boolean;
  syntaxHighlight: boolean;
  eagerHeavyNodes: boolean;
  wholeDocumentAnalysis: boolean;
  realtimeDecorations: boolean;
  collaboration: boolean;
  richNodeToolbars: boolean;
}

export interface EditorRuntimeDecision {
  mode: EditorRuntimeMode;
  reasons: EditorComplexityReason[];
  disabledCapabilities: EditorRuntimeCapability[];
  capabilities: EditorRuntimeCapabilities;
  profile: EditorComplexityProfile;
}

export const EDITOR_RUNTIME_THRESHOLDS = {
  markdown: {
    viewport: {
      characters: 180_000,
      lines: 4_000,
      longestLine: 3_500,
      codeBlocks: 80,
    },
    lightweight: {
      characters: 750_000,
      lines: 20_000,
      longestLine: 8_000,
    },
  },
  richText: {
    viewport: {
      characters: 100_000,
      nodes: 2_500,
      heavyNodes: 40,
    },
    lightweight: {
      characters: 350_000,
      nodes: 8_000,
      heavyNodes: 120,
    },
    emergency: {
      characters: 1_000_000,
      nodes: 20_000,
    },
  },
} as const;

const CAPABILITIES_BY_MODE: Record<EditorRuntimeMode, EditorRuntimeCapabilities> = {
  normal: {
    editable: true,
    livePreview: true,
    syntaxHighlight: true,
    eagerHeavyNodes: true,
    wholeDocumentAnalysis: true,
    realtimeDecorations: true,
    collaboration: true,
    richNodeToolbars: true,
  },
  "viewport-optimized": {
    editable: true,
    livePreview: true,
    syntaxHighlight: true,
    eagerHeavyNodes: false,
    wholeDocumentAnalysis: false,
    realtimeDecorations: true,
    collaboration: true,
    richNodeToolbars: true,
  },
  "lightweight-edit": {
    editable: true,
    livePreview: false,
    syntaxHighlight: false,
    eagerHeavyNodes: false,
    wholeDocumentAnalysis: false,
    realtimeDecorations: false,
    collaboration: true,
    richNodeToolbars: false,
  },
  "emergency-readonly": {
    editable: false,
    livePreview: false,
    syntaxHighlight: false,
    eagerHeavyNodes: false,
    wholeDocumentAnalysis: false,
    realtimeDecorations: false,
    collaboration: false,
    richNodeToolbars: false,
  },
};

const CAPABILITY_KEYS: Array<[keyof EditorRuntimeCapabilities, EditorRuntimeCapability]> = [
  ["editable", "editable"],
  ["livePreview", "live-preview"],
  ["syntaxHighlight", "syntax-highlight"],
  ["eagerHeavyNodes", "eager-heavy-nodes"],
  ["wholeDocumentAnalysis", "whole-document-analysis"],
  ["realtimeDecorations", "realtime-decorations"],
  ["collaboration", "collaboration"],
  ["richNodeToolbars", "rich-node-toolbars"],
];

function capabilitiesFor(mode: EditorRuntimeMode): EditorRuntimeCapabilities {
  return { ...CAPABILITIES_BY_MODE[mode] };
}

function disabledCapabilitiesFor(capabilities: EditorRuntimeCapabilities): EditorRuntimeCapability[] {
  return CAPABILITY_KEYS
    .filter(([key]) => !capabilities[key])
    .map(([, label]) => label);
}

function pushReason(reasons: EditorComplexityReason[], reason: EditorComplexityReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function resolveMarkdownMode(profile: EditorComplexityProfile): {
  mode: EditorRuntimeMode;
  reasons: EditorComplexityReason[];
} {
  const reasons: EditorComplexityReason[] = [];
  const { viewport, lightweight } = EDITOR_RUNTIME_THRESHOLDS.markdown;

  if (profile.characters >= lightweight.characters) pushReason(reasons, "serialized-size");
  if (profile.lines >= lightweight.lines) pushReason(reasons, "line-count");
  if (profile.longestLine >= lightweight.longestLine) pushReason(reasons, "long-line");
  if (reasons.length > 0) return { mode: "lightweight-edit", reasons };

  if (profile.characters >= viewport.characters) pushReason(reasons, "serialized-size");
  if (profile.lines >= viewport.lines) pushReason(reasons, "line-count");
  if (profile.longestLine >= viewport.longestLine) pushReason(reasons, "long-line");
  if (profile.codeBlockCount >= viewport.codeBlocks) pushReason(reasons, "code-block-count");
  return reasons.length > 0
    ? { mode: "viewport-optimized", reasons }
    : { mode: "normal", reasons };
}

function resolveRichTextMode(profile: EditorComplexityProfile): {
  mode: EditorRuntimeMode;
  reasons: EditorComplexityReason[];
} {
  const reasons: EditorComplexityReason[] = [];
  const { viewport, lightweight, emergency } = EDITOR_RUNTIME_THRESHOLDS.richText;
  const mediaCount = profile.imageCount + profile.attachmentCount + profile.embedCount + profile.tableCount;
  const heavyNodeCount = mediaCount + profile.codeBlockCount;

  if (profile.characters >= emergency.characters) pushReason(reasons, "serialized-size");
  if (profile.approximateNodes >= emergency.nodes) pushReason(reasons, "node-count");
  if (reasons.length > 0) return { mode: "emergency-readonly", reasons };

  if (profile.characters >= lightweight.characters) pushReason(reasons, "serialized-size");
  if (profile.approximateNodes >= lightweight.nodes) pushReason(reasons, "node-count");
  if (heavyNodeCount >= lightweight.heavyNodes) pushReason(reasons, "media-count");
  if (profile.codeBlockCount >= Math.ceil(lightweight.heavyNodes / 2)) {
    pushReason(reasons, "code-block-count");
  }
  if (reasons.length > 0) return { mode: "lightweight-edit", reasons };

  if (profile.characters >= viewport.characters) pushReason(reasons, "serialized-size");
  if (profile.approximateNodes >= viewport.nodes) pushReason(reasons, "node-count");
  if (heavyNodeCount >= viewport.heavyNodes) pushReason(reasons, "media-count");
  if (profile.codeBlockCount >= Math.ceil(viewport.heavyNodes / 2)) {
    pushReason(reasons, "code-block-count");
  }
  return reasons.length > 0
    ? { mode: "viewport-optimized", reasons }
    : { mode: "normal", reasons };
}

export function createEditorRuntimeDecision(
  mode: EditorRuntimeMode,
  reasons: EditorComplexityReason[],
  profile: EditorComplexityProfile,
): EditorRuntimeDecision {
  const capabilities = capabilitiesFor(mode);
  return {
    mode,
    reasons: [...new Set(reasons)],
    disabledCapabilities: disabledCapabilitiesFor(capabilities),
    capabilities,
    profile,
  };
}

export function resolveEditorRuntimeDecision(input: {
  content: string | null | undefined;
  contentText?: string | null | undefined;
  contentFormat: string | null | undefined;
}): EditorRuntimeDecision {
  const source = input.content || input.contentText || "";
  const profile = buildEditorComplexityProfile(source, input.contentFormat);
  const resolved = profile.contentFormat === "markdown"
    ? resolveMarkdownMode(profile)
    : resolveRichTextMode(profile);
  return createEditorRuntimeDecision(resolved.mode, resolved.reasons, profile);
}

const MODE_RANK: Record<EditorRuntimeMode, number> = {
  normal: 0,
  "viewport-optimized": 1,
  "lightweight-edit": 2,
  "emergency-readonly": 3,
};

export function withEditorRuntimeMode(
  decision: EditorRuntimeDecision,
  mode: EditorRuntimeMode,
  reason?: EditorComplexityReason,
): EditorRuntimeDecision {
  if (MODE_RANK[mode] < MODE_RANK[decision.mode]) return decision;
  const reasons = reason && !decision.reasons.includes(reason)
    ? [...decision.reasons, reason]
    : decision.reasons;
  return createEditorRuntimeDecision(mode, reasons, decision.profile);
}

export function isEditorRuntimeCapabilityEnabled(
  decision: EditorRuntimeDecision,
  capability: EditorRuntimeCapability,
): boolean {
  return !decision.disabledCapabilities.includes(capability);
}
