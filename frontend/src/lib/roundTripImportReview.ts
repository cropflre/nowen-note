import { api, getBaseUrl, getCurrentWorkspace } from "./api";
import { announceRoundTripImportCompleted } from "./roundTripImportBatches";

export type RoundTripImportStrategy = "copy" | "merge" | "sync";

export interface RoundTripPackageCounts {
  notebooks?: number;
  notes?: number;
  tags?: number;
  noteTags?: number;
  attachments?: number;
  renamedRoots?: number;
  mergedNotebooks?: number;
  renamedNotes?: number;
  updatedNotebooks?: number;
  updatedNotes?: number;
  unchangedNotes?: number;
  localConflicts?: number;
  recreatedResources?: number;
  reusedAttachments?: number;
  removedAttachments?: number;
}

export interface RoundTripPackageFormatStats {
  markdown?: number;
  richText?: number;
  html?: number;
}

export type RoundTripImportConflictAction =
  | "rename-root"
  | "merge-directory"
  | "rename-note"
  | "sync-create-directory"
  | "sync-update-directory"
  | "sync-create-note"
  | "sync-update-note"
  | "sync-local-conflict"
  | "sync-replace-attachment";

export interface RoundTripImportConflict {
  action?: RoundTripImportConflictAction;
  resourceType?: "notebook" | "note" | "attachment";
  sourceId?: string;
  originalName?: string;
  importedName?: string;
  parentId?: string | null;
  targetId?: string;
}

export interface RoundTripSyncAvailability {
  available?: boolean;
  linkedResources?: number;
  reason?: string | null;
}

export interface RoundTripPackagePreview {
  success: boolean;
  dryRun?: boolean;
  strategy?: RoundTripImportStrategy;
  package?: {
    format?: string;
    formatVersion?: number;
    schemaVersion?: number;
    exportedAt?: string;
    packageKind?: string;
    sourceInstanceId?: string | null;
    exportBatchId?: string | null;
    sync?: RoundTripSyncAvailability;
    counts?: RoundTripPackageCounts;
    formatStats?: RoundTripPackageFormatStats;
  };
  counts?: RoundTripPackageCounts;
  conflicts?: RoundTripImportConflict[];
  warnings?: Array<{
    type?: string;
    message?: string;
    id?: string;
    path?: string;
  }>;
  errors?: string[];
  importBatch?: {
    id?: string;
    undoAvailable?: boolean;
    undoExpiresAt?: string | null;
    reason?: string | null;
  };
}

export type RoundTripImportReviewDecision =
  | { accepted: false }
  | { accepted: true; strategy: RoundTripImportStrategy };

export interface RoundTripImportReviewRequest {
  id: number;
  fileName: string;
  targetLabel?: string;
  source: "nowen-panel" | "shared-import";
  preview: RoundTripPackagePreview;
  initialStrategy: RoundTripImportStrategy;
  loadPreview?: (strategy: RoundTripImportStrategy) => Promise<RoundTripPackagePreview>;
}

interface SubmitRoundTripPackageOptions {
  dryRun: boolean;
  strategy: RoundTripImportStrategy;
  workspaceId?: string;
  targetNotebookId?: string;
}

interface RememberedImportDecision {
  strategy: RoundTripImportStrategy;
  workspaceId?: string;
}

type Listener = (requests: RoundTripImportReviewRequest[]) => void;

let sequence = 1;
let requests: RoundTripImportReviewRequest[] = [];
const listeners = new Set<Listener>();
const resolvers = new Map<number, (decision: RoundTripImportReviewDecision) => void>();
const selectedDecisionByFile = new WeakMap<File, RememberedImportDecision>();
let bridgeInstalled = false;

function emit(): void {
  const snapshot = requests.slice();
  for (const listener of listeners) listener(snapshot);
}

function readToken(): string | null {
  try {
    return localStorage.getItem("nowen-token");
  } catch {
    return null;
  }
}

function announceBatch(payload: RoundTripPackagePreview): void {
  const batchId = String(payload?.importBatch?.id || "");
  if (batchId) announceRoundTripImportCompleted(batchId);
}

export async function submitRoundTripPackage(
  file: File,
  options: SubmitRoundTripPackageOptions,
): Promise<RoundTripPackagePreview> {
  const params = new URLSearchParams();
  if (options.workspaceId && options.workspaceId !== "personal") {
    params.set("workspaceId", options.workspaceId);
  }
  if (options.targetNotebookId) params.set("targetNotebookId", options.targetNotebookId);
  params.set(
    "importMode",
    options.strategy === "sync"
      ? "sync"
      : options.strategy === "merge"
        ? "merge"
        : options.targetNotebookId
          ? "into-target"
          : "new-root",
  );
  if (options.dryRun) params.set("dryRun", "1");

  const form = new FormData();
  form.append("file", file);
  const token = readToken();
  const response = await fetch(`${getBaseUrl()}/export/import/nowen-package?${params.toString()}`, {
    method: "POST",
    credentials: "include",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
  });
  const payload = await response.json().catch(() => ({})) as RoundTripPackagePreview & { error?: string };
  if (!response.ok || payload?.success === false) {
    const details = Array.isArray(payload?.errors) && payload.errors.length
      ? payload.errors.join("；")
      : payload?.error;
    throw new Error(details || `HTTP ${response.status}`);
  }
  if (!options.dryRun) announceBatch(payload);
  return payload;
}

export function subscribeRoundTripImportReviews(listener: Listener): () => void {
  listeners.add(listener);
  listener(requests.slice());
  return () => {
    listeners.delete(listener);
  };
}

export function requestRoundTripImportReview(
  preview: RoundTripPackagePreview,
  options: {
    fileName: string;
    targetLabel?: string;
    source?: RoundTripImportReviewRequest["source"];
    initialStrategy?: RoundTripImportStrategy;
    loadPreview?: RoundTripImportReviewRequest["loadPreview"];
  },
): Promise<RoundTripImportReviewDecision> {
  const id = sequence++;
  const request: RoundTripImportReviewRequest = {
    id,
    fileName: options.fileName,
    targetLabel: options.targetLabel,
    source: options.source || "shared-import",
    preview,
    initialStrategy: options.initialStrategy || preview.strategy || "copy",
    loadPreview: options.loadPreview,
  };
  requests = [...requests, request];
  emit();
  return new Promise<RoundTripImportReviewDecision>((resolve) => {
    resolvers.set(id, resolve);
  });
}

export function resolveRoundTripImportReview(
  id: number,
  decision: RoundTripImportReviewDecision,
): void {
  const resolve = resolvers.get(id);
  resolvers.delete(id);
  requests = requests.filter((request) => request.id !== id);
  emit();
  resolve?.(decision);
}

/** Consume DataManager's legacy confirm after the rich preflight dialog decides. */
function armLegacyConfirmResult(result: boolean): void {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return;
  const previous = window.confirm;
  let timer = 0;
  const restore = () => {
    if (window.confirm === wrapper) window.confirm = previous;
    if (timer) window.clearTimeout(timer);
  };
  const wrapper = ((_message?: string) => {
    restore();
    return result;
  }) as typeof window.confirm;
  window.confirm = wrapper;
  timer = window.setTimeout(restore, 2_000);
}

function currentWorkspaceId(): string | undefined {
  const value = getCurrentWorkspace();
  return value && value !== "personal" ? value : undefined;
}

/**
 * Enhance the legacy Nowen-package panel without coupling it to the review dialog.
 *
 * All three strategies use the same explicit workspace-aware endpoint. This avoids the historical
 * dry-run/import mismatch where the preview was calculated in personal scope while the UI showed a
 * workspace. Sync is only offered when the server confirms that stable source mappings exist.
 */
export function installRoundTripImportReviewBridge(): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;

  const nativeImport = api.importNowenPackage.bind(api);

  api.dryRunNowenPackage = (async (file: File) => {
    const workspaceId = currentWorkspaceId();
    const preview = await submitRoundTripPackage(file, {
      dryRun: true,
      strategy: "copy",
      workspaceId,
    });
    if (!preview?.success) return preview;
    const decision = await requestRoundTripImportReview(preview, {
      fileName: file.name,
      targetLabel: workspaceId ? "所选工作区" : "个人空间",
      source: "nowen-panel",
      initialStrategy: "copy",
      loadPreview: (strategy) => submitRoundTripPackage(file, {
        dryRun: true,
        strategy,
        workspaceId,
      }),
    });
    if (decision.accepted) {
      selectedDecisionByFile.set(file, { strategy: decision.strategy, workspaceId });
    } else {
      selectedDecisionByFile.delete(file);
    }
    armLegacyConfirmResult(decision.accepted);
    return preview;
  }) as typeof api.dryRunNowenPackage;

  api.importNowenPackage = (async (file: File, opts?: any) => {
    const remembered = selectedDecisionByFile.get(file);
    selectedDecisionByFile.delete(file);
    if (!remembered) {
      const payload = await nativeImport(file, opts) as RoundTripPackagePreview;
      announceBatch(payload);
      return payload;
    }
    return submitRoundTripPackage(file, {
      dryRun: false,
      strategy: remembered.strategy,
      workspaceId: opts?.workspaceId ?? remembered.workspaceId,
      targetNotebookId: opts?.targetNotebookId,
    });
  }) as typeof api.importNowenPackage;
}

export const roundTripImportReviewTestUtils = {
  reset(): void {
    for (const resolve of resolvers.values()) resolve({ accepted: false });
    resolvers.clear();
    requests = [];
    sequence = 1;
    emit();
  },
  pendingCount(): number {
    return requests.length;
  },
};
