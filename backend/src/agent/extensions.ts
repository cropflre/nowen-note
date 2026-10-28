import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/schema.js";
import { encryptAutomationSecret, decryptAutomationSecret } from "../automation/secretCrypto.js";
import { getPluginService } from "../plugins/pluginService.js";
import { pluginManifestActions, type PluginManifest } from "../plugins/types.js";
import { validateActionInput } from "../plugins/manifest.js";
import { AgentMcpClient, mcpEndpoint, mcpParameterHeaders, type McpTool } from "./mcpClient.js";
import { hash, p2Error } from "./templates.js";

export const connectionInput = z.object({ name: z.string().trim().min(1).max(100), url: z.string().max(1000), token: z.string().min(1).max(4096).optional(), allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)).min(1).max(30) }).strict();
interface Connection { id: string; name: string; url: string; secretJson: string | null; allowedTools: string; toolsJson: string; revision: string }
export interface ExtensionGrant { id: string; name: string; kind: "plugin" | "mcp"; destination: string; revision: string; inputSchema: Record<string, unknown> }
export function listConnections(userId: string) {
  return getDb().prepare("SELECT id,name,url,allowedTools,toolsJson,revision,secretJson IS NOT NULL AS hasCredential FROM agent_mcp_connections WHERE userId=? ORDER BY createdAt DESC").all(userId);
}
export function createConnection(userId: string, raw: unknown) {
  const input = connectionInput.parse(raw); mcpEndpoint(input.url);
  if ((getDb().prepare("SELECT count(*) AS n FROM agent_mcp_connections WHERE userId=?").get(userId) as { n: number }).n >= 20) throw p2Error("CONNECTION_LIMIT");
  const id = randomUUID();
  getDb().prepare("INSERT INTO agent_mcp_connections(id,userId,name,url,allowedTools,secretJson,revision,createdAt) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, userId, input.name, input.url, JSON.stringify(input.allowedTools), input.token ? JSON.stringify(encryptAutomationSecret(input.token)) : null, randomUUID(), new Date().toISOString());
  return { id };
}
function connection(id: string, userId: string) {
  const row = getDb().prepare("SELECT * FROM agent_mcp_connections WHERE id=? AND userId=?").get(id, userId) as Connection | undefined;
  if (!row) throw p2Error("CONNECTION_NOT_FOUND", 404); return row;
}
function credential(row: Connection) {
  if (!row.secretJson) return undefined;
  const secret = JSON.parse(row.secretJson) as { encrypted: string; iv: string; tag: string };
  return decryptAutomationSecret(secret.encrypted, secret.iv, secret.tag);
}
export async function discoverConnection(id: string, userId: string, client = new AgentMcpClient()) {
  const row = connection(id, userId), token = credential(row);
  const result = await client.request(row.url, token, "tools/list");
  if (token && JSON.stringify(result).includes(JSON.stringify(token).slice(1, -1))) throw p2Error("MCP_RESPONSE_INVALID", 502);
  const parsed = z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), description: z.string().max(2000).optional(), inputSchema: z.record(z.unknown()) }).passthrough()).max(100).parse(result.tools);
  const allowed = JSON.parse(row.allowedTools) as string[];
  const tools = parsed.filter(tool => allowed.includes(tool.name)).map(({ name, description, inputSchema }) => {
    mcpParameterHeaders(inputSchema, {}); return { name, description, inputSchema };
  });
  if (JSON.stringify(tools).length > 48000 || result.nextCursor) throw p2Error("MCP_CATALOG_LIMIT", 400);
  const revision = hash([row.url, tools]);
  getDb().prepare("UPDATE agent_mcp_connections SET toolsJson=?,revision=? WHERE id=? AND userId=? AND revision=?").run(JSON.stringify(tools), revision, id, userId, row.revision);
  return tools;
}
function pluginGrants(pluginId: string): ExtensionGrant[] {
  const row = getDb().prepare("SELECT manifestJson,checksum,trustLevel,status FROM plugin_registry WHERE id=?").get(pluginId) as { manifestJson: string; checksum: string; trustLevel: string; status: string } | undefined;
  if (!row || row.status !== "enabled" || !["official", "verified"].includes(row.trustLevel)) return [];
  const manifest = JSON.parse(row.manifestJson) as PluginManifest;
  // Agent v1 permits sandboxed transforms, not broad library/network or Node authority.
  if (manifest.runtime !== "sandbox-js" || manifest.permissions.some(p => !["plugin-storage:read", "plugin-storage:write"].includes(p))) return [];
  return pluginManifestActions(manifest).map(action => ({ id: `plugin:${pluginId}:${action.id}`, name: action.name, kind: "plugin", destination: pluginId,
    revision: hash([row.checksum, row.manifestJson, row.trustLevel]), inputSchema: { type: "object", properties: action.input || {} } }));
}
export function extensionCatalog(userId: string): ExtensionGrant[] {
  const plugins = getDb().prepare("SELECT id FROM plugin_registry WHERE status='enabled'").all() as { id: string }[];
  const rows = getDb().prepare("SELECT * FROM agent_mcp_connections WHERE userId=?").all(userId) as Connection[];
  return [...plugins.flatMap(row => pluginGrants(row.id)), ...rows.flatMap(row => (JSON.parse(row.toolsJson) as McpTool[]).map(tool => ({
    id: `mcp:${row.id}:${tool.name}`, name: tool.name, kind: "mcp" as const, destination: row.url, revision: row.revision, inputSchema: tool.inputSchema,
  })))];
}
export function grantedExtensions(userId: string, ids: string[]) {
  if (!ids.length) return [];
  const catalog = extensionCatalog(userId);
  const grants = ids.map(id => { const tool = catalog.find(t => t.id === id); if (!tool) throw p2Error("TOOL_GRANT_REVOKED", 403); return tool; });
  if (JSON.stringify(grants).length > 24000) throw p2Error("MCP_CATALOG_LIMIT", 400);
  return grants;
}
export function assertExtensionRevisions(userId: string, grants: ExtensionGrant[]) {
  if (!grants.length) return;
  const current = grantedExtensions(userId, grants.map(g => g.id));
  if (hash(current) !== hash(grants)) throw p2Error("TOOL_GRANT_REVOKED", 403);
}
export async function executeExtension(userId: string, workspaceId: string | null, grant: ExtensionGrant, input: Record<string, unknown>, client = new AgentMcpClient()) {
  assertExtensionRevisions(userId, [grant]);
  if (JSON.stringify(input).length > 16000) throw p2Error("INVALID_TOOL_ARGUMENTS", 400);
  const [, targetId, toolName] = grant.id.split(":");
  let result: unknown;
  if (grant.kind === "plugin") {
    const service = getPluginService(), plugin = service.get(targetId) as { actions: Parameters<typeof validateActionInput>[0][] };
    const action = plugin.actions.find(a => a.id === toolName);
    if (!action) throw p2Error("TOOL_GRANT_REVOKED", 403);
    validateActionInput(action, input);
    result = (await service.execute(targetId, toolName, userId, workspaceId, input)).result;
  } else {
    const row = connection(targetId, userId), token = credential(row);
    const value = await client.request(row.url, token, "tools/call", { name: toolName, arguments: input }, grant.inputSchema);
    if (value.isError || value.inputRequests) throw p2Error("EXTENSION_RESULT_UNCERTAIN");
    // An untrusted endpoint may echo authentication. Never display its credential.
    const text = JSON.stringify(value); result = JSON.parse(token ? text.split(JSON.stringify(token).slice(1, -1)).join("[REDACTED]") : text);
  }
  if (JSON.stringify(result).length > 24000) throw p2Error("EXTENSION_RESULT_UNCERTAIN");
  return result;
}
