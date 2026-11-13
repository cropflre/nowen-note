export type MigrationClientId = "codex" | "claude-code" | "workbuddy" | "qoder" | "doubao-work" | "other";
export type MigrationClientTransport = "stdio" | "http";

export const MIGRATION_CLIENTS: readonly {
  id: MigrationClientId; label: string; documentationUrl: string | null;
  documentedTransports: readonly MigrationClientTransport[]; hostVerified: false;
}[] = [
  { id: "codex", label: "Codex", documentationUrl: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli", documentedTransports: ["stdio", "http"], hostVerified: false },
  { id: "claude-code", label: "Claude Code", documentationUrl: "https://code.claude.com/docs/en/mcp", documentedTransports: ["stdio", "http"], hostVerified: false },
  { id: "workbuddy", label: "WorkBuddy", documentationUrl: "https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide", documentedTransports: ["stdio"], hostVerified: false },
  { id: "qoder", label: "Qoder / QoderWork", documentationUrl: "https://docs.qoder.com/user-guide/chat/model-context-protocol", documentedTransports: ["stdio"], hostVerified: false },
  { id: "doubao-work", label: "豆包工作", documentationUrl: null, documentedTransports: [], hostVerified: false },
  { id: "other", label: "Other MCP client", documentationUrl: null, documentedTransports: [], hostVerified: false },
];

export interface MigrationClientSetupOptions {
  client: MigrationClientId;
  transport: MigrationClientTransport;
  apiUrl: string;
  endpoint?: string;
  launcherPath?: string;
  notebookId?: string;
}

export type MigrationClientSetupIssueCode =
  | "api-url-invalid" | "api-url-insecure" | "target-required" | "target-invalid"
  | "launcher-required" | "launcher-invalid" | "endpoint-required" | "endpoint-invalid"
  | "endpoint-insecure" | "client-template" | "stdio-runtime-unverified"
  | "http-gateway-unverified" | "http-no-local-files";
export interface MigrationClientSetupIssue {
  code: MigrationClientSetupIssueCode;
  severity: "error" | "warning";
}

function hasControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(value) || hasControl(value) || /\s/.test(value)) return null;
    return url;
  } catch { return null; }
}
function loopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
function documented(options: MigrationClientSetupOptions): boolean {
  return Boolean(MIGRATION_CLIENTS.find((client) => client.id === options.client)?.documentedTransports.includes(options.transport));
}

/** Local checks only. These do not authenticate or contact a client or MCP gateway. */
export function validateMigrationClientSetup(options: MigrationClientSetupOptions): MigrationClientSetupIssue[] {
  const issues: MigrationClientSetupIssue[] = [];
  const add = (code: MigrationClientSetupIssueCode, severity: MigrationClientSetupIssue["severity"]) => { issues.push({ code, severity }); };
  const api = webUrl(options.apiUrl);
  if (!api) add("api-url-invalid", "error");
  else if (api.protocol === "http:" && !loopback(api)) add("api-url-insecure", "warning");
  if (!documented(options)) add("client-template", "warning");
  if (options.transport === "stdio") {
    if (!options.notebookId?.trim()) add("target-required", "error");
    else if (!/^[A-Za-z0-9._:-]{1,128}$/.test(options.notebookId)) add("target-invalid", "error");
    if (!options.launcherPath?.trim()) add("launcher-required", "error");
    else if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(options.launcherPath) || hasControl(options.launcherPath)) add("launcher-invalid", "error");
    add("stdio-runtime-unverified", "warning");
  } else {
    const endpoint = options.endpoint ? webUrl(options.endpoint) : null;
    if (!options.endpoint?.trim()) add("endpoint-required", "error");
    else if (!endpoint) add("endpoint-invalid", "error");
    else if (endpoint.protocol === "http:" && !loopback(endpoint)) add("endpoint-insecure", "error");
    add("http-gateway-unverified", "warning");
    add("http-no-local-files", "warning");
  }
  return issues;
}

/** Produces copyable configuration without accepting, reading or saving credentials. */
export function buildMigrationClientConfig(options: MigrationClientSetupOptions): {
  format: "json" | "toml"; content: string; template: boolean;
} {
  const invalid = validateMigrationClientSetup(options).find((issue) => issue.severity === "error");
  if (invalid) throw Object.assign(new Error(invalid.code), { code: invalid.code });
  const apiUrl = webUrl(options.apiUrl)!.toString().replace(/\/$/, "").replace(/\/api$/, "");
  const env = {
    NOWEN_URL: apiUrl,
    MCP_ACCESS_MODE: "read-write",
    ALLOWED_NOTEBOOK_IDS: options.notebookId!,
    MCP_INCLUDE_DESCENDANTS: "true",
  };
  const template = !documented(options);
  if (options.client === "codex") {
    const lines = ["[mcp_servers.nowen-note]"];
    if (options.transport === "http") {
      lines.push(`url = ${JSON.stringify(options.endpoint)}`, 'bearer_token_env_var = "NOWEN_MCP_HTTP_TOKEN"');
    } else {
      lines.push('command = "node"', `args = [${JSON.stringify(options.launcherPath)}]`, 'env_vars = ["NOWEN_API_TOKEN"]', "", "[mcp_servers.nowen-note.env]");
      for (const [key, value] of Object.entries(env)) lines.push(`${key} = ${JSON.stringify(value)}`);
    }
    return { format: "toml", content: lines.join("\n"), template };
  }
  const server = options.transport === "http" ? {
    type: options.client === "claude-code" ? "http" : "streamable-http",
    url: options.endpoint,
    headers: { Authorization: options.client === "claude-code" ? "Bearer ${NOWEN_MCP_HTTP_TOKEN}" : "Bearer <replace-with-separate-http-gateway-token>" },
  } : {
    command: "node",
    args: [options.launcherPath],
    env: { ...env, NOWEN_API_TOKEN: options.client === "claude-code" ? "${NOWEN_API_TOKEN}" : "<replace-with-personal-api-token-in-private-client-config>" },
  };
  return { format: "json", content: JSON.stringify({ mcpServers: { "nowen-note": server } }, null, 2), template };
}
