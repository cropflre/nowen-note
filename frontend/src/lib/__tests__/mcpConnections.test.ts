import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiBase: "https://note.test/api", scope: "server:user-a", request: vi.fn() }));
vi.mock("../api", () => ({ getBaseUrl: () => mocks.apiBase }));
vi.mock("../offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("../authSession", () => ({ getAccessToken: () => "login-session", fetchWithAuthRefresh: mocks.request }));
import {
  buildCursorInstallLink, buildMcpAgentInstructions, buildMcpClientConfig, buildMcpInstallLink, createMcpConnectionSession,
  defaultMcpNotebookSelection, groupMcpNotebookOptions, McpConnectionError, type McpConnection, type McpNotebookOption,
} from "../mcpConnections";

const connection: McpConnection = { id: "grant-a", token: "nkn_private-a", url: "https://note.test/mcp", client: "claude-code", writable: false, expiresAt: null };
beforeEach(() => { vi.resetAllMocks(); mocks.apiBase = "https://note.test/api"; mocks.scope = "server:user-a"; });

describe("AI connection handoff", () => {
  it("creates complete Claude Code, Cursor and Codex configurations without placeholders", () => {
    const claude = JSON.parse(buildMcpClientConfig(connection)).mcpServers["nowen-note"];
    expect(claude.type).toBe("http");
    expect(claude.headers.Authorization).toBe("Bearer nkn_private-a");
    const cursor = JSON.parse(buildMcpClientConfig({ ...connection, client: "cursor" })).mcpServers["nowen-note"];
    expect(cursor.url).toBe(connection.url);
    expect(cursor.type).toBeUndefined();
    const codex = buildMcpClientConfig({ ...connection, client: "codex" });
    expect(codex).toContain("[mcp_servers.nowen-note]");
    expect(codex).toContain('http_headers = { Authorization = "Bearer nkn_private-a" }');
    for (const client of ["claude-code", "cursor", "codex"] as const) {
      const prompt = buildMcpAgentInstructions({ ...connection, client });
      expect(prompt).toContain("保留现有配置和其他 MCP");
      expect(prompt).toContain("nowen_list_notebooks");
      expect(prompt).toContain("不能声称已连接");
      expect(prompt).not.toMatch(/<replace|<your|\$\{/);
    }
  });
  it("produces an explicit Cursor install URL containing one server's correct configuration", () => {
    const link = new URL(buildCursorInstallLink({ ...connection, url: "https://note.test/中文/mcp" }));
    expect(link.protocol).toBe("cursor:");
    expect(link.searchParams.get("name")).toBe("nowen-note");
    const config = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(link.searchParams.get("config")!), character => character.charCodeAt(0))));
    expect(config.headers.Authorization).toBe("Bearer nkn_private-a");
    expect(decodeURI(config.url)).toBe("https://note.test/中文/mcp");
    expect(() => buildMcpClientConfig({ ...connection, url: "javascript:alert(1)" })).toThrow();
  });
  it.each([
    ["workbuddy", "WorkBuddy", "streamableHttp", "url", "~/.workbuddy/mcp.json"],
    ["codebuddy", "CodeBuddy Code", "http", "url", "~/.codebuddy"],
    ["trae-cn", "TRAE 国内版", undefined, "url", "用户级"],
    ["qoder", "Qoder", "http", "url", "~/.qoder/settings.json"],
    ["kimi-code", "Kimi Code", undefined, "url", "~/.kimi-code/mcp.json"],
    ["qwen-code", "Qwen Code（千问）", undefined, "httpUrl", "~/.qwen/settings.json"],
  ] as const)("provides a complete native HTTP configuration and user-level handoff for %s", (client, name, transportType, urlKey, location) => {
    const value = { ...connection, client };
    const config = JSON.parse(buildMcpClientConfig(value));
    expect(Object.keys(config.mcpServers)).toEqual(["nowen-note"]);
    const server = config.mcpServers["nowen-note"];
    expect(server[urlKey]).toBe(connection.url);
    expect(server.type).toBe(transportType);
    expect(server.headers).toEqual({ Authorization: "Bearer nkn_private-a" });
    expect(server.command).toBeUndefined();
    if (client === "qwen-code") expect(server.url).toBeUndefined();
    else expect(server.httpUrl).toBeUndefined();
    const prompt = buildMcpAgentInstructions(value);
    expect(prompt).toContain(name);
    expect(prompt).toContain(location);
    expect(prompt).toContain("保留现有配置和其他 MCP");
    expect(prompt).toContain("nowen_list_notebooks");
    expect(prompt).not.toMatch(/<replace|<your|\$\{/);
    if (client === "trae-cn") expect(prompt).not.toMatch(/~\/[.]trae[^\s，。]*/);
  });
  it("uses the TRAE CN import protocol and encodes only one authenticated server", () => {
    const value = { ...connection, client: "trae-cn" as const, url: "https://note.test/中文/mcp" };
    const link = new URL(buildMcpInstallLink(value)!);
    expect(link.protocol).toBe("trae-cn:");
    expect(link.host).toBe("trae.ai-ide");
    expect(link.pathname).toBe("/mcp-import");
    expect(link.searchParams.get("type")).toBe("http");
    expect(link.searchParams.get("name")).toBe("nowen-note");
    const config = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(link.searchParams.get("config")!), character => character.charCodeAt(0))));
    expect(config.headers).toEqual({ Authorization: "Bearer nkn_private-a" });
    expect(decodeURI(config.url)).toBe(value.url);
    expect(config.mcpServers).toBeUndefined();
    expect(config.type).toBeUndefined();
    expect(buildMcpInstallLink({ ...connection, client: "cursor" })).toBe(buildCursorInstallLink(connection));
    expect(buildMcpInstallLink({ ...connection, client: "codebuddy" })).toBeNull();
  });
  it("creates a bounded, read-only grant only for the selected notebooks and never saves credentials in browser storage", async () => {
    mocks.request.mockResolvedValue(Response.json({ id: "grant-a", token: "nkn_private-a", expiresAt: null }, { status: 201 }));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const session = createMcpConnectionSession();
    const result = await session.create({ client: "cursor", notebooks: [{ id: "book-a", canWrite: true }, { id: "book-a", canWrite: true }], writable: false, url: connection.url });
    const [url, init] = mocks.request.mock.calls[0];
    expect(url).toBe("https://note.test/api/tokens");
    const body = JSON.parse(init.body);
    expect(body.resourceMode).toBe("restricted");
    expect(body.scopes).toEqual(["notes:read", "notebooks:read"]);
    expect(body.notebookResources).toEqual([{ notebookId: "book-a", permission: "read", includeDescendants: false }]);
    expect(body.expiresInDays).toBeUndefined();
    expect(body.expiresAt).toBeNull();
    expect(result.token).toBe("nkn_private-a");
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
    await expect(session.create({ client: "cursor", notebooks: [], writable: false, url: connection.url })).rejects.toThrow("至少选择");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("grants note CRUD for selected writable notebooks while retaining read-only shared access", async () => {
    mocks.request.mockResolvedValue(Response.json({ id: "grant-a", token: "nkn_private-a", expiresAt: null }, { status: 201 }));
    const result = await createMcpConnectionSession().create({
      client: "codex", writable: true, url: connection.url,
      notebooks: [{ id: "book-a", canWrite: true }, { id: "shared-read", canWrite: false }, { id: "book-a", canWrite: true }],
    });
    const body = JSON.parse(mocks.request.mock.calls[0][1].body);
    expect(body.resourceMode).toBe("restricted");
    expect(body.scopes).toEqual(["notes:read", "notebooks:read", "notes:write"]);
    expect(body.notebookResources).toEqual([
      { notebookId: "book-a", permission: "write", includeDescendants: false },
      { notebookId: "shared-read", permission: "read", includeDescendants: false },
    ]);
    expect(result.writable).toBe(true);
    const prompt = buildMcpAgentInstructions(result);
    expect(prompt).toMatch(/新建/);
    expect(prompt).toMatch(/修改/);
    expect(prompt).toMatch(/回收站/);
  });
  it("creates a custom expiry and rejects invalid days instead of issuing a permanent credential", async () => {
    const expiresAt = "2030-01-31T00:00:00Z";
    mocks.request.mockResolvedValue(Response.json({ id: "grant-a", token: "nkn_private-a", expiresAt }, { status: 201 }));
    const session = createMcpConnectionSession();
    const input = { client: "codex" as const, notebooks: [{ id: "book-a", canWrite: true }], writable: true, url: connection.url };
    const result = await session.create({ ...input, expiresInDays: 30 });
    const body = JSON.parse(mocks.request.mock.calls[0][1].body);
    expect(body.expiresInDays).toBe(30);
    expect(body.expiresAt).toBeUndefined();
    expect(result.expiresAt).toBe(expiresAt);
    for (const expiresInDays of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      await expect(session.create({ ...input, expiresInDays })).rejects.toThrow("正整数天数");
    }
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("DCC-006: discards a one-time credential parsed after switching account or server", async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockResolvedValue({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) });
    const session = createMcpConnectionSession();
    const created = session.create({ client: "codex", notebooks: [{ id: "book-a", canWrite: true }], writable: false, url: connection.url });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    mocks.scope = "server:user-b";
    finish({ id: "grant-a", token: "nkn_private-a", expiresAt: null });
    await expect(created).rejects.toThrow("账号或服务器已切换");
    expect(session.current()).toBe(false);
    await expect(session.revoke("grant-a")).rejects.toThrow("账号或服务器已切换");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("checks the actual authorized notebook tool before reporting a connection ready", async () => {
    const http = vi.fn().mockResolvedValueOnce(Response.json({ result: { serverInfo: { name: "nowen-note" } } }))
      .mockResolvedValueOnce(Response.json({ result: { tools: [{ name: "nowen_list_notebooks" }] } }))
      .mockResolvedValueOnce(Response.json({ result: { content: [{ type: "text", text: "[]" }] } }));
    vi.stubGlobal("fetch", http);
    try {
      await createMcpConnectionSession().probe(connection, new AbortController().signal);
      expect(http.mock.calls.map(call => JSON.parse(call[1].body).method)).toEqual(["initialize", "tools/list", "tools/call"]);
      expect(JSON.parse(http.mock.calls[2][1].body).params.name).toBe("nowen_list_notebooks");
      expect(http.mock.calls[0][1].redirect).toBe("error");
      expect(http.mock.calls[0][1].credentials).toBe("omit");
    } finally { vi.unstubAllGlobals(); }
  });
  it("shows only current AI connections in the simple assistant list", async () => {
    mocks.request.mockResolvedValue(Response.json({ tokens: [
      { id: "active", name: "MCP · Codex", expiresAt: null, revokedAt: null },
      { id: "expired", name: "MCP · Cursor", expiresAt: "2000-01-01", revokedAt: null },
      { id: "revoked", name: "MCP · Claude Code", expiresAt: null, revokedAt: "2026-01-01" },
      { id: "other", name: "Personal automation", expiresAt: null, revokedAt: null },
    ] }));
    expect((await createMcpConnectionSession().list()).map(value => value.id)).toEqual(["active"]);
  });
  it("rejects a tool-level authorization failure even when HTTP is successful", async () => {
    const http = vi.fn().mockResolvedValueOnce(Response.json({ result: { serverInfo: { name: "nowen-note" } } }))
      .mockResolvedValueOnce(Response.json({ result: { tools: [{ name: "nowen_list_notebooks" }] } }))
      .mockResolvedValueOnce(Response.json({ result: { isError: true, content: [{ type: "text", text: "denied" }] } }));
    vi.stubGlobal("fetch", http);
    try { await expect(createMcpConnectionSession().probe(connection, new AbortController().signal)).rejects.toThrow("授权检测未通过"); }
    finally { vi.unstubAllGlobals(); }
  });
});

describe("team-space notebook authorization options", () => {
  const options: McpNotebookOption[] = [
    { id: "ops", name: "运营资料", parentId: null, canWrite: false, workspaceId: "ws-ops", workspaceName: "运营团队" },
    { id: "spec", name: "技术方案", parentId: "docs", canWrite: true, workspaceId: "ws-prod", workspaceName: "产品研发团队" },
    { id: "mine-child", name: "工作记录", parentId: "mine", canWrite: true, workspaceId: null },
    { id: "docs", name: "项目文档", parentId: null, canWrite: true, workspaceId: "ws-prod", workspaceName: "产品研发团队" },
    { id: "mine", name: "我的笔记", parentId: null, canWrite: true, workspaceId: null },
    { id: "shared", name: "项目文档", parentId: "hidden-parent", canWrite: false, workspaceId: null, shared: true },
    { id: "orphan", name: "子目录", parentId: "not-authorized", canWrite: true, workspaceId: "ws-prod", workspaceName: "产品研发团队" },
  ];

  it("DCC-006: groups personal, shared and team notebooks without mixing same-name notebooks", () => {
    const spaces = groupMcpNotebookOptions(options);
    expect(spaces.map(space => [space.kind, space.key, space.workspaceName])).toEqual([
      ["personal", "personal", null],
      ["shared", "shared", null],
      ["workspace", "ws-prod", "产品研发团队"],
      ["workspace", "ws-ops", "运营团队"],
    ]);
    expect(spaces[0].notebooks.map(book => [book.id, book.depth])).toEqual([["mine", 0], ["mine-child", 1]]);
    expect(spaces[1].notebooks.map(book => [book.id, book.depth])).toEqual([["shared", 0]]);
    // 子笔记本紧跟父笔记本；父笔记本不可授权时子笔记本提升为组内顶层。
    expect(spaces[2].notebooks.map(book => [book.id, book.depth])).toEqual([["docs", 0], ["spec", 1], ["orphan", 0]]);
    expect(spaces.flatMap(space => space.notebooks).filter(book => book.name === "项目文档").map(book => book.id)).toEqual(["shared", "docs"]);
  });

  it("DCC-006: preselects only the user's own personal notebooks", () => {
    expect(defaultMcpNotebookSelection(options).sort()).toEqual(["mine", "mine-child"]);
    expect(defaultMcpNotebookSelection(options.filter(book => book.workspaceId))).toEqual([]);
  });

  it("returns a translatable error code while keeping the diagnostic message", async () => {
    const error = await createMcpConnectionSession().create({ client: "codex", notebooks: [], writable: false, url: connection.url })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpConnectionError);
    expect((error as McpConnectionError).code).toBe("noNotebook");
    expect((error as Error).message).toContain("至少选择");
  });
});
