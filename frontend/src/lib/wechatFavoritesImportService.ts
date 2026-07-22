import { getBaseUrl } from "@/lib/api";

export type WeChatDuplicateStrategy = "skip" | "update" | "duplicate";

export interface WeChatFavoritesImportConfig {
  rootNotebookName: string;
  groupByYear: boolean;
  preserveTags: boolean;
  continueOnMissingMedia: boolean;
  duplicateStrategy: WeChatDuplicateStrategy;
  selectedTypes: string[];
}

export interface WeChatFavoritesImportReport {
  success: boolean;
  dryRun: boolean;
  batchId: string;
  adapter: string;
  rootNotebookId?: string;
  counts: {
    total: number;
    selected: number;
    imported: number;
    updated: number;
    skipped: number;
    partial: number;
    failed: number;
    attachments: number;
    attachmentDeduplicated: number;
    mediaMissing: number;
    mediaTooLarge: number;
    tagsCreated: number;
    tagsReused: number;
    duplicateExisting: number;
    wouldCreate: number;
    wouldUpdate: number;
    wouldSkip: number;
  };
  stats: {
    types: Record<string, number>;
    itemKinds: Record<string, number>;
    tags: number;
    dateFrom?: string;
    dateTo?: string;
    mediaReferences: number;
    mediaAvailable: number;
    mediaMissing: number;
    mediaBytes: number;
    zipEntries: number;
    zipUncompressedBytes: number;
  };
  warnings: string[];
  items: Array<{
    externalId: string;
    title: string;
    status: "imported" | "updated" | "skipped" | "partial" | "failed";
    noteId?: string;
    warnings?: string[];
    error?: string;
  }>;
  durationMs: number;
}

function endpoint(workspaceId: string | null, dryRun: boolean): string {
  const query = new URLSearchParams();
  query.set("dryRun", dryRun ? "1" : "0");
  if (workspaceId) query.set("workspaceId", workspaceId);
  return `${getBaseUrl()}/attachments/import-wechat-favorites-package?${query.toString()}`;
}

async function sendPackage(
  file: File,
  config: WeChatFavoritesImportConfig,
  workspaceId: string | null,
  dryRun: boolean,
): Promise<WeChatFavoritesImportReport> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("config", JSON.stringify(config));
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(endpoint(workspaceId, dryRun), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`) as Error & { code?: string; status?: number };
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  if (!payload || typeof payload !== "object") throw new Error("服务器返回了无效的导入结果");
  return payload as WeChatFavoritesImportReport;
}

export function preflightWeChatFavoritesPackage(
  file: File,
  config: WeChatFavoritesImportConfig,
  workspaceId: string | null,
): Promise<WeChatFavoritesImportReport> {
  return sendPackage(file, config, workspaceId, true);
}

export function importWeChatFavoritesPackage(
  file: File,
  config: WeChatFavoritesImportConfig,
  workspaceId: string | null,
): Promise<WeChatFavoritesImportReport> {
  return sendPackage(file, config, workspaceId, false);
}
