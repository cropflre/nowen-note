import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface KnowledgeToolScope {
  notebookId?: string;
  includeChildren?: boolean;
}

const storage = new AsyncLocalStorage<KnowledgeToolScope>();
const prototype = McpServer.prototype as any;
const originalTool = prototype.tool as (...args: any[]) => any;
const PATCH_MARKER = Symbol.for("nowen.mcp.knowledge-scope-tool");

if (!prototype[PATCH_MARKER]) {
  prototype[PATCH_MARKER] = true;
  prototype.tool = function patchedTool(name: string, ...args: any[]) {
    if (name !== "nowen_ai_ask" || args.length < 3) {
      return originalTool.call(this, name, ...args);
    }

    const [description, schema, handler, ...rest] = args;
    const enhancedSchema = {
      ...schema,
      notebookId: z.string().optional().describe("限定知识库问答的笔记本 ID；restricted Token 必填"),
      includeChildren: z.boolean().optional().describe("是否同时检索授权范围内的子笔记本"),
    };
    const wrappedHandler = async (params: Record<string, unknown>, ...handlerArgs: unknown[]) => {
      const scope: KnowledgeToolScope = {
        notebookId: typeof params?.notebookId === "string" ? params.notebookId : undefined,
        includeChildren: params?.includeChildren === true,
      };
      return storage.run(scope, () => handler(params, ...handlerArgs));
    };
    return originalTool.call(this, name, description, enhancedSchema, wrappedHandler, ...rest);
  };
}

export function getActiveKnowledgeToolScope(): KnowledgeToolScope | undefined {
  return storage.getStore();
}

export async function injectKnowledgeToolScope(request: Request): Promise<Request> {
  const scope = storage.getStore();
  if (!scope?.notebookId) return request;

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.clone().json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return request;
  }

  if (typeof body.notebookId !== "string" || !body.notebookId) {
    body.notebookId = scope.notebookId;
  }
  if (body.includeChildren === undefined) {
    body.includeChildren = scope.includeChildren === true;
  }

  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Request(request, {
    headers,
    body: JSON.stringify(body),
  });
}
