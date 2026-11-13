/** Frozen NMF v1 wire types. The server validates all fields and quotas. */
export interface MigrationSource {
  platform: string;
  exportId: string;
}

export interface NmfNote {
  schemaVersion: 1;
  source: MigrationSource & { sourceId: string };
  title: string;
  path?: string[];
  contentFormat: "markdown" | "html" | "txt";
  content: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  attachments?: Array<{
    assetId: string;
    path: string;
    sha256: string;
    mimeType?: string;
    originalPath?: string;
  }>;
  links?: Array<{ href: string; targetSourceId?: string; label?: string }>;
  metadata?: Record<string, string | number | boolean | null>;
}

export type MigrationStatus = "CREATED" | "UPLOADING" | "SCANNING" | "NORMALIZING"
  | "PREVIEW_READY" | "APPROVED" | "IMPORTING" | "VERIFYING" | "COMPLETED"
  | "PARTIAL" | "FAILED" | "CANCELLED" | "PAUSED" | "UNDONE";

export interface NmfManifest {
  format: "nowen-migration";
  schemaVersion: 1;
  source: MigrationSource;
  notes: Array<Omit<NmfNote, "schemaVersion" | "source" | "content"> & {
    sourceId: string;
    contentFile: string;
    sha256: string;
  }>;
}

export interface CreateMigrationParams {
  operationId: string;
  source: MigrationSource;
  name?: string;
  workspaceId?: string | null;
  targetNotebookId?: string | null;
}

export interface MigrationCounts {
  total: number;
  create: number;
  existing: number;
  skipped: number;
  needsAttention: number;
  imported: number;
  failed: number;
  attachments: number;
  bytes: number;
}

/** Summaries intentionally exclude note bodies and attachment bytes. */
export interface MigrationJob {
  id: string;
  status: MigrationStatus;
  source: MigrationSource;
  name: string;
  workspaceId: string | null;
  targetNotebookId: string | null;
  counts: MigrationCounts;
  previewDigest: string | null;
  warnings: string[];
  rootNotebookId: string | null;
  createdAt: string;
  updatedAt: string;
  undo: { available: boolean; reason: string | null };
  error: string | null;
}

export interface MigrationReportItem {
  id: string;
  sourceId: string;
  title: string;
  path: string[];
  status: string;
  action: string;
  targetNoteId: string | null;
  error: string | null;
  warnings: string[];
  unsupportedFields?: string[];
  decision?: "auto" | "skip" | "keep-existing" | "create-copy";
}

export interface CreateMigrationUploadParams {
  operationId: string; filename: string; size: number; sha256: string; assetPath?: string;
}
export interface MigrationUploadSession extends Omit<CreateMigrationUploadParams, "assetPath"> {
  assetPath: string | null;
  id: string; jobId: string; offset: number; chunkBytes: number; expiresAt: string;
  status: "OPEN" | "FINALIZING" | "COMPLETE" | "CANCELLED" | "EXPIRED" | "FAILED";
  error: string | null;
}

export interface MigrationReport {
  job: MigrationJob;
  items: MigrationReportItem[];
  warnings?: string[];
  nextCursor?: string | null;
}

export interface MigrationCapabilities {
  schemaVersion: 1;
  formats: string[];
  humanApprovalRequired: boolean;
  limits: Record<string, number>;
  adapterApiVersion?: 1;
  adapters?: MigrationSourceAdapter[];
  sourceAdapters?: string[];
  [key: string]: unknown;
}

export interface MigrationSourceAdapter {
  id: string; version: 1; platforms: string[]; formats: string[];
  extensions: string[]; autoDetect: boolean; unsupported: string[];
}
