import assert from "node:assert/strict";
import test from "node:test";
import { AgentMcpClient, mcpEndpoint, mcpParameterHeaders, type McpTransport } from "../src/agent/mcpClient.js";

test("MCP stateless transport binds protocol metadata, exact host, auth and call name", async () => {
  const transport: McpTransport = async (request, options) => {
    const body = request.body as { id: string; method: string; params: Record<string, any> };
    assert.equal(request.method, "POST"); assert.deepEqual(options.allowedHosts, ["mcp.example.com"]);
    assert.equal(options.maxRedirects, 0); assert.equal(options.timeoutMs, 15000); assert.equal(options.maxResponseBytes, 128000);
    assert.equal(request.trustedHeaders?.Authorization, "Bearer fixture-token");
    assert.equal(request.headers?.["Mcp-Method"], "tools/call"); assert.equal(request.headers?.["Mcp-Name"], "search");
    assert.equal(body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    return { ok: true, status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "found" }] } }) };
  };
  const result = await new AgentMcpClient(transport).request("https://mcp.example.com/mcp", "fixture-token", "tools/call", { name: "search", arguments: { q: "query" } });
  assert.ok(result.content);
});

test("MCP parses split SSE data fields; mismatched IDs and server requests fail closed", async () => {
  let invalid = false;
  const client = new AgentMcpClient(async request => {
    const id = (request.body as { id: string }).id;
    const value = invalid ? { jsonrpc: "2.0", id, method: "sampling/createMessage", params: {} } : { jsonrpc: "2.0", id, result: { tools: [] } };
    return { ok: true, status: 200, headers: { "content-type": "text/event-stream" }, body: `event: message\r\ndata: ${JSON.stringify(value)}\r\n\r\n` };
  });
  assert.deepEqual(await client.request("https://mcp.example.com/mcp", undefined, "tools/list"), { tools: [] });
  invalid = true;
  await assert.rejects(client.request("https://mcp.example.com/mcp", undefined, "tools/list"), /MCP_RESPONSE_INVALID/);
});

test("MCP rejects URL credentials and its real pinned transport refuses local and private targets", async () => {
  for (const url of ["http://example.com/mcp", "https://key@example.com/mcp", "https://example.com/mcp?token=key", "https://example.com:444/mcp"]) assert.throws(() => mcpEndpoint(url), /MCP_URL_DENIED/);
  for (const host of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "[::1]"]) {
    await assert.rejects(new AgentMcpClient().request(`https://${host}/mcp`, undefined, "tools/list"), error => String((error as { code: string }).code).startsWith("EXTERNAL_FETCH_"));
  }
});

test("MCP header annotations reject injection, duplicate and non-static declarations", () => {
  const schema = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } };
  assert.equal(mcpParameterHeaders(schema, { region: "east" })["Mcp-Param-Region"], "east");
  assert.ok(mcpParameterHeaders(schema, { region: "a\r\nInjected: yes" })["Mcp-Param-Region"].startsWith("=?base64?"));
  assert.throws(() => mcpParameterHeaders({ properties: { bad: { type: "string", "x-mcp-header": "A\r\nB" } } }, {}), /MCP_SCHEMA_UNSUPPORTED/);
  assert.throws(() => mcpParameterHeaders({ items: { type: "string", "x-mcp-header": "Region" } }, {}), /MCP_SCHEMA_UNSUPPORTED/);
  assert.throws(() => mcpParameterHeaders({ properties: { a: { type: "string", "x-mcp-header": "A" }, b: { type: "boolean", "x-mcp-header": "a" } } }, {}), /MCP_SCHEMA_UNSUPPORTED/);
});
