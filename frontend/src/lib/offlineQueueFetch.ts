/**
 * Bare fetch transport used by the offline queue. It intentionally bypasses
 * the normal API wrapper so a failed replay cannot enqueue itself again.
 */
import { getBaseUrl } from "@/lib/api";

function getToken(): string | null {
  return localStorage.getItem("nowen-token");
}

export async function offlineQueueFetch(
  url: string,
  method: string,
  body: Record<string, unknown> | null,
): Promise<{ ok: boolean; status: number; data?: any }> {
  const token = getToken();
  const fullUrl = `${getBaseUrl()}${url}`;

  const response = await fetch(fullUrl, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
