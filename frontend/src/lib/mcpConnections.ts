import { getBaseUrl, type EmbeddedMcpStatus } from "./api";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";
import { getOfflineQueueStorageKey } from "./offlineScope";

export type McpClient = "claude-code" | "cursor" | "codex" | "workbuddy" | "codebuddy" | "trae-cn" | "qoder" | "kimi-code" | "qwen-code";
export const MCP_CLIENT_NAMES: Record<McpClient, string> = {
  workbuddy: "WorkBuddy", codebuddy: "CodeBuddy Code", "trae-cn": "TRAE 国内版", qoder: "Qoder",
  "kimi-code": "Kimi Code", "qwen-code": "Qwen Code（千问）",
  "claude-code": "Claude Code", cursor: "Cursor", codex: "Codex",
};
export const MCP_CLIENT_GROUPS: { label: string; clients: McpClient[] }[] = [
  { label: "国内助手", clients: ["workbuddy", "codebuddy", "trae-cn", "qoder", "kimi-code", "qwen-code"] },
  { label: "其他助手", clients: ["claude-code", "cursor", "codex"] },
];
const clientLocations: Record<McpClient, string> = {
  workbuddy: "~/.workbuddy/mcp.json",
  codebuddy: "CodeBuddy Code 的用户级 MCP 配置（先沿用已有且生效的 ~/.codebuddy/.mcp.json、~/.codebuddy/mcp.json 或 ~/.codebuddy.json；均不存在时才新建 ~/.codebuddy/.mcp.json）",
  "trae-cn": "TRAE 国内版的用户级 MCP 配置",
  qoder: "~/.qoder/settings.json",
  "kimi-code": "~/.kimi-code/mcp.json",
  "qwen-code": "~/.qwen/settings.json",
  "claude-code": "Claude Code 的用户级 MCP 配置", cursor: "~/.cursor/mcp.json", codex: "~/.codex/config.toml",
};
export interface McpNotebookOption { id: string; name: string; parentId: string | null; canWrite: boolean }
export interface SavedMcpConnection { id: string; name: string; expiresAt: string | null; revokedAt: string | null }
export interface McpConnection {
  id: string; token: string; url: string; client: McpClient; writable: boolean; expiresAt: string | null;
}

export function isValidMcpExpiryDays(days?: number): boolean {
  return days === undefined || (Number.isSafeInteger(days) && days > 0
    && Number.isFinite(new Date(Date.now() + days * 86400_000).getTime()));
}

function endpoint(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !url.pathname.endsWith("/mcp")) throw new Error("连接地址有误，请联系管理员检查");
  return url.href;
}

export function buildMcpClientConfig(connection: McpConnection): string {
  const url = endpoint(connection.url);
  if (connection.client === "codex") {
    return `[mcp_servers.nowen-note]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${connection.token}`)} }`;
  }
  return JSON.stringify({ mcpServers: { "nowen-note": {
    ...(["claude-code", "codebuddy", "qoder"].includes(connection.client) ? { type: "http" } :
      connection.client === "workbuddy" ? { type: "streamableHttp" } : {}),
    ...(connection.client === "qwen-code" ? { httpUrl: url } : { url }),
    headers: { Authorization: `Bearer ${connection.token}` },
  } } }, null, 2);
}

/** For the user's explicit local-app install click; never fetch or log this URL. */
export function buildMcpInstallLink(connection: McpConnection): string | null {
  if (connection.client !== "cursor" && connection.client !== "trae-cn") return null;
  const config = JSON.stringify({ url: endpoint(connection.url), headers: { Authorization: `Bearer ${connection.token}` } });
  const encoded = btoa(Array.from(new TextEncoder().encode(config), byte => String.fromCharCode(byte)).join(""));
  const link = connection.client === "trae-cn" ? "trae-cn://trae.ai-ide/mcp-import?type=http&" : "cursor://anysphere.cursor-deeplink/mcp/install?";
  return `${link}name=nowen-note&config=${encodeURIComponent(encoded)}`;
}

export function buildCursorInstallLink(connection: McpConnection): string {
  return buildMcpInstallLink({ ...connection, client: "cursor" })!;
}

export function buildMcpAgentInstructions(connection: McpConnection): string {
  const client = MCP_CLIENT_NAMES[connection.client];
  const location = clientLocations[connection.client];
  return [
    `请帮我把 Nowen Note 连接到 ${client}，使用远程 HTTP MCP，无需安装 npm 包或本地 MCP 服务。`,
    `我已为这次连接选择笔记本并授予${connection.writable ? "查看、新建、修改和移入回收站" : "只读"}权限，服务端会强制限制访问范围，共享只读笔记仍不可修改。`,
    ...(connection.writable ? ["删除笔记前请先预览并征得我的明确确认，再按预览版本移入回收站，不得永久删除。"] : []),
    `请将下面的连接合并到 ${location}，保留现有配置和其他 MCP 服务。如需宿主确认或重载，请告诉我下一步。`,
    "如果已有同名但地址不同的连接，请先询问我，不要覆盖。",
    "配置包含专属授权，只保存到本机私有配置，不写入项目、版本库或日志，也不要在回复中复述密钥。", "",
    buildMcpClientConfig(connection), "",
    "完成后请实际连接 MCP 并调用 nowen_list_notebooks，只列出可访问的笔记本名称。若当前环境不能修改配置或加载 MCP，请明确说明，不能声称已连接。",
  ].join("\n");
}

/** Captures server/account identity for the whole flow; credentials never enter an offline queue. */
export function createMcpConnectionSession() {
  const apiBase = getBaseUrl();
  const scope = getOfflineQueueStorageKey();
  const current = () => scope === getOfflineQueueStorageKey() && apiBase === getBaseUrl();
  const check = (signal?: AbortSignal) => {
    if (!current()) throw new Error("账号或服务器已切换，请重新创建连接");
    signal?.throwIfAborted();
  };
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    check(init.signal ?? undefined);
    const token = getAccessToken();
    const response = await fetchWithAuthRefresh(`${apiBase}${path}`, {
      ...init, credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, apiBase);
    check(init.signal ?? undefined);
    const body = await response.json();
    check(init.signal ?? undefined);
    if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录" : response.status === 403 ? "当前账号没有连接权限，请联系管理员" : "暂时无法连接，请稍后重试");
    return body as T;
  }
  async function probe(connection: McpConnection, signal: AbortSignal): Promise<void> {
    const call = async (method: string, params: unknown, id: number) => {
      check(signal);
      const response = await fetch(endpoint(connection.url), {
        method: "POST", signal, redirect: "error", credentials: "omit", cache: "no-store",
        headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json",
          Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      check(signal);
      const body = await response.json();
      check(signal);
      if (!response.ok || body.error) throw new Error("连接检测失败，请检查服务地址或授权后重试");
      return body.result;
    };
    const initialized = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "nowen-quick-connect", version: "1" } }, 1);
    if (initialized?.serverInfo?.name !== "nowen-note") throw new Error("这个地址不是 Nowen Note MCP 服务");
    const listing = await call("tools/list", {}, 2);
    if (!listing?.tools?.some((tool: { name: string }) => tool.name === "nowen_list_notebooks")) throw new Error("服务尚未提供笔记工具");
    const result = await call("tools/call", { name: "nowen_list_notebooks", arguments: {} }, 3);
    if (!Array.isArray(result?.content) || result.isError) throw new Error("笔记本授权检测未通过，请检查所选范围");
  }
  return {
    current,
    list: async (signal?: AbortSignal) => {
      const result = await request<{ tokens: SavedMcpConnection[] }>("/tokens", { signal });
      return result.tokens.filter(value => value.name.startsWith("MCP · ") && !value.revokedAt
        && (!value.expiresAt || Date.parse(value.expiresAt) > Date.now()));
    },
    notebooks: (signal?: AbortSignal) => request<{ notebooks: McpNotebookOption[] }>("/tokens/notebook-options", { signal }),
    enable: (settings: Pick<EmbeddedMcpStatus, "enabled" | "allowWrite" | "publicUrl">, signal?: AbortSignal) =>
      request<EmbeddedMcpStatus>("/mcp", { method: "PUT", body: JSON.stringify(settings), signal }),
    create: async (input: { client: McpClient; notebooks: Pick<McpNotebookOption, "id" | "canWrite">[]; writable: boolean; url: string; expiresInDays?: number }, signal?: AbortSignal): Promise<McpConnection> => {
      const url = endpoint(input.url);
      if (!input.notebooks.length) throw new Error("请至少选择一个笔记本");
      if (!isValidMcpExpiryDays(input.expiresInDays)) throw new Error("有效期请填写有效的正整数天数，留空为永久");
      const notebooks = [...new Map(input.notebooks.map(book => [book.id, book])).values()];
      const created = await request<{ id: string; token: string; expiresAt: string | null }>("/tokens", {
        method: "POST", signal, body: JSON.stringify({
          name: `MCP · ${MCP_CLIENT_NAMES[input.client]}`, resourceMode: "restricted",
          ...(input.expiresInDays === undefined ? { expiresAt: null } : { expiresInDays: input.expiresInDays }),
          scopes: ["notes:read", "notebooks:read", ...(input.writable ? ["notes:write"] : [])],
          notebookResources: notebooks.map(book => ({ notebookId: book.id, permission: input.writable && book.canWrite ? "write" : "read", includeDescendants: false })),
        }),
      });
      if (!created.id || !created.token?.startsWith("nkn_")) throw new Error("未能获取连接授权，请在授权管理中检查后重试");
      return { id: created.id, token: created.token, expiresAt: created.expiresAt, url, client: input.client, writable: input.writable };
    },
    revoke: async (id: string, signal?: AbortSignal) => {
      await request(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE", signal });
    },
    probe,
  };
}
