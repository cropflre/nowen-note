import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";
import { createMcpHttpGateway } from "../src/http-entry.js";

const token = "http-gateway-security-test-token-long-enough-123";
const backend = "nkn_abcdefghijklmnopqrstuvwxyz12345";

test("remote HTTP gateway is disabled without separate, strong credentials", () => {
  assert.throws(() => createMcpHttpGateway({ NOWEN_API_TOKEN: backend }), /NOWEN_MCP_HTTP_TOKEN/);
  assert.throws(() => createMcpHttpGateway({
    NOWEN_API_TOKEN: backend, NOWEN_MCP_HTTP_TOKEN: backend, MCP_ACCESS_MODE: "read-only",
  }), /NOWEN_MCP_HTTP_TOKEN/);
  assert.throws(() => createMcpHttpGateway({
    NOWEN_API_TOKEN: backend, NOWEN_MCP_HTTP_TOKEN: token, MCP_ACCESS_MODE: "read-only",
    NOWEN_MCP_HTTP_HOST: "0.0.0.0",
  }), /loopback/);
  assert.throws(() => createMcpHttpGateway({
    NOWEN_API_TOKEN: backend, NOWEN_MCP_HTTP_TOKEN: token, MCP_ACCESS_MODE: "read-write",
  }), /MCP_ACCESS_MODE/);
  assert.throws(() => createMcpHttpGateway({
    NOWEN_API_TOKEN: backend, NOWEN_MCP_HTTP_TOKEN: token, NOWEN_MCP_HTTP_ALLOW_WRITE: "true",
  }), /MCP_ACCESS_MODE/, "write opt-in alone must not bypass explicit read-write mode");
});

test("remote HTTP enforces bearer, origin, hostname and request size before MCP protocol", async () => {
  const { server } = createMcpHttpGateway({
    NOWEN_API_TOKEN: backend,
    NOWEN_MCP_HTTP_TOKEN: token,
    MCP_ACCESS_MODE: "read-only",
    NOWEN_MCP_HTTP_PORT: "0",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    Accept: "application/json, text/event-stream" };
  const initialize = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "nowen-http-test", version: "1.0.0" },
    },
  });
  try {
    assert.equal((await fetch(url, { method: "POST", body: initialize })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: {
      ...auth, Authorization: "Bearer invalid",
    }, body: initialize })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { ...auth,
      Origin: "https://untrusted.example",
    }, body: initialize })).status, 403);
    // Node fetch may normalize Host; send a raw HTTP request for DNS rebinding coverage.
    const reboundStatus = await new Promise<number>((resolve, reject) => {
      const raw = request(url, { method: "POST", headers: {
        ...auth, Host: "attacker.example",
      } }, (reply) => {
        reply.resume();
        reply.on("end", () => resolve(reply.statusCode || 0));
      });
      raw.once("error", reject);
      raw.end(initialize);
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await fetch(url, { method: "POST", headers: auth,
      body: "x".repeat(1_048_577) })).status, 413);
    const valid = await fetch(url, { method: "POST", headers: auth, body: initialize });
    assert.equal(valid.status, 200, await valid.clone().text());
    const handshake = await valid.json() as any;
    assert.equal(handshake.jsonrpc, "2.0");
    assert.ok(handshake.result?.serverInfo?.name);
    const listing = await fetch(url, { method: "POST", headers: {
      ...auth, "MCP-Protocol-Version": "2025-03-26",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    assert.equal(listing.status, 200, await listing.clone().text());
    const listed = await listing.json() as any;
    assert.ok(listed.result?.tools?.some((entry: any) => entry.name === "nowen_preview_workflow_change"),
      "remote HTTP should expose P2 tools after client initialization");
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
