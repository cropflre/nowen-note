export type AIProvider = "chatgpt" | "doubao";
export interface CapturedMessage {
  externalMessageId: string;
  localSequence: number;
  role: "user" | "assistant";
  blocks: Array<{ type: "markdown"; text: string }>;
  text: string;
  contentHash: string;
  /** Internal content-script transport only; removed before persistence or upload. */
  capturedHtml?: string;
  captureState: "stable" | "streaming" | "partial";
}
export interface ConversationSnapshot {
  provider: AIProvider;
  accountScope: string;
  externalConversationId: string;
  title: string;
  sourceUrl: string;
  messages: CapturedMessage[];
  completeness: "partial" | "unknown";
  capturedAt: string;
}
export interface CapturePreview {
  snapshot: ConversationSnapshot;
  accountMarker: string | null;
  stableIds: boolean;
  warnings: string[];
}
export interface ArchiveSource {
  id: string;
  provider: AIProvider;
  accountScope: string;
  notebookId: string;
  displayName: string;
  captureEnabled: boolean;
  permissionState: "granted" | "revoked";
}
export interface IngestPayload {
  sourceId: string;
  operationId: string;
  expectedRevision: number;
  mode: "manual" | "automatic";
  snapshot: ConversationSnapshot;
}
export interface ArchiveReceipt {
  operationId: string;
  sourceId: string;
  conversationId: string;
  noteId: string;
  revision: number;
  status: "applied" | "duplicate";
  persisted: true;
  persistedAt: string;
  projectionStatus: "updated" | "conflict";
}
export interface CaptureGrant {
  scope: string;
  provider: AIProvider;
  externalConversationId: string;
  sourceUrl: string;
  source: ArchiveSource;
  accountMarker: string | null;
  automatic: boolean;
  revision: number;
  lastHash?: string;
  receipt?: ArchiveReceipt;
  error?: string;
  authorizationCheckedAt?: number;
}
