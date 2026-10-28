import { randomUUID } from "node:crypto";
import { secureExternalFetch, type ExternalFetchRequest, type SecureExternalFetchOptions } from "../plugins/secureExternalFetch.js";
import { p2Error } from "./templates.js";

export type McpTransport = (request: ExternalFetchRequest, options: SecureExternalFetchOptions) => ReturnType<typeof secureExternalFetch>;
const VERSION = "2026-07-28";
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export function mcpEndpoint(value: string) {
  let url: URL; try { url = new URL(value); } catch { throw p2Error("MCP_URL_DENIED", 400); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443") throw p2Error("MCP_URL_DENIED", 400);
  return url;
}
// Only statically reachable primitive annotations are accepted. No schema URL is fetched.
export function mcpParameterHeaders(schema: Record<string, unknown>, input: Record<string, unknown>) {
  const headers: Record<string, string> = {}, seen = new Set<string>();
  function walk(node: unknown, value: unknown, reachable: boolean, depth: number) {
    if (!node || typeof node !== "object") return;
    if (depth > 15) throw p2Error("MCP_SCHEMA_UNSUPPORTED", 400);
    const entry = node as Record<string, unknown>;
    if (entry["x-mcp-header"] !== undefined) {
      const name = String(entry["x-mcp-header"]);
      if (!reachable || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || seen.has(name.toLowerCase()) || !["string", "integer", "boolean"].includes(String(entry.type))) throw p2Error("MCP_SCHEMA_UNSUPPORTED", 400);
      seen.add(name.toLowerCase());
      if (value !== undefined && value !== null) {
        if (entry.type === "integer" ? !Number.isSafeInteger(value) : typeof value !== entry.type) throw p2Error("INVALID_TOOL_ARGUMENTS", 400);
        const text = String(value);
        headers[`Mcp-Param-${name}`] = /^[\x20-\x7e]*$/.test(text) && text.trim() === text && !(text.startsWith("=?base64?") && text.endsWith("?=")) ? text : `=?base64?${Buffer.from(text).toString("base64")}?=`;
      }
    }
    for (const [key, child] of Object.entries(entry)) {
      if (key === "properties" && child && typeof child === "object") {
        for (const [name, property] of Object.entries(child)) walk(property, value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined, reachable, depth + 1);
      } else if (child && typeof child === "object") {
        for (const part of Array.isArray(child) ? child : [child]) walk(part, undefined, false, depth + 1);
      }
    }
  }
  walk(schema, input, true, 0); return headers;
}
export class AgentMcpClient {
  constructor(private readonly transport: McpTransport = secureExternalFetch) {}
  async request(urlValue: string, token: string | undefined, method: "tools/list" | "tools/call", params: Record<string, unknown> = {}, schema: Record<string, unknown> = {}) {
    const url = mcpEndpoint(urlValue), id = randomUUID();
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": VERSION, "Mcp-Method": method,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}), ...mcpParameterHeaders(schema, (params.arguments || {}) as Record<string, unknown>) };
    const response = await this.transport({ url: url.href, method: "POST", headers, ...(token ? { trustedHeaders: { Authorization: `Bearer ${token}` } } : {}),
      body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": VERSION, "io.modelcontextprotocol/clientInfo": { name: "Nowen Agent", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} } } } },
    { allowedHosts: [url.hostname], timeoutMs: 15_000, maxRedirects: 0, maxResponseBytes: 128_000 });
    if (!response.ok) throw p2Error("MCP_REQUEST_FAILED", 502);
    let frames: Array<Record<string, unknown>>;
    try {
      frames = response.headers["content-type"]?.includes("text/event-stream")
        ? response.body.split(/\r?\n\r?\n/).flatMap(event => { const value = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"); return value ? [JSON.parse(value)] : []; })
        : [JSON.parse(response.body)];
    } catch { throw p2Error("MCP_RESPONSE_INVALID", 502); }
    // Never answer server-initiated requests, sampling or elicitation.
    if (frames.some(frame => frame.method && frame.id !== undefined)) throw p2Error("MCP_RESPONSE_INVALID", 502);
    const result = frames.find(frame => frame.id === id);
    if (!result || result.jsonrpc !== "2.0" || result.error || !result.result) throw p2Error("MCP_RESPONSE_INVALID", 502);
    return result.result as Record<string, unknown>;
  }
}
