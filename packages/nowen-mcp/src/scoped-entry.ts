#!/usr/bin/env node

import {
  NotebookScopePolicy,
  ScopeDeniedError,
  loadScopeConfiguration,
  type NotebookLike,
} from "./scope-policy.js";
import { injectKnowledgeToolScope } from "./knowledge-scope-tool.js";

const scopeConfig = loadScopeConfiguration();
const policy = new NotebookScopePolicy(scopeConfig);
const originalFetch = globalThis.fetch.bind(globalThis);
const baseUrl = (process.env.NOWEN_URL || "http://localhost:3001").replace(/\/+$/, "");

let descendantsHydrated = false;
let descendantsHydration: Promise<void> | null = null;

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.delete("Content-Length");
  responseHeaders.delete("Content-Encoding");
  responseHeaders.delete("Transfer-Encoding");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function scopeDeniedResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: message, code: "MCP_SCOPE_DENIED" }, 403);
}

function requestAuthHeaders(request: Request): Headers {
  const headers = new Headers();
  const authorization = request.headers.get("Authorization")
    || (scopeConfig.apiToken ? `Bearer ${scopeConfig.apiToken}` : "");
  if (authorization) headers.set("Authorization", authorization);
  return headers;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.clone().json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readJsonResponse(response: Response): Promise<any> {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

function replaceJsonResponse(response: Response, body: unknown): Response {
  return jsonResponse(body, response.status, response.headers);
}

async function fetchNotebookCatalog(request: Request): Promise<NotebookLike[]> {
  const headers = requestAuthHeaders(request);
  const paths = ["/api/notebooks", "/api/notebooks/shared-with-me"];
  const notebooks: NotebookLike[] = [];

  for (const path of paths) {
    const response = await originalFetch(`${baseUrl}${path}`, { headers });
    if (!response.ok) continue;
    const body = await readJsonResponse(response);
    if (Array.isArray(body)) notebooks.push(...body);
  }
  return notebooks;
}

async function ensureDescendantsHydrated(request: Request): Promise<void> {
  if (!policy.enabled || !policy.includeDescendants || descendantsHydrated) return;
  if (!descendantsHydration) {
    descendantsHydration = (async () => {
      const notebooks = await fetchNotebookCatalog(request);
      policy.hydrateDescendants(notebooks);
      descendantsHydrated = true;
    })().finally(() => {
      descendantsHydration = null;
    });
  }
  await descendantsHydration;
}

async function resolveNoteNotebookId(noteId: string, request: Request): Promise<string> {
  const response = await originalFetch(
    `${baseUrl}/api/notes/${encodeURIComponent(noteId)}?slim=1`,
    { headers: requestAuthHeaders(request) },
  );
  if (!response.ok) {
    throw new ScopeDeniedError("笔记不存在、无权限，或无法验证其 MCP 作用域");
  }
  const note = await readJsonResponse(response);
  const notebookId = typeof note?.notebookId === "string" ? note.notebookId : "";
  if (!notebookId) throw new ScopeDeniedError("无法识别笔记所属的笔记本");
  return notebookId;
}

async function assertNoteAllowed(noteId: string, request: Request, write = false): Promise<void> {
  if (write) policy.assertWritable("修改笔记");
  const notebookId = await resolveNoteNotebookId(noteId, request);
  policy.assertNotebookAllowed(notebookId, write ? "写入" : "读取");
}

function collectFileNotebookIds(file: any): Array<string | null | undefined> {
  const references = Array.isArray(file?.references) ? file.references : [];
  return [
    file?.primaryNote?.notebookId,
    ...references.map((reference: any) => reference?.notebookId),
  ];
}

async function assertFileAllowed(fileId: string, request: Request, write = false): Promise<void> {
  if (write) policy.assertWritable("修改附件");
  const response = await originalFetch(
    `${baseUrl}/api/files/${encodeURIComponent(fileId)}`,
    { headers: requestAuthHeaders(request) },
  );
  if (!response.ok) {
    throw new ScopeDeniedError("附件不存在、无权限，或无法验证其 MCP 作用域");
  }
  const file = await readJsonResponse(response);
  policy.assertFileNotebookIds(collectFileNotebookIds(file), write);
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

async function handleNotebookRequest(request: Request, url: URL): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const method = request.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 2 || url.pathname === "/api/notebooks/shared-with-me") {
    if (method === "GET") {
      const response = await originalFetch(request);
      if (!response.ok) return response;
      const body = await readJsonResponse(response);
      return Array.isArray(body)
        ? replaceJsonResponse(response, policy.filterNotebooks(body))
        : response;
    }

    policy.assertWritable("创建笔记本");
    const body = await readJson(request);
    const parentId = typeof body.parentId === "string" ? body.parentId : null;
    if (!parentId || !policy.includeDescendants) {
      throw new ScopeDeniedError("scoped MCP 只能在允许的父笔记本下创建子笔记本，且需启用 MCP_INCLUDE_DESCENDANTS");
    }
    policy.assertNotebookAllowed(parentId, "创建子笔记本");
    const response = await originalFetch(request);
    if (response.ok) {
      const created = await readJsonResponse(response);
      if (typeof created?.id === "string") policy.registerCreatedNotebook(created.id, parentId);
    }
    return response;
  }

  const notebookId = decodeURIComponent(segments[2] || "");
  policy.assertNotebookAllowed(notebookId, isWriteMethod(method) ? "写入" : "读取");
  if (isWriteMethod(method)) policy.assertWritable("修改笔记本");

  if (isWriteMethod(method)) {
    const body = await readJson(request);
    const targetParentId = typeof body.parentId === "string" ? body.parentId : null;
    if (targetParentId) policy.assertNotebookAllowed(targetParentId, "移动到目标笔记本");
  }
  return originalFetch(request);
}

async function handleNotesRequest(request: Request, url: URL): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const method = request.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 2) {
    if (method === "GET") {
      const requestedNotebookId = url.searchParams.get("notebookId");
      if (requestedNotebookId) policy.assertNotebookAllowed(requestedNotebookId, "筛选");
      const response = await originalFetch(request);
      if (!response.ok) return response;
      const body = await readJsonResponse(response);
      return Array.isArray(body)
        ? replaceJsonResponse(response, policy.filterNotes(body))
        : response;
    }

    policy.assertWritable("创建笔记");
    const body = await readJson(request);
    const notebookId = typeof body.notebookId === "string" ? body.notebookId : "";
    policy.assertNotebookAllowed(notebookId, "创建笔记");
    return originalFetch(request);
  }

  const noteId = decodeURIComponent(segments[2] || "");
  const write = isWriteMethod(method);
  await assertNoteAllowed(noteId, request, write);

  if (write && method !== "DELETE") {
    const body = await readJson(request);
    const targetNotebookId = typeof body.notebookId === "string" ? body.notebookId : null;
    if (targetNotebookId) policy.assertNotebookAllowed(targetNotebookId, "移动笔记");
  }
  return originalFetch(request);
}

async function handleSearchRequest(request: Request): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const response = await originalFetch(request);
  if (!response.ok) return response;
  const body = await readJsonResponse(response);
  return Array.isArray(body)
    ? replaceJsonResponse(response, policy.filterNotes(body))
    : response;
}

async function handleBlocksRequest(request: Request, url: URL): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const method = request.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const action = segments[2] || "";

  if (action === "search") {
    const requestedNotebookId = url.searchParams.get("notebookId");
    if (requestedNotebookId) policy.assertNotebookAllowed(requestedNotebookId, "搜索块");
    const response = await originalFetch(request);
    if (!response.ok) return response;
    const body = await readJsonResponse(response);
    return Array.isArray(body)
      ? replaceJsonResponse(response, body.filter((item: any) => {
          try { policy.assertNotebookAllowed(item?.notebookId, "读取块"); return true; } catch { return false; }
        }))
      : response;
  }
  if (action === "resolve") {
    const response = await originalFetch(request);
    if (!response.ok) return response;
    const body = await readJsonResponse(response);
    policy.assertNotebookAllowed(body?.note?.notebookId, "解析内部链接");
    return response;
  }
  if (action === "graph") {
    const response = await originalFetch(request);
    if (!response.ok) return response;
    const body = await readJsonResponse(response);
    if (!body || !Array.isArray(body.nodes)) return response;
    const nodes = body.nodes.filter((node: any) => {
      try { policy.assertNotebookAllowed(node?.notebookId, "读取关系图"); return true; } catch { return false; }
    });
    const ids = new Set(nodes.map((node: any) => node.id));
    const edges = Array.isArray(body.edges)
      ? body.edges.filter((edge: any) => ids.has(edge.sourceNoteId) && ids.has(edge.targetNoteId))
      : [];
    return replaceJsonResponse(response, { nodes, edges });
  }

  const noteId = action === "note" ? decodeURIComponent(segments[3] || "") : decodeURIComponent(action);
  if (!noteId) throw new ScopeDeniedError("块接口缺少 noteId");
  await assertNoteAllowed(noteId, request, isWriteMethod(method));
  return originalFetch(request);
}

async function handleFilesRequest(request: Request, url: URL): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const method = request.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/files/upload") {
    throw new ScopeDeniedError("scoped MCP 禁止上传未绑定笔记的附件；请传 noteId 绑定到允许的笔记");
  }

  if (segments.length === 2) {
    if (method !== "GET") throw new ScopeDeniedError("scoped MCP 不允许此文件管理操作");
    const requestedNotebookId = url.searchParams.get("notebookId");
    if (requestedNotebookId) policy.assertNotebookAllowed(requestedNotebookId, "筛选附件");
    const response = await originalFetch(request);
    if (!response.ok) return response;
    const body = await readJsonResponse(response);
    if (!body || !Array.isArray(body.items)) return response;
    const items = policy.filterFiles(body.items);
    return replaceJsonResponse(response, { ...body, items, total: items.length });
  }

  const fileId = decodeURIComponent(segments[2] || "");
  if (method === "GET") {
    const response = await originalFetch(request);
    if (!response.ok) return response;
    const file = await readJsonResponse(response);
    policy.assertFileNotebookIds(collectFileNotebookIds(file), false);
    return response;
  }

  await assertFileAllowed(fileId, request, true);
  return originalFetch(request);
}

async function handleAttachmentRequest(request: Request, url: URL): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const method = request.method.toUpperCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 2 && method === "POST") {
    policy.assertWritable("上传附件");
    let noteId = "";
    try {
      const form = await request.clone().formData();
      const value = form.get("noteId");
      noteId = typeof value === "string" ? value : "";
    } catch {
      // Fall through to the fail-closed check below.
    }
    if (!noteId) {
      throw new ScopeDeniedError("scoped MCP 上传附件时必须提供 noteId");
    }
    await assertNoteAllowed(noteId, request, true);
    return originalFetch(request);
  }

  if (segments.length >= 3 && method === "DELETE") {
    const fileId = decodeURIComponent(segments[2] || "");
    await assertFileAllowed(fileId, request, true);
    return originalFetch(request);
  }

  if (method === "GET" || method === "HEAD") return originalFetch(request);
  throw new ScopeDeniedError("scoped MCP 不允许此附件操作");
}

async function handleTagRequest(request: Request, url: URL): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const method = request.method.toUpperCase();
  const match = url.pathname.match(/^\/api\/tags\/note\/([^/]+)\/tag\/([^/]+)$/);
  if (match) {
    await assertNoteAllowed(decodeURIComponent(match[1]), request, true);
    return originalFetch(request);
  }

  if (url.pathname === "/api/tags" && method === "GET") {
    throw new ScopeDeniedError("scoped MCP 暂不暴露全局标签列表，避免跨笔记本泄露标签名称和统计");
  }
  throw new ScopeDeniedError("scoped MCP 暂不允许全局标签管理；仅允许对作用域内笔记添加或移除标签");
}

async function scopedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let request = new Request(input, init);
  const url = new URL(request.url);

  if (url.pathname === "/api/ai/ask") {
    request = await injectKnowledgeToolScope(request);
  }

  if (scopeConfig.apiToken && url.pathname === "/api/auth/login" && request.method.toUpperCase() === "POST") {
    return jsonResponse({ token: scopeConfig.apiToken });
  }

  if (!policy.enabled || !url.pathname.startsWith("/api/")) {
    return originalFetch(request);
  }

  try {
    if (url.pathname === "/api/health" || url.pathname === "/api/me") {
      return originalFetch(request);
    }
    if (url.pathname === "/api/notebooks" || url.pathname.startsWith("/api/notebooks/")) {
      return await handleNotebookRequest(request, url);
    }
    if (url.pathname === "/api/notes" || url.pathname.startsWith("/api/notes/")) {
      return await handleNotesRequest(request, url);
    }
    if (url.pathname === "/api/search") {
      return await handleSearchRequest(request);
    }
    if (url.pathname === "/api/blocks" || url.pathname.startsWith("/api/blocks/")) {
      return await handleBlocksRequest(request, url);
    }
    if (url.pathname === "/api/files" || url.pathname.startsWith("/api/files/")) {
      return await handleFilesRequest(request, url);
    }
    if (url.pathname === "/api/attachments" || url.pathname.startsWith("/api/attachments/")) {
      return await handleAttachmentRequest(request, url);
    }
    if (url.pathname === "/api/tags" || url.pathname.startsWith("/api/tags/")) {
      return await handleTagRequest(request, url);
    }
    if (url.pathname === "/api/ai/chat") {
      return originalFetch(request);
    }
    if (url.pathname === "/api/ai/ask") {
      await ensureDescendantsHydrated(request);
      const body = await readJson(request);
      const notebookId = typeof body.notebookId === "string" ? body.notebookId : "";
      if (!notebookId) {
        throw new ScopeDeniedError("scoped MCP 调用知识库问答时必须提供 notebookId");
      }
      policy.assertNotebookAllowed(notebookId, "知识库问答");
      if (body.includeChildren === true && !policy.includeDescendants) {
        throw new ScopeDeniedError("当前 MCP 未启用 MCP_INCLUDE_DESCENDANTS，不能检索子笔记本");
      }
      return originalFetch(request);
    }

    throw new ScopeDeniedError(`scoped MCP 未授权访问端点: ${url.pathname}`);
  } catch (error) {
    if (error instanceof ScopeDeniedError) return scopeDeniedResponse(error);
    throw error;
  }
}

globalThis.fetch = scopedFetch as typeof globalThis.fetch;

if (scopeConfig.apiToken) {
  console.error("🔐 Nowen MCP 使用 NOWEN_API_TOKEN 认证");
}
if (policy.enabled) {
  console.error(`🛡️ MCP 笔记本作用域已启用: ${policy.roots.length} 个根笔记本`);
  console.error(`   模式: ${policy.accessMode}; 包含子笔记本: ${policy.includeDescendants ? "是" : "否"}`);
  if (policy.roots.length === 0) console.error("   白名单为空：所有笔记本访问将被拒绝");
}

await import("./index.js");
