/**
 * Bare fetch transport used by the offline queue. It intentionally bypasses
 * the normal API wrapper so a failed replay cannot enqueue itself again.
 */
import { getBaseUrl } from "@/lib/api";
import type { OfflineQueueFetchContext } from "@/lib/offlineQueue";

function getToken(): string | null {
  return localStorage.getItem("nowen-token");
}

export async function offlineQueueFetch(
  url: string,
  method: string,
  body: Record<string, unknown> | null,
  context?: OfflineQueueFetchContext,
): Promise<{ ok: boolean; status: number; data?: any }> {
  const token = getToken();
  const fullUrl = `${getBaseUrl()}${url}`;

  const response = await fetch(fullUrl, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(context?.idempotencyKey ? { "Idempotency-Key": context.idempotencyKey } : {}),
      ...(context?.item ? { "X-Client-Mutation-At": new Date(context.item.enqueuedAt).toISOString() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }

  return { ok: response.ok, status: response.status, data };
}
