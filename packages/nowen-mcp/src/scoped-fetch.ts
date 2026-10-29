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

  if (method === "GET" || method === "HEAD") {
    const fileId = decodeURIComponent(segments[2] || "");
    if (!fileId) throw new ScopeDeniedError("附件 ID 必填");
    await assertFileAllowed(fileId, request);
    return originalFetch(request);
  }
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

async function assertPersonalTaskLinks(body: Record<string, unknown>, request: Request): Promise<void> {
  if (body.workspaceId || body.noteId) throw new ScopeDeniedError("MCP 任务不得跨空间或直接关联笔记");
  if (body.parentId) {
    if (typeof body.parentId !== "string") throw new ScopeDeniedError("父任务 ID 非法");
    const result = await originalFetch(new Request(new URL("/api/tasks/" + encodeURIComponent(body.parentId), baseUrl), {
      headers: requestAuthHeaders(request),
    }));
    if (!result.ok) throw new ScopeDeniedError("父任务不存在或无权限");
    const task = await readJsonResponse(result);
    if (!task || task.workspaceId != null) throw new ScopeDeniedError("父任务必须属于个人空间");
  }
  if (body.projectId) {
    if (typeof body.projectId !== "string") throw new ScopeDeniedError("项目 ID 非法");
    const result = await originalFetch(new Request(new URL("/api/task-projects?workspaceId=personal", baseUrl), {
      headers: requestAuthHeaders(request),
    }));
    if (!result.ok) throw new ScopeDeniedError("无法验证个人项目归属");
    const projects = await readJsonResponse(result);
    if (!Array.isArray(projects) || !projects.some((item: any) => item.id === body.projectId && item.workspaceId == null)) {
      throw new ScopeDeniedError("目标项目不属于个人空间");
    }
  }
}

async function handlePersonalReminderRequest(request: Request, url: URL): Promise<Response> {
  const match = /^\/api\/task-reminders\/([^/]+)$/.exec(url.pathname);
  if (!match || !["GET", "POST"].includes(request.method.toUpperCase())
    || ["overview", "schedule", "recent", "test-now"].includes(match[1])) {
    throw new ScopeDeniedError("MCP 仅允许读取或创建个人任务提醒");
  }
  const task = await originalFetch(new Request(new URL(`/api/tasks/${match[1]}`, baseUrl), {
    headers: requestAuthHeaders(request),
  }));
  const record = task.ok ? await readJsonResponse(task) : null;
  if (!record || record.workspaceId != null) {
    throw new ScopeDeniedError("任务不存在、无权限或不属于个人空间");
  }
  return originalFetch(request);
}

async function handlePersonalTaskRequest(request: Request, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const resource = url.pathname.slice('/api/tasks'.length);
  const workspaceId = url.searchParams.get('workspaceId');
  if (workspaceId && workspaceId !== 'personal') throw new ScopeDeniedError('MCP 仅允许个人任务');
  if (resource === '' || resource === '/') {
    if (method !== 'GET' && method !== 'POST') throw new ScopeDeniedError('任务集合只支持查询与创建');
    if (method === 'POST') {
      policy.assertWritable('创建任务');
      const body = await readJson(request);
      await assertPersonalTaskLinks(body, request);
    }
    return originalFetch(request);
  }
  if (resource === '/stats/summary' && method === 'GET') return originalFetch(request);
  const archive = /^\/([A-Za-z0-9-]+)\/archive$/.exec(resource);
  if (archive && method === "PATCH") {
    policy.assertWritable("归档任务");
    const body = await readJson(request);
    if (typeof body.archived !== "boolean") throw new ScopeDeniedError("归档必须传入 archived 布尔值");
    const taskResponse = await originalFetch(new Request(new URL("/api/tasks/" + encodeURIComponent(archive[1]), baseUrl), {
      headers: requestAuthHeaders(request),
    }));
    if (!taskResponse.ok) throw new ScopeDeniedError("任务不存在或无权限");
    const task = await readJsonResponse(taskResponse);
    if (!task || task.workspaceId != null || task.parentId) {
      throw new ScopeDeniedError("MCP 只能归档个人空间顶层任务");
    }
    return originalFetch(request);
  }
  const match = /^\/([A-Za-z0-9-]+)$/.exec(resource);
  if (!match || !['GET', 'PUT'].includes(method)) throw new ScopeDeniedError('MCP 不允许任务批量或删除操作');
  if (method === 'PUT') policy.assertWritable('修改任务');
  const record = await originalFetch(new Request(new URL('/api/tasks/' + encodeURIComponent(match[1]), baseUrl), {
    headers: requestAuthHeaders(request),
  }));
  if (!record.ok) throw new ScopeDeniedError('任务不存在或无权限');
  const task = await readJsonResponse(record);
  if (!task || task.workspaceId != null) throw new ScopeDeniedError('MCP 仅允许个人任务');
  if (method === 'PUT') {
    const body = await readJson(request);
    await assertPersonalTaskLinks(body, request);
    return originalFetch(request);
  }
  return replaceJsonResponse(record, task);
}
// Personal project APIs are separate from notebook scope; never allow workspace projects.
async function handlePersonalProjectRequest(request: Request, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const workspaceId = url.searchParams.get("workspaceId");
  if (workspaceId && workspaceId !== "personal") {
    throw new ScopeDeniedError("MCP 项目工具仅允许个人空间");
  }
  if (url.pathname === "/api/task-projects") {
    if (method === "GET") return originalFetch(request);
    if (method !== "POST") throw new ScopeDeniedError("项目集合不允许该操作");
    policy.assertWritable("创建个人项目");
    const body = await readJson(request);
    if (body.userId || body.workspaceId || typeof body.name !== "string" || !body.name.trim()) {
      throw new ScopeDeniedError("个人项目必须有名称且不得指定用户或工作区");
    }
    return originalFetch(request);
  }
  const match = /^\/api\/task-projects\/([^/]+)$/.exec(url.pathname);
  if (!match || method !== "PUT") throw new ScopeDeniedError("MCP 不允许删除或批量修改项目");
  policy.assertWritable("修改个人项目");
  const body = await readJson(request);
  if (body.userId || body.workspaceId) throw new ScopeDeniedError("不允许修改项目归属");
  const response = await originalFetch(new Request(new URL("/api/task-projects?workspaceId=personal", baseUrl), {
    headers: requestAuthHeaders(request),
  }));
  if (!response.ok) throw new ScopeDeniedError("无法验证项目归属");
  const projects = await readJsonResponse(response);
  if (!Array.isArray(projects) || !projects.some((project: any) => project.id === decodeURIComponent(match[1]) && project.workspaceId == null)) {
    throw new ScopeDeniedError("项目不属于个人空间");
  }
  return originalFetch(request);
}

async function handleKnowledgeTreeRequest(request: Request, url: URL): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const method = request.method.toUpperCase();
  const pathname = url.pathname.replace(/\/$/, "");
  if (pathname === "/api/knowledge-tree" && method === "GET") {
    const response = await originalFetch(request);
    if (!response.ok) return response;
    const body = await readJsonResponse(response);
    if (!body || !Array.isArray(body.nodes)) return response;
    const nodes = policy.filterKnowledgeTree(body.nodes, url.searchParams.get("includeDeleted") === "1");
    const selectedIds = new Set(nodes.map((node: any) => node.id));
    const selectedNotes = new Set(nodes.filter((node: any) => node.resourceType === "note")
      .map((node: any) => node.resourceId));
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (node.parentId && selectedIds.has(node.parentId)) {
        counts.set(node.parentId, (counts.get(node.parentId) || 0) + 1);
      }
    }
    return replaceJsonResponse(response, {
      ...body,
      nodes: nodes.map((node: any) => ({
        ...node,
        parentId: node.parentId && selectedIds.has(node.parentId) ? node.parentId : null,
        childCount: counts.get(node.id) || 0,
      })),
      passwordAuthorizedNotes: Array.isArray(body.passwordAuthorizedNotes)
        ? body.passwordAuthorizedNotes.filter((entry: any) => selectedNotes.has(entry.noteId))
        : [],
    });
  }
  policy.assertWritable("修改知识树");
  if (url.searchParams.get("workspaceId") && url.searchParams.get("workspaceId") !== "personal") {
    throw new ScopeDeniedError("MCP 只允许修改个人知识树");
  }
  const catalogResponse = await originalFetch(
    `${baseUrl}/api/knowledge-tree/?workspaceId=personal&includeDeleted=1`,
    { headers: requestAuthHeaders(request) },
  );
  if (!catalogResponse.ok) throw new ScopeDeniedError("知识树不可读取或 Token 缺少读取权限");
  const catalog = await readJsonResponse(catalogResponse);
  if (!catalog || !Array.isArray(catalog.nodes)) throw new ScopeDeniedError("无法校验知识树节点权限");
  const allNodes: any[] = catalog.nodes;
  const permitted = policy.filterKnowledgeTree(allNodes, true);
  const byId = new Map(allNodes.map((node: any) => [node.id, node]));
  const visibleIds = new Set(permitted.map((node: any) => node.id));
  const body = await readJson(request);
  const assertNode = (id: string): any => {
    const node = byId.get(id);
    if (!node || !visibleIds.has(id) || node.workspaceId != null
      || !["note", "notebook"].includes(node.resourceType)) {
      throw new ScopeDeniedError("节点不存在、不属于个人空间或未获授权");
    }
    return node;
  };
  const assertSubtree = (id: string): void => {
    const descendants = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of allNodes) {
        if (node.parentId && descendants.has(node.parentId) && !descendants.has(node.id)) {
          descendants.add(node.id);
          changed = true;
        }
      }
    }
    if (descendants.size > 10000) throw new ScopeDeniedError("目录操作涉及节点过多");
    for (const descendantId of descendants) assertNode(descendantId);
  };
  if (pathname === "/api/knowledge-tree/nodes" && method === "POST") {
    if (body.nodeType !== "folder" && body.nodeType !== "markdown") {
      throw new ScopeDeniedError("MCP 只允许创建普通文件夹和 Markdown 笔记");
    }
    if (body.parentId === undefined || body.parentId === null) {
      throw new ScopeDeniedError("scoped MCP 只能在授权文件夹内新建节点");
    }
    if (typeof body.parentId !== "string") throw new ScopeDeniedError("parentId 必须是文件夹节点 ID");
    const parent = assertNode(body.parentId);
    if (parent.isDeleted || parent.resourceType !== "notebook") throw new ScopeDeniedError("目标文件夹不可用");
    if (body.nodeType === "folder" && !policy.includeDescendants) {
      throw new ScopeDeniedError("创建子文件夹需要启用 MCP_INCLUDE_DESCENDANTS");
    }
    const response = await originalFetch(request);
    if (response.ok && body.nodeType === "folder") {
      const created = await readJsonResponse(response);
      if (typeof created?.resourceId === "string") {
        policy.registerCreatedNotebook(created.resourceId, parent.resourceId);
      }
    }
    return response;
  }
  const match = /^\/api\/knowledge-tree\/nodes\/([^/]+)(?:\/(move|restore))?$/.exec(pathname);
  if (!match) throw new ScopeDeniedError("不允许此知识树操作");
  const nodeId = decodeURIComponent(match[1]);
  assertNode(nodeId);
  if ((method === "PUT" && match[2] === "move") || method === "DELETE" || match[2] === "restore") {
    assertSubtree(nodeId);
  }
  if (method === "PUT" && match[2] === "move" && body.parentId != null) {
    if (typeof body.parentId !== "string") throw new ScopeDeniedError("非法目标目录");
    const parent = assertNode(body.parentId);
    if (parent.isDeleted || parent.resourceType !== "notebook") throw new ScopeDeniedError("目标必须是有效文件夹");
  }
  if (method === "PUT" && match[2] === "move" && body.parentId == null) {
    throw new ScopeDeniedError("scoped MCP 禁止将节点移到根目录");
  }
  if ((method === "PATCH" && !match[2]) || (method === "PUT" && match[2] === "move")
      || (method === "DELETE" && !match[2]) || (method === "POST" && match[2] === "restore")) {
    const response = await originalFetch(request);
    if (response.ok && method === "POST" && match[2] === "restore" && policy.includeDescendants) {
      descendantsHydrated = false;
      await ensureDescendantsHydrated(request);
    }
    return response;
  }
  throw new ScopeDeniedError("不允许此知识树操作");
}

async function handleMigrationRequest(request: Request, url: URL): Promise<Response> {
  await ensureDescendantsHydrated(request);
  const pathname = url.pathname.replace(/\/$/, "");
  const method = request.method.toUpperCase();
  if (pathname === "/api/migrations/capabilities" && method === "GET") return originalFetch(request);
  if (pathname === "/api/migrations") {
    if (method === "GET") {
      const response = await originalFetch(request);
      if (!response.ok) return response;
      const body = await readJsonResponse(response);
      return replaceJsonResponse(response, { ...body,
        items: Array.isArray(body?.items)
          ? body.items.filter((job: any) => policy.isNotebookAllowed(job.targetNotebookId)) : [],
      });
    }
    if (method !== "POST") throw new ScopeDeniedError("不允许此迁移操作");
    const body = await readJson(request);
    policy.assertNotebookAllowed(typeof body.targetNotebookId === "string" ? body.targetNotebookId : null, "准备迁移");
    if (!policy.includeDescendants) throw new ScopeDeniedError("迁移创建新目录需要 MCP_INCLUDE_DESCENDANTS=true");
    return originalFetch(request);
  }
  const match = /^\/api\/migrations\/([^/]+)(?:\/(items|uploads|preview|report|retry|cancel|pause|resume|upload-sessions)(?:\/([^/]+)(?:\/(chunks|complete|decision))?)?)?$/.exec(pathname);
  const sessionRequest = match?.[2] === "upload-sessions" && ((!match[3] && method === "POST")
    || (match[3] && !match[4] && ["GET", "DELETE"].includes(method))
    || (match[4] === "chunks" && method === "PUT") || (match[4] === "complete" && method === "POST"));
  const decisionRequest = match?.[2] === "items" && match[3] && match[4] === "decision" && method === "POST";
  if (!match || !(sessionRequest || decisionRequest || (!match[3] && ((method === "GET" && (!match[2] || match[2] === "report"))
      || (method === "POST" && match[2] && match[2] !== "report"))))) {
    throw new ScopeDeniedError("MCP 不允许迁移审批或直接撤销，请在 Nowen Note 中操作");
  }
  const jobResponse = await originalFetch(`${baseUrl}/api/migrations/${match[1]}`, { headers: requestAuthHeaders(request) });
  if (!jobResponse.ok) throw new ScopeDeniedError("迁移任务不存在或未获授权");
  const job = await readJsonResponse(jobResponse);
  policy.assertNotebookAllowed(job?.targetNotebookId, "访问迁移任务");
  // Imports create descendants in the backend worker, outside this client's
  // createNotebook hook. Refresh after completion so the same scoped client
  // can discover its authorized results without restarting.
  if (job?.rootNotebookId && ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(job.status)) {
    policy.hydrateDescendants(await fetchNotebookCatalog(request));
  }
  if (!match[2] && method === "GET") return jobResponse;
  return originalFetch(request);
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

  if (!url.pathname.startsWith("/api/")) return originalFetch(request);

  try {
    // Local read-only applies even when ALLOWED_NOTEBOOK_IDS is unset.
    // Only the knowledge-base answer endpoint is treated as read-only.
    // /api/ai/chat may trigger tasks or plugins and MUST be blocked in read-only mode.
    const inferenceOnly = request.method.toUpperCase() === "POST"
      && url.pathname === "/api/ai/ask";
    const authentication = request.method.toUpperCase() === "POST"
      && url.pathname === "/api/auth/login";
    if (isWriteMethod(request.method) && !inferenceOnly && !authentication) {
      policy.assertWritable(`请求 ${request.method} ${url.pathname}`);
    }
    if (!policy.enabled) return originalFetch(request);

    if (url.pathname === "/api/health" || url.pathname === "/api/me") {
      return originalFetch(request);
    }
    if (url.pathname === "/api/migrations" || url.pathname.startsWith("/api/migrations/")) {
      return await handleMigrationRequest(request, url);
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
    if (url.pathname === "/api/tasks" || url.pathname.startsWith("/api/tasks/")) {
      return await handlePersonalTaskRequest(request, url);
    }
    if (url.pathname.startsWith("/api/task-reminders/")) {
      return await handlePersonalReminderRequest(request, url);
    }
    if (url.pathname === "/api/task-projects" || url.pathname.startsWith("/api/task-projects/")) {
      return await handlePersonalProjectRequest(request, url);
    }
    if (url.pathname === "/api/knowledge-tree" || url.pathname.startsWith("/api/knowledge-tree/")) {
      return await handleKnowledgeTreeRequest(request, url);
    }
    if (url.pathname === "/api/automations" || url.pathname.startsWith("/api/automations/")) {
      // Workflow scopes and ownership are enforced by the backend for all PATs.
      // Notebook restrictions do not confer workspace workflow access.
      return originalFetch(request);
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


