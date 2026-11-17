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
  /** The saved archive no longer matches the page (edited, regenerated or deleted); the next click saves another copy. */
  diverged?: boolean;
  /** 2, 3, … once this page is saved as another copy; externalConversationId then names that copy. */
  copy?: number;
}
/** What the page button shows. Deliberately minimal: no note link, source or server details reach the page. */
export interface QuickStatus {
  state: "idle" | "saving" | "saved" | "error";
  automatic: boolean;
  canOpen: boolean;
  message?: string;
}
