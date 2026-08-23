import { getBaseUrl } from "./api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";

export interface AutomationStep { id: string; type: "action" | "condition" | "delay" | "transform" | "stop"; [key: string]: unknown }
export interface AutomationWorkflow {
  id: string; name: string; description: string; enabled: boolean; workspaceId?: string | null;
  triggerType: "event" | "schedule" | "webhook" | "manual";
  definition: { version: 1; trigger: Record<string, unknown>; steps: AutomationStep[] };
  schedule?: { nextRunAt?: string; lastRunAt?: string } | null;
  webhook?: { signatureRequired: number; lastTriggeredAt?: string } | null;
}
export interface AutomationRun { id: string; workflowId: string; status: string; createdAt: string; startedAt?: string; finishedAt?: string; errorCode?: string; errorMessage?: string; currentStep: number }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${getBaseUrl()}${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...(init.headers || {}) },
  }, getBaseUrl());
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload as T;
}

export const automationApi = {
  list: () => request<AutomationWorkflow[]>("/api/automations"),
  create: (body: Record<string, unknown>) => request<AutomationWorkflow & { webhookCredentials?: { token: string; secret?: string } }>("/api/automations", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: Record<string, unknown>) => request<AutomationWorkflow>(`/api/automations/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  remove: (id: string) => request(`/api/automations/${id}`, { method: "DELETE" }),
  enable: (id: string, enabled: boolean) => request<AutomationWorkflow>(`/api/automations/${id}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
  run: (id: string) => request<AutomationRun>(`/api/automations/${id}/run`, { method: "POST" }),
  runs: (id: string) => request<AutomationRun[]>(`/api/automations/${id}/runs`),
  runDetail: (id: string) => request<AutomationRun & { steps: Array<Record<string, unknown>> }>(`/api/automations/runs/${id}`),
  cancel: (id: string) => request<AutomationRun>(`/api/automations/runs/${id}/cancel`, { method: "POST" }),
};
