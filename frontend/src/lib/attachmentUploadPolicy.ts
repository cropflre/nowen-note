import { getBaseUrl } from "@/lib/api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";

export const DEFAULT_ATTACHMENT_LIMIT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_LIMIT_BYTES = 10_240 * 1024 * 1024;

export interface AttachmentUploadPolicy {
  maxAttachmentSizeBytes: number;
  authoritative: boolean;
  source: "server" | "fallback";
}

let cachedBaseUrl = "";
let cachedPolicy: AttachmentUploadPolicy = {
  maxAttachmentSizeBytes: DEFAULT_ATTACHMENT_LIMIT_BYTES,
  authoritative: false,
  source: "fallback",
};
let pendingPolicy: Promise<AttachmentUploadPolicy> | null = null;

function normalizeLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_ATTACHMENT_LIMIT_BYTES) return null;
  return Math.floor(parsed);
}

export function formatAttachmentLimit(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  if (mib >= 1024) {
    const gib = mib / 1024;
    return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
  }
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

export function getCachedAttachmentUploadPolicy(): AttachmentUploadPolicy {
  return cachedPolicy;
}

export function validateAttachmentSize(
  fileSize: number,
  policy: AttachmentUploadPolicy = cachedPolicy,
): { ok: true } | { ok: false; message: string; maxSizeBytes: number; actualSizeBytes: number } {
  if (!policy.authoritative || !Number.isFinite(fileSize) || fileSize <= policy.maxAttachmentSizeBytes) {
    return { ok: true };
  }
  return {
    ok: false,
    maxSizeBytes: policy.maxAttachmentSizeBytes,
    actualSizeBytes: fileSize,
    message: `文件大小超过服务器附件上限 ${formatAttachmentLimit(policy.maxAttachmentSizeBytes)}`,
  };
}

async function fetchPolicy(baseUrl: string): Promise<AttachmentUploadPolicy> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 3_000);
  try {
    const token = getAccessToken();
    const response = await fetchWithAuthRefresh(`${baseUrl}/attachment-upload-policy`, {
      method: "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    }, baseUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { maxAttachmentSizeBytes?: unknown };
    const limit = normalizeLimit(payload.maxAttachmentSizeBytes);
    if (!limit) throw new Error("invalid attachment upload policy");
    return {
      maxAttachmentSizeBytes: limit,
      authoritative: true,
      source: "server",
    };
  } catch {
    // An old/unreachable server must remain authoritative for the actual POST. Do not reject a
    // 200 MiB file locally just because the fallback is 100 MiB: that server may be configured
    // for 500 MiB. The upload response will still provide the final contract.
    return {
      maxAttachmentSizeBytes: DEFAULT_ATTACHMENT_LIMIT_BYTES,
      authoritative: false,
      source: "fallback",
    };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function loadAttachmentUploadPolicy(force = false): Promise<AttachmentUploadPolicy> {
  const baseUrl = getBaseUrl().replace(/\/+$/, "");
  if (!force && cachedBaseUrl === baseUrl && cachedPolicy.authoritative) {
    return Promise.resolve(cachedPolicy);
  }
  if (!force && cachedBaseUrl === baseUrl && pendingPolicy) return pendingPolicy;

  cachedBaseUrl = baseUrl;
  pendingPolicy = fetchPolicy(baseUrl).then((policy) => {
    cachedPolicy = policy;
    return policy;
  }).finally(() => {
    pendingPolicy = null;
  });
  return pendingPolicy;
}

export function warmAttachmentUploadPolicy(): void {
  if (typeof window === "undefined") return;
  void loadAttachmentUploadPolicy().catch(() => undefined);
}
