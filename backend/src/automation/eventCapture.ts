import crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { eventPublisher } from "./eventPublisher.js";
import type { AutomationSource } from "./types.js";

interface MutationCapture {
  area: string;
  path: string;
  method: string;
  userId: string;
  workspaceId?: string | null;
  requestBody?: Record<string, unknown>;
  responseBody?: Record<string, unknown>;
  source?: AutomationSource;
  sourceId?: string;
  correlationId?: string;
  causationId?: string;
  depth?: number;
  batchId?: string;
  requestId?: string;
}

function resourceId(input: MutationCapture): string {
  const body = input.responseBody || {};
  for (const candidate of [body.id, (body.note as any)?.id, (body.task as any)?.id, (body.data as any)?.id]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const pathId = input.path.split("/").filter(Boolean)[0];
  return pathId || "unknown";
}

function eventType(input: MutationCapture): string | null {
  const method = input.method.toUpperCase();
  const body = input.requestBody || {};
  const area = input.area.replace(/^api\//, "");
  if (area === "notes") {
    if (method === "POST") return "note.created";
    if (method === "DELETE") return "note.deleted";
    if (method === "PUT" || method === "PATCH") return body.isTrashed === 1 || body.isTrashed === true ? "note.trashed" : body.isTrashed === 0 || body.isTrashed === false ? "note.restored" : "note.updated";
  }
  if (area === "notebooks") return method === "POST" ? "notebook.created" : method === "DELETE" ? "notebook.deleted" : method === "PUT" || method === "PATCH" ? "notebook.updated" : null;
  if (area === "tasks") {
    if (method === "POST") return "task.created";
    if (method === "DELETE") return "task.deleted";
    if (method === "PUT" || method === "PATCH") return body.completed === true || body.completed === 1 ? "task.completed" : body.completed === false || body.completed === 0 ? "task.reopened" : "task.updated";
  }
  if (area === "attachments") return method === "POST" ? "attachment.created" : method === "DELETE" ? "attachment.deleted" : null;
  if (area === "diary") return method === "POST" ? "diary.created" : method === "PUT" || method === "PATCH" ? "diary.updated" : null;
  if (area === "mindmaps") return method === "POST" ? "mindmap.created" : method === "PUT" || method === "PATCH" ? "mindmap.updated" : null;
  if (area === "tags") {
    if (method === "POST" && /\/note\/.+\/tag\//.test(input.path)) return "tag.added_to_note";
    if (method === "DELETE" && /\/note\/.+\/tag\//.test(input.path)) return "tag.removed_from_note";
    if (method === "POST") return "tag.created";
  }
  return null;
}

function minimalData(input: MutationCapture): Record<string, unknown> {
  const request = input.requestBody || {};
  const data: Record<string, unknown> = {};
  if (typeof request.title === "string") data.title = request.title.slice(0, 500);
  if (typeof request.name === "string") data.name = request.name.slice(0, 500);
  data.changedFields = Object.keys(request).filter((key) => !["content", "data", "password", "secret", "token"].includes(key)).slice(0, 50);
  if (input.batchId) data.bulkImport = true;
  return data;
}

export function captureBusinessMutation(input: MutationCapture): void {
  const type = eventType(input);
  if (!type) return;
  const id = input.requestId ? crypto.createHash("sha256").update(`${input.requestId}:${type}:${resourceId(input)}`).digest("hex") : undefined;
  eventPublisher.publish({
    id, type, userId: input.userId, workspaceId: input.workspaceId || null,
    resourceType: type.split(".")[0], resourceId: resourceId(input), source: input.source || "user", sourceId: input.sourceId,
    correlationId: input.correlationId, causationId: input.causationId, depth: input.depth, batchId: input.batchId, data: minimalData(input),
  });
}

export const automationEventCaptureMiddleware: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return next();
  const pathname = new URL(c.req.url).pathname;
  const match = pathname.match(/^\/api\/(notes|notebooks|tags|tasks|attachments|diary|mindmaps)(\/.*)?$/);
  if (!match) return next();
  let body: Record<string, unknown> = {};
  if (method !== "DELETE") body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
  await next();
  if (c.res.status < 200 || c.res.status >= 300) return;
  const response = await c.res.clone().json().catch(() => ({})) as Record<string, unknown>;
  const commandSource = c.req.header("X-Nowen-Command-Source") || "user";
  captureBusinessMutation({
    area: match[1], path: match[2] || "/", method, userId: c.req.header("X-User-Id") || "system",
    workspaceId: String(body.workspaceId || c.req.query("workspaceId") || "") || null, requestBody: body, responseBody: response,
    source: commandSource === "sync" ? "sync" : commandSource.includes("workflow") ? "workflow" : commandSource.includes("plugin") ? "plugin" : "user",
    sourceId: c.req.header("X-Nowen-Source-Id") || undefined, correlationId: c.req.header("X-Nowen-Correlation-Id") || undefined,
    causationId: c.req.header("X-Nowen-Causation-Id") || undefined, depth: Number(c.req.header("X-Nowen-Event-Depth") || 0),
    batchId: c.req.header("X-Nowen-Batch-Id") || undefined, requestId: c.req.header("X-Request-Id") || undefined,
  });
};
