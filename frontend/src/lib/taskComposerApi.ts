import { getBaseUrl, getCurrentWorkspace } from "./api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";
import { getOfflineQueueStorageKey } from "./offlineScope";
import { isMobileLocalMode } from "./mobileLocalMode";
import { TASK_REMINDER_SYNC_EVENT } from "./taskNotificationSchedule";
import type { Task, TaskProject } from "@/types";

export interface TaskComposerOptions {
  maxTasks: number; projectId: string | null; fromDate: string | null; toDate: string | null;
  focusCount: number; recognizeRepeat: boolean; recognizeTime: boolean;
}
export interface TaskCandidate {
  clientId: string; title: string; description: string; priority: 1 | 2 | 3;
  startDate: string | null; dueDate: string | null; dueAt: string | null; projectId: string | null;
  repeatRule: "none" | "daily" | "weekly" | "monthly" | "yearly"; repeatInterval: number;
  repeatEndDate: string | null; repeatEndCount: number | null;
  reason: string; warnings: string[]; duplicateOf: string[];
  selected: boolean; allowDuplicate: boolean;
}
export type ConfirmedCandidate = Omit<TaskCandidate, "selected" | "reason" | "warnings" | "duplicateOf">;
export interface TaskComposerBatch { requestId: string; previewId: string; timezone: string; tasks: ConfirmedCandidate[] }
export interface TaskComposerContext { baseUrl: string; workspaceId: string; scopeKey: string }
export interface TaskComposerResult { tasks: Task[]; createdCount: number; replayed: boolean; refreshFailed?: boolean }
export class TaskComposerApiError extends Error {
  constructor(public code: string, public status?: number, public details?: { clientId?: string; duplicateOf?: string[] }) { super(code); }
}
export const DEFAULT_COMPOSER_OPTIONS: TaskComposerOptions = { maxTasks: 12, projectId: null, fromDate: null, toDate: null, focusCount: 3, recognizeRepeat: true, recognizeTime: true };
export function getTaskComposerContext(): TaskComposerContext {
  const workspaceId = getCurrentWorkspace() || "personal";
  return { baseUrl: getBaseUrl(), workspaceId, scopeKey: `nowen-task-composer:${getOfflineQueueStorageKey()}:${workspaceId}` };
}
export function isTaskComposerContextCurrent(context: TaskComposerContext): boolean {
  const current = getTaskComposerContext();
  return current.scopeKey === context.scopeKey && current.baseUrl === context.baseUrl;
}
export function confirmedCandidates(candidates: TaskCandidate[]): ConfirmedCandidate[] {
  return candidates.filter(task => task.selected).map(task => ({
    clientId: task.clientId, title: task.title, description: task.description, priority: task.priority,
    startDate: task.startDate, dueDate: task.dueDate, dueAt: task.dueAt, projectId: task.projectId,
    repeatRule: task.repeatRule, repeatInterval: task.repeatInterval, repeatEndDate: task.repeatEndDate,
    repeatEndCount: task.repeatEndCount, allowDuplicate: task.allowDuplicate,
  }));
}

// Native task lists read SQLite. Cache only confirmed server records, without a new Outbox write.
let cacheConfirmedTasks: ((tasks: Task[], projects?: TaskProject[]) => Promise<void>) | null = null;
export function registerTaskComposerCache(writer: (tasks: Task[], projects?: TaskProject[]) => Promise<void>): () => void {
  cacheConfirmedTasks = writer;
  return () => { if (cacheConfirmedTasks === writer) cacheConfirmedTasks = null; };
}
async function request<T>(context: TaskComposerContext, path: string, body: unknown, signal?: AbortSignal, method = "POST"): Promise<T> {
  if (!isTaskComposerContextCurrent(context)) throw new TaskComposerApiError("CONTEXT_CHANGED");
  if (isMobileLocalMode()) throw new TaskComposerApiError("LOCAL_MODE_UNAVAILABLE");
  if (navigator.onLine === false) throw new TaskComposerApiError("OFFLINE");
  const token = getAccessToken();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  try {
    const response = await fetchWithAuthRefresh(`${context.baseUrl}${path}?workspaceId=${encodeURIComponent(context.workspaceId)}`, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    }, context.baseUrl);
    const payload = await response.json().catch(() => null);
    if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (!isTaskComposerContextCurrent(context)) throw new TaskComposerApiError("CONTEXT_CHANGED");
    if (!response.ok) throw new TaskComposerApiError(payload?.code || "REQUEST_FAILED", response.status, payload?.details);
    if (!payload) throw new TaskComposerApiError("INVALID_RESPONSE");
    return payload as T;
  } catch (error) {
    if (timedOut) throw new TaskComposerApiError("AI_TIMEOUT");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export function previewTaskComposition(context: TaskComposerContext, input: TaskComposerOptions & { text: string; timezone: string; lang: "zh-CN" | "en" }, signal: AbortSignal) {
  return request<{ previewId: string; timezone: string; tasks: Omit<TaskCandidate, "selected" | "allowDuplicate">[]; warnings: string[] }>(context, "/ai/task-plan/preview", input, signal);
}
export async function loadTaskComposerProjects(context: TaskComposerContext, signal: AbortSignal) {
  const projects = await request<TaskProject[]>(context, "/task-projects", undefined, signal, "GET");
  if (context.workspaceId === "personal" && cacheConfirmedTasks) await cacheConfirmedTasks([], projects);
  return projects;
}
// Native recurrence completion uses the existing canonical update route to generate the next occurrence.
export async function updateRepeatingTaskOnline(id: string, patch: Partial<Task>) {
  const context = getTaskComposerContext();
  const result = await request<{ task: Task; generatedTask: Task | null }>(context, `/tasks/${encodeURIComponent(id)}`, patch, undefined, "PUT");
  if (!result.generatedTask && result.task.isCompleted && result.task.repeatNextGeneratedId) {
    result.generatedTask = await request<Task>(context, `/tasks/${encodeURIComponent(result.task.repeatNextGeneratedId)}`, undefined, undefined, "GET");
  }
  return result;
}
export async function confirmTaskComposition(context: TaskComposerContext, batch: TaskComposerBatch): Promise<TaskComposerResult> {
  const result = await request<TaskComposerResult>(context, "/tasks/ai-batch-create", batch);
  if (!Array.isArray(result.tasks) || result.tasks.some(task => typeof task.id !== "string" || typeof task.title !== "string") || result.createdCount !== batch.tasks.length) throw new TaskComposerApiError("INVALID_RESPONSE");
  if (context.workspaceId === "personal" && cacheConfirmedTasks) {
    try { await cacheConfirmedTasks(result.tasks); } catch { result.refreshFailed = true; }
  }
  if (!isTaskComposerContextCurrent(context)) throw new TaskComposerApiError("CONTEXT_CHANGED");
  window.dispatchEvent(new Event(TASK_REMINDER_SYNC_EVENT));
  window.dispatchEvent(new Event("nowen:task-composer-created"));
  return result;
}
