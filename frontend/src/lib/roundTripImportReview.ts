import { api } from "./api";

export interface RoundTripPackageCounts {
  notebooks?: number;
  notes?: number;
  tags?: number;
  noteTags?: number;
  attachments?: number;
}

export interface RoundTripPackageFormatStats {
  markdown?: number;
  richText?: number;
  html?: number;
}

export interface RoundTripPackagePreview {
  success: boolean;
  dryRun?: boolean;
  package?: {
    format?: string;
    formatVersion?: number;
    schemaVersion?: number;
    exportedAt?: string;
    packageKind?: string;
    counts?: RoundTripPackageCounts;
    formatStats?: RoundTripPackageFormatStats;
  };
  counts?: RoundTripPackageCounts & { renamedRoots?: number };
  conflicts?: Array<{
    sourceId?: string;
    originalName?: string;
    importedName?: string;
    parentId?: string | null;
  }>;
  warnings?: Array<{
    type?: string;
    message?: string;
    id?: string;
    path?: string;
  }>;
  errors?: string[];
}

export interface RoundTripImportReviewRequest {
  id: number;
  fileName: string;
  targetLabel?: string;
  source: "nowen-panel" | "shared-import";
  preview: RoundTripPackagePreview;
}

type Listener = (requests: RoundTripImportReviewRequest[]) => void;

let sequence = 1;
let requests: RoundTripImportReviewRequest[] = [];
const listeners = new Set<Listener>();
const resolvers = new Map<number, (accepted: boolean) => void>();
let bridgeInstalled = false;

function emit(): void {
  const snapshot = requests.slice();
  for (const listener of listeners) listener(snapshot);
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
  },
): Promise<boolean> {
  const id = sequence++;
  const request: RoundTripImportReviewRequest = {
    id,
    fileName: options.fileName,
    targetLabel: options.targetLabel,
    source: options.source || "shared-import",
    preview,
  };
  requests = [...requests, request];
  emit();
  return new Promise<boolean>((resolve) => {
    resolvers.set(id, resolve);
  });
}

export function resolveRoundTripImportReview(id: number, accepted: boolean): void {
  const resolve = resolvers.get(id);
  resolvers.delete(id);
  requests = requests.filter((request) => request.id !== id);
  emit();
  resolve?.(accepted);
}

/**
 * DataManager's legacy Nowen panel calls window.confirm immediately after dry-run. The rich review
 * dialog becomes the real confirmation; this one-shot result consumes the legacy confirm without
 * showing a second browser-native prompt. The override automatically expires so unrelated confirms
 * cannot be affected later.
 */
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

/**
 * Enhances the existing Nowen package button without coupling the review UI to DataManager. The
 * API still performs the authoritative server dry-run; the bridge only pauses between dry-run and
 * formal import so the user can inspect counts, warnings and every root-name conflict.
 */
export function installRoundTripImportReviewBridge(): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;

  const nativeDryRun = api.dryRunNowenPackage.bind(api);
  api.dryRunNowenPackage = (async (file: File) => {
    const preview = await nativeDryRun(file) as RoundTripPackagePreview;
    if (!preview?.success) return preview;
    const accepted = await requestRoundTripImportReview(preview, {
      fileName: file.name,
      targetLabel: "当前导入空间",
      source: "nowen-panel",
    });
    armLegacyConfirmResult(accepted);
    return preview;
  }) as typeof api.dryRunNowenPackage;
}

export const roundTripImportReviewTestUtils = {
  reset(): void {
    for (const resolve of resolvers.values()) resolve(false);
    resolvers.clear();
    requests = [];
    sequence = 1;
    emit();
  },
  pendingCount(): number {
    return requests.length;
  },
};
