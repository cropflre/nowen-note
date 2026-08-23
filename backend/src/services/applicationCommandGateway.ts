type CanonicalRouter = { request(input: string | Request, init?: RequestInit): Response | Promise<Response> };
import { captureBusinessMutation } from "../automation/eventCapture.js";
import type { PluginExecutionContext } from "../plugins/types.js";

type CommandMetadata = Pick<PluginExecutionContext, "source" | "sourceId" | "correlationId" | "causationId" | "depth">;

function workspaceQuery(workspaceId: string | null | undefined): string {
  return workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
}

async function invokeCanonicalRoute(
  router: CanonicalRouter,
  area: string,
  path: string,
  method: string,
  userId: string,
  body?: unknown,
  metadata: CommandMetadata = {},
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-User-Id": userId,
    "X-Nowen-Command-Source": metadata.source === "workflow" ? "workflow-plugin-host-api" : "plugin-host-api",
  };
  if (metadata.sourceId) headers["X-Nowen-Source-Id"] = metadata.sourceId;
  if (metadata.correlationId) headers["X-Nowen-Correlation-Id"] = metadata.correlationId;
  if (metadata.causationId) headers["X-Nowen-Causation-Id"] = metadata.causationId;
  if (metadata.depth !== undefined) headers["X-Nowen-Event-Depth"] = String(metadata.depth);
  const response = await router.request(`http://nowen.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ error: response.statusText })) as Record<string, any>;
  if (!response.ok) {
    throw Object.assign(new Error(String(payload.error || "业务命令执行失败")), {
      code: String(payload.code || (response.status === 403 ? "RESOURCE_FORBIDDEN" : "DOMAIN_COMMAND_FAILED")),
      status: response.status,
    });
  }
  captureBusinessMutation({
    area, path, method, userId, workspaceId: typeof (body as any)?.workspaceId === "string" ? (body as any).workspaceId : null,
    requestBody: body && typeof body === "object" ? body as Record<string, unknown> : {}, responseBody: payload,
    source: metadata.source === "workflow" ? "workflow" : "plugin", sourceId: metadata.sourceId,
    correlationId: metadata.correlationId, causationId: metadata.causationId, depth: metadata.depth,
  });
  return payload;
}

/**
 * 插件、MCP 等非 HTTP 入口必须复用正式 Route 业务链路，不能直接写业务表。
 * 该网关在进程内调用 canonical Hono Route，因此版本、审计、Yjs、知识树、
 * 附件引用、Webhook 与 Sync Outbox 等副作用和普通 UI 请求保持一致。
 */
export class ApplicationCommandGateway {
  async createNote(userId: string, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/notes.js")).default, "notes", "/", "POST", userId, input, metadata);
  }

  async updateNote(userId: string, noteId: string, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/notes.js")).default, "notes", `/${encodeURIComponent(noteId)}`, "PUT", userId, input, metadata);
  }

  async createNotebook(userId: string, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/notebooks.js")).default, "notebooks", "/", "POST", userId, input, metadata);
  }

  async createTag(userId: string, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/tags.js")).default, "tags", "/", "POST", userId, input, metadata);
  }

  async setNoteTag(userId: string, noteId: string, tagId: string, enabled: boolean, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/tags.js")).default, "tags", `/note/${encodeURIComponent(noteId)}/tag/${encodeURIComponent(tagId)}`, enabled ? "POST" : "DELETE", userId, undefined, metadata);
  }

  async createTask(userId: string, workspaceId: string | null, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/tasks.js")).default, "tasks", `/${workspaceQuery(workspaceId)}`, "POST", userId, { ...input, workspaceId }, metadata);
  }

  async updateTask(userId: string, taskId: string, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/tasks.js")).default, "tasks", `/${encodeURIComponent(taskId)}`, "PUT", userId, input, metadata);
  }

  async createDiary(userId: string, workspaceId: string | null, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/diary.js")).default, "diary", `/${workspaceQuery(workspaceId)}`, "POST", userId, { ...input, workspaceId }, metadata);
  }

  async createMindmap(userId: string, workspaceId: string | null, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/mindmaps.js")).default, "mindmaps", `/${workspaceQuery(workspaceId)}`, "POST", userId, { ...input, workspaceId }, metadata);
  }

  async updateMindmap(userId: string, mindmapId: string, input: Record<string, unknown>, metadata?: CommandMetadata): Promise<any> {
    return invokeCanonicalRoute((await import("../routes/mindmaps.js")).default, "mindmaps", `/${encodeURIComponent(mindmapId)}`, "PUT", userId, input, metadata);
  }
}
