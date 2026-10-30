#!/usr/bin/env node
/**
 * Opt-in, stateless Streamable HTTP MCP bridge. Deploy behind an authenticated
 * TLS reverse proxy, never bind this Node server directly to public interfaces.
 * Gateway bearer is separate from the Nowen Note personal API Token.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import "./scoped-fetch.js";
import { createNowenMcpServer } from "./index.js";

function validGatewayCredential(authorization: string | undefined, secret: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

async function jsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk as Uint8Array);
    bytes += part.length;
    if (bytes > maxBytes) throw new Error("MCP_REQUEST_TOO_LARGE");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createMcpHttpGateway(env: NodeJS.ProcessEnv = process.env) {
  const gatewayToken = env.NOWEN_MCP_HTTP_TOKEN?.trim() || "";
  const backendToken = env.NOWEN_API_TOKEN?.trim() || "";
  if (gatewayToken.length < 32 || backendToken.length < 12 || gatewayToken === backendToken) {
    throw new Error("HTTP MCP 需要不同的 NOWEN_MCP_HTTP_TOKEN (≥32 字符) 与 NOWEN_API_TOKEN");
  }
  if (env.MCP_ACCESS_MODE !== "read-only"
      && !(env.MCP_ACCESS_MODE === "read-write" && env.NOWEN_MCP_HTTP_ALLOW_WRITE === "true")) {
    throw new Error("HTTP MCP 默认只能只读；开启写入需设置 MCP_ACCESS_MODE=read-write 和 NOWEN_MCP_HTTP_ALLOW_WRITE=true");
  }
  const host = env.NOWEN_MCP_HTTP_HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("HTTP MCP 只能监听 loopback；公网访问请经 HTTPS 反向代理转发到 127.0.0.1");
  }
  const port = Number(env.NOWEN_MCP_HTTP_PORT || 3133);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("HTTP MCP 端口无效");
  const expectedHosts = new Set([host, "127.0.0.1", "localhost", "[::1]"]);
  const origins = new Set((env.NOWEN_MCP_HTTP_ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean));
  const server = createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 20_000 }, async (req, res) => {
    try {
      if (!req.url || (req.url !== "/mcp" && req.url !== "/health")) {
        reply(res, 404, { error: "NOT_FOUND" }); return;
      }
      // Prevent DNS rebinding. A reverse proxy must forward an allowed Host.
      const actualHost = (req.headers.host || "").replace(/:\d+$/, "");
      if (!expectedHosts.has(actualHost)) {
        reply(res, 403, { error: "INVALID_HOST" }); return;
      }
      if (req.headers.origin && !origins.has(req.headers.origin)) {
        reply(res, 403, { error: "INVALID_ORIGIN" }); return;
      }
      if (req.url === "/health") {
        reply(res, 200, { status: "ok", transport: "streamable-http", scope: "loopback" });
        return;
      }
      if (!validGatewayCredential(req.headers.authorization, gatewayToken)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        reply(res, 401, { error: "UNAUTHORIZED" }); return;
      }
      if (req.method !== "POST") {
        reply(res, 405, { error: "METHOD_NOT_ALLOWED", supportedMethods: ["POST"] }); return;
      }
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        reply(res, 415, { error: "CONTENT_TYPE_REQUIRED" }); return;
      }
      const contentLength = Number(req.headers["content-length"] || 0);
      if (contentLength > 1_048_576) {
        reply(res, 413, { error: "MCP_REQUEST_TOO_LARGE" }); return;
      }
      let body: unknown;
      try { body = await jsonBody(req); }
      catch (error) {
        const tooLarge = error instanceof Error && error.message === "MCP_REQUEST_TOO_LARGE";
        reply(res, tooLarge ? 413 : 400, { error: tooLarge ? "MCP_REQUEST_TOO_LARGE" : "INVALID_JSON" }); return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = createNowenMcpServer();
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        await mcp.close();
      }
    } catch (error) {
      console.error("[nowen-mcp-http] request failed", error instanceof Error ? error.name : "unknown");
      if (!res.headersSent) reply(res, 500, { error: "INTERNAL_ERROR" });
      else if (!res.writableEnded) res.end();
    }
  });
  server.headersTimeout = 10_000;
  return { server, host, port };
}

export async function startMcpHttpGateway(): Promise<void> {
  const { server, host, port } = createMcpHttpGateway();
  process.env.NOWEN_MCP_TRANSPORT = "streamable-http";
  server.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  console.error(`[nowen-mcp] HTTP MCP listening on ${host}:${typeof address === "object" && address ? address.port : port}/mcp`);
}

if (process.argv[1]?.endsWith("http-entry.js")) await startMcpHttpGateway();
