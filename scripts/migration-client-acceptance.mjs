#!/usr/bin/env node
/** Isolated real-client acceptance: node scripts/migration-client-acceptance.mjs [new-evidence-directory]. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildMigrationClientConfig } from "../frontend/src/lib/migrationClientSetup.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-client-"));
const sandboxProfile = path.join(work, "loopback-only.sb");
if (process.platform === "darwin") fs.writeFileSync(sandboxProfile, `(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(deny file-read* file-write* (subpath ${JSON.stringify(path.join(os.homedir(), ".claude"))}) (literal ${JSON.stringify(path.join(os.homedir(), ".claude.json"))}) (subpath ${JSON.stringify(path.join(os.homedir(), ".codex"))}))\n`);
const pat = `nkn_synthetic_${crypto.randomBytes(12).toString("hex")}`;
const backendRequests = [], providerRequests = [];
const catalog = { schemaVersion: 1, adapterApiVersion: 1, adapters: [{ id: "generic-files", version: 1, platforms: ["files"], formats: ["markdown"], extensions: [".md"], autoDetect: false, unsupported: ["remote-fetch"] }], formats: ["markdown", "nmf-v1"], humanApprovalRequired: true, remoteFetch: false, overwrite: false, limits: { notes: 10000 } };
const startServer = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
function run(command, args, env, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "darwin" ? "/usr/bin/sandbox-exec" : command,
      process.platform === "darwin" ? ["-f", sandboxProfile, command, ...args] : args,
      { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (value) => { stdout += value; if (stdout.length > 1_000_000) child.kill(); });
    child.stderr.on("data", (value) => { stderr += value; if (stderr.length > 100_000) child.kill(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function sse(res, model, content, tool) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event("message_start", { message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  event("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: "tool_fixture_capabilities", name: tool, input: {} } : { type: "text", text: "" } });
  event("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: content } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  event("message_stop", {}); res.end();
}

let backend, provider, gateway;
try {
  backend = await startServer((req, res) => {
    backendRequests.push({ method: req.method, path: new URL(req.url, "http://fixture").pathname });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${pat}`) { res.writeHead(401); return res.end('{"error":"Unauthorized"}'); }
    if (req.method !== "GET") { res.writeHead(405); return res.end('{"error":"Read-only fixture"}'); }
    if (req.url === "/api/notebooks") return res.end(JSON.stringify([{ id: "synthetic-root", parentId: null }]));
    if (req.url === "/api/notebooks/shared-with-me") return res.end("[]");
    if (req.url === "/api/migrations/capabilities") return res.end(JSON.stringify(catalog));
    res.writeHead(404); res.end('{"error":"Unexpected fixture route"}');
  });
  provider = await startServer(async (req, res) => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) { res.writeHead(413); return res.end(); } chunks.push(chunk); }
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/v1/messages/count_tokens") { res.setHeader("Content-Type", "application/json"); return res.end('{"input_tokens":10}'); }
    if (url.pathname !== "/v1/messages") { res.writeHead(404); return res.end('{"error":"Local fixture only"}'); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tools = (body.tools || []).map((tool) => tool.name);
    const tool = tools.find((name) => name.endsWith("__nowen_migration_capabilities"));
    const results = (body.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : []);
    const returnedCatalog = JSON.stringify(results).includes('adapterApiVersion');
    providerRequests.push({ path: url.pathname, listedMigrationTool: Boolean(tool), migrationToolCount: tools.filter((name) => name.includes("nowen_migration_")).length, toolResults: results.length, returnedCatalog });
    if (!tool) { res.writeHead(400); return res.end('{"error":{"type":"invalid_request_error","message":"Migration capability tool absent"}}'); }
    if (!results.length) return sse(res, body.model, "", tool);
    if (!returnedCatalog) { res.writeHead(400); return res.end('{"error":{"type":"invalid_request_error","message":"Migration capability result absent"}}'); }
    sse(res, body.model, "Synthetic migration capability check complete.");
  });
  const config = buildMigrationClientConfig({ client: "claude-code", transport: "stdio", apiUrl: backend.url, launcherPath: path.join(root, "packages/nowen-mcp/bin/nowen-mcp.mjs"), notebookId: "synthetic-root" });
  const configFile = path.join(work, "mcp.json"); fs.writeFileSync(configFile, config.content, { mode: 0o600 });
  const env = { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: work,
    CLAUDE_CONFIG_DIR: path.join(work, "claude-config"), ANTHROPIC_API_KEY: "synthetic-local-fixture-key", ANTHROPIC_BASE_URL: provider.url,
    NOWEN_API_TOKEN: pat, DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_MAX_RETRIES: "0" };
  const version = spawnSync("claude", ["--version"], { env, cwd: work, encoding: "utf8" }).stdout.trim();
  const claudeArgs = (file) => ["--bare", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", file,
    "--no-session-persistence", "--tools", "", "--allowedTools", "mcp__nowen-note__nowen_migration_capabilities", "--permission-mode", "dontAsk",
    "--system-prompt", "Use only the supplied read-only migration capability tool. Do not read files or write data.",
    "--model", "synthetic-local-fixture", "--output-format", "stream-json", "--verbose", "--print", "Call nowen_migration_capabilities once, then report completion."];
  const result = await run("claude", claudeArgs(configFile), env);
  const events = result.stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const summary = { date: "2026-10-29", platform: `${process.platform}/${process.arch}`, host: "Claude Code", version, transport: "stdio",
    exitCode: result.code, signal: result.signal, generatedConfigLoaded: providerRequests.some((entry) => entry.listedMigrationTool),
    toolCatalogCount: Math.max(0, ...providerRequests.map((entry) => entry.migrationToolCount)),
    capabilityCalled: backendRequests.some((entry) => entry.path === "/api/migrations/capabilities"),
    capabilityReturnedToHost: providerRequests.some((entry) => entry.returnedCatalog),
    providerCalls: providerRequests.length, backendRequests: [...backendRequests], resultSubtypes: events.filter((event) => event.type === "result").map((event) => event.subtype),
    realProviderCalls: 0, credentials: "Fresh synthetic API/gateway fixtures only; no inherited provider credentials", persistence: "--no-session-persistence; private temporary CLAUDE_CONFIG_DIR", network: process.platform === "darwin" ? "OS sandbox permits outbound loopback only and denies real Claude/Codex config directories" : "Local explicit provider endpoint", scope: "Installed host with local synthetic model provider and synthetic Nowen API; not real provider or desktop GUI acceptance" };
  const gatewayToken = crypto.randomBytes(24).toString("hex");
  const gatewayEnv = { PATH: env.PATH, NOWEN_URL: backend.url, NOWEN_API_TOKEN: pat, MCP_ACCESS_MODE: "read-only",
    ALLOWED_NOTEBOOK_IDS: "synthetic-root", MCP_INCLUDE_DESCENDANTS: "true", NOWEN_MCP_HTTP_TOKEN: gatewayToken, NOWEN_MCP_HTTP_PORT: "0" };
  gateway = spawn(process.execPath, [path.join(root, "packages/nowen-mcp/dist/http-entry.js")], { cwd: work, env: gatewayEnv, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ""; const timer = setTimeout(() => reject(new Error("Gateway startup timeout")), 5000);
    gateway.on("error", reject); gateway.stderr.on("data", (chunk) => { log += chunk; const match = /HTTP MCP listening on (http:\/\/)?127\.0\.0\.1:(\d+)\/mcp/.exec(log); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[2]}/mcp`); } });
    gateway.once("close", () => { clearTimeout(timer); reject(new Error("Gateway exited before acceptance")); });
  });
  assert.equal((await fetch(endpoint)).status, 401, "gateway refuses missing credentials");
  const httpConfig = buildMigrationClientConfig({ client: "claude-code", transport: "http", apiUrl: backend.url, endpoint });
  const httpFile = path.join(work, "mcp-http.json"); fs.writeFileSync(httpFile, httpConfig.content, { mode: 0o600 });
  const beforeProvider = providerRequests.length, beforeBackend = backendRequests.length;
  const httpResult = await run("claude", claudeArgs(httpFile), { ...env, CLAUDE_CONFIG_DIR: path.join(work, "claude-http-config"), NOWEN_MCP_HTTP_TOKEN: gatewayToken });
  const httpCalls = providerRequests.slice(beforeProvider), httpBackend = backendRequests.slice(beforeBackend);
  summary.http = { exitCode: httpResult.code, signal: httpResult.signal, generatedConfigLoaded: httpCalls.some((entry) => entry.listedMigrationTool),
    toolCatalogCount: Math.max(0, ...httpCalls.map((entry) => entry.migrationToolCount)), capabilityCalled: httpBackend.some((entry) => entry.path === "/api/migrations/capabilities"),
    capabilityReturnedToHost: httpCalls.some((entry) => entry.returnedCatalog), providerCalls: httpCalls.length, backendRequests: httpBackend, unauthenticatedGatewayStatus: 401 };
  assert.ok(backendRequests.every((request) => request.method === "GET"), "host acceptance must not write source or note data");
  const out = process.argv[2];
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "client-claude.json"), JSON.stringify(summary, null, 2) + "\n"); }
  console.log(JSON.stringify(summary, null, 2));
  if (result.code !== 0 || !summary.capabilityReturnedToHost || httpResult.code !== 0 || !summary.http.capabilityReturnedToHost) {
    // Runtime stderr can contain host-local information; print only a short scrubbed diagnostic.
    console.error((result.stderr + httpResult.stderr).replaceAll(pat, "<synthetic-token>").replaceAll(gatewayToken, "<synthetic-gateway-token>").slice(-3000));
    process.exitCode = 1;
  }
} finally {
  if (gateway && gateway.exitCode === null) { gateway.kill("SIGTERM"); await new Promise((resolve) => gateway.once("close", resolve)); }
  if (provider) await close(provider.server);
  if (backend) await close(backend.server);
  fs.rmSync(work, { recursive: true, force: true });
}
