import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildMigrationClientConfig } from "../../../frontend/src/lib/migrationClientSetup.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pat = "nkn_migration_integration_test_1234567890";
const gatewayToken = "migration-http-gateway-integration-token-1234567890";
const source = { platform: "markdown", exportId: "export-1" };
const note = { schemaVersion: 1, source: { ...source, sourceId: "note-1" }, title: "Example", contentFormat: "markdown", content: "# Body" };
const adapter = { id: "generic-files", version: 1, platforms: ["files"], formats: ["markdown"], extensions: [".md"], autoDetect: false, unsupported: ["remote-fetch"] };
const resultText = (result: any): string => result.content?.map((entry: any) => entry.text || "").join("\n") || "";

async function backendFixture(resumable = false) {
  const writes: Array<{ path: string; raw: Buffer }> = [];
  let upload: any;
  const job = { id: "job-1", status: "CREATED", source, targetNotebookId: "root", counts: { total: 1 },
    rootNotebookId: null as string | null, previewDigest: "a".repeat(64), undo: { available: true, reason: null }, content: "MUST_NOT_RETURN_BODY" };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/json");
    const reply = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${pat}`) return reply({ error: "Unauthorized" }, 401);
    if (["POST", "PUT"].includes(req.method || "")) writes.push({ path: url.pathname, raw });
    if (url.pathname === "/api/notebooks") return reply([{ id: "root", parentId: null },
      ...(job.status === "COMPLETED" ? [{ id: "import-root", parentId: "root" }, { id: "import-child", parentId: "import-root" }] : [])]);
    if (url.pathname === "/api/notebooks/shared-with-me") return reply([]);
    if (url.pathname === "/api/migrations/capabilities") return reply({ schemaVersion: 1, resumableUploads: resumable, formats: ["markdown", "html", "zip", "nmf-v1"], humanApprovalRequired: true, limits: { uploadBytes: 10_000_000 }, adapterApiVersion: 1, adapters: [adapter], content: "MUST_NOT_RETURN_BODY" });
    if (resumable && url.pathname.endsWith("/upload-sessions")) {
      upload ||= { ...JSON.parse(raw.toString()), id: "upload-1", jobId: "job-1", offset: 0, chunkBytes: 4 * 1024 * 1024, status: "OPEN" };
      return reply(upload, 201);
    }
    if (resumable && url.pathname.endsWith("/chunks")) {
      assert.equal(Number(url.searchParams.get("offset")), upload.offset);
      assert.equal(req.headers["x-chunk-sha256"], createHash("sha256").update(raw).digest("hex"));
      upload.offset += raw.length; return reply(upload);
    }
    if (resumable && url.pathname.endsWith("/complete")) { upload.status = "COMPLETE"; return reply({ ...job, status: "UPLOADING" }, 202); }
    if (url.pathname === "/api/migrations/private") return reply({ ...job, id: "private", targetNotebookId: "private" });
    if (url.pathname.startsWith("/api/migrations")) return reply(job);
    return reply({ error: "Unexpected endpoint" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, writes, job,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function environment(url: string, mode = "read-write"): Record<string, string> {
  return { ...process.env, NOWEN_URL: url, NOWEN_API_TOKEN: pat, ALLOWED_NOTEBOOK_IDS: "root",
    MCP_INCLUDE_DESCENDANTS: "true", MCP_ACCESS_MODE: mode } as Record<string, string>;
}

test("generated stdio configuration lets a real SDK client prepare safely without approval or undo", async () => {
  const backend = await backendFixture();
  const temp = await mkdtemp(path.join(os.tmpdir(), "nowen-migration-mcp-"));
  const filename = path.join(temp, "example.md");
  await writeFile(filename, "# Streamed upload");
  const client = new Client({ name: "migration-stdio-test", version: "1" });
  try {
    const generated = JSON.parse(buildMigrationClientConfig({ client: "claude-code", transport: "stdio", apiUrl: backend.url,
      launcherPath: path.join(packageRoot, "bin/nowen-mcp.mjs"), notebookId: "root" }).content).mcpServers["nowen-note"];
    assert.equal(generated.env.NOWEN_API_TOKEN, "${NOWEN_API_TOKEN}");
    await client.connect(new StdioClientTransport({ command: generated.command, args: generated.args,
      env: { ...process.env, ...generated.env, NOWEN_API_TOKEN: pat } as Record<string, string> }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes("nowen_migration_create"));
    assert.ok(!names.includes("nowen_migration_approve"));
    const capabilities = await client.callTool({ name: "nowen_migration_capabilities", arguments: {} });
    assert.ok(!capabilities.isError, resultText(capabilities));
    assert.deepEqual(JSON.parse(resultText(capabilities)).adapters, [adapter]);
    assert.equal(JSON.parse(resultText(capabilities)).adapterApiVersion, 1);
    assert.ok(!resultText(capabilities).includes("MUST_NOT_RETURN_BODY"));
    const created = await client.callTool({ name: "nowen_migration_create", arguments: { operationId: "operation-1", source, targetNotebookId: "root" } });
    assert.ok(!created.isError, resultText(created));
    assert.ok(!resultText(created).includes("MUST_NOT_RETURN_BODY"));
    const staged = await client.callTool({ name: "nowen_migration_stage", arguments: { jobId: "job-1", items: [note] } });
    assert.ok(!staged.isError, resultText(staged));
    assert.equal(JSON.parse(backend.writes.at(-1)!.raw.toString()).items[0].source.sourceId, "note-1");
    const tooLarge = await client.callTool({ name: "nowen_migration_stage", arguments: { jobId: "job-1", items: [{ ...note, content: "x".repeat(512 * 1024) }] } });
    assert.equal(tooLarge.isError, true);
    const count = backend.writes.length;
    const invalid = await client.callTool({ name: "nowen_migration_stage", arguments: { jobId: "job-1", items: [{ ...note, admin: true }] } });
    assert.equal(invalid.isError, true);
    assert.equal(backend.writes.length, count);
    const uploaded = await client.callTool({ name: "nowen_migration_upload", arguments: { jobId: "job-1", filePath: filename } });
    assert.ok(!uploaded.isError, resultText(uploaded));
    assert.equal(backend.writes.at(-1)!.raw.toString(), (await readFile(filename, "utf8")));
    const unauthorized = await client.callTool({ name: "nowen_migration_status", arguments: { jobId: "private" } });
    assert.equal(unauthorized.isError, true);
    const beforeUndo = backend.writes.length;
    const undo = await client.callTool({ name: "nowen_migration_undo", arguments: { jobId: "job-1" } });
    assert.ok(!undo.isError, resultText(undo));
    assert.equal(JSON.parse(resultText(undo)).requiresHumanApproval, true);
    assert.equal(backend.writes.length, beforeUndo);
    backend.job.status = "COMPLETED";
    backend.job.rootNotebookId = "import-root";
    await client.callTool({ name: "nowen_migration_status", arguments: { jobId: "job-1" } });
    const catalog = await client.callTool({ name: "nowen_list_notebooks", arguments: {} });
    assert.ok(!catalog.isError, resultText(catalog));
    assert.ok(resultText(catalog).includes("import-child"), "worker-created descendants must be discoverable in the same scoped client");
  } finally { await client.close(); await backend.close(); await rm(temp, { recursive: true, force: true }); }
});

test("read-only stdio migration tools cannot stage, preview, retry or cancel", async () => {
  const backend = await backendFixture();
  const client = new Client({ name: "migration-reader", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(packageRoot, "dist/scoped-entry.js")], env: environment(backend.url, "read-only") }));
    for (const action of ["preview", "retry", "cancel", "pause", "resume"]) {
      const result = await client.callTool({ name: `nowen_migration_${action}`, arguments: { jobId: "job-1" } });
      assert.equal(result.isError, true, action);
    }
    const status = await client.callTool({ name: "nowen_migration_status", arguments: { jobId: "job-1" } });
    assert.ok(!status.isError, resultText(status));
    assert.equal(backend.writes.length, 0);
  } finally { await client.close(); await backend.close(); }
});

test("real SDK stdio migration upload uses bounded hash-verified resumable chunks", async () => {
  const backend = await backendFixture(true);
  const directory = await mkdtemp(path.join(os.tmpdir(), "nowen-mcp-chunks-"));
  const filename = path.join(directory, "source.zip"); const bytes = Buffer.alloc(4 * 1024 * 1024 + 3, 42);
  await writeFile(filename, bytes);
  const client = new Client({ name: "migration-resumable", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(packageRoot, "dist/scoped-entry.js")], env: environment(backend.url) }));
    for (let retry = 0; retry < 2; retry++) {
      const result = await client.callTool({ name: "nowen_migration_upload", arguments: { jobId: "job-1", filePath: filename } });
      assert.ok(!result.isError, resultText(result)); assert.equal(JSON.parse(resultText(result)).status, "UPLOADING");
    }
    const chunks = backend.writes.filter((write) => write.path.endsWith("/chunks"));
    assert.deepEqual(chunks.map((chunk) => chunk.raw.length), [4 * 1024 * 1024, 3]);
    assert.equal(createHash("sha256").update(Buffer.concat(chunks.map((chunk) => chunk.raw))).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    assert.ok(!backend.writes.some((write) => write.path.endsWith("/uploads")));
  } finally { await client.close(); await backend.close(); await rm(directory, { recursive: true, force: true }); }
});

test("migration MCP refuses password/JWT fallback before contacting the backend", async () => {
  const backend = await backendFixture();
  const client = new Client({ name: "migration-no-pat", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(packageRoot, "dist/scoped-entry.js")], env: { ...environment(backend.url),
        NOWEN_API_TOKEN: "", NOWEN_USERNAME: "account", NOWEN_PASSWORD: "password" } }));
    for (const name of ["nowen_migration_capabilities", "nowen_migration_status"]) {
      const result = await client.callTool({ name, arguments: { jobId: "job-1" } });
      assert.equal(result.isError, true);
      assert.match(resultText(result), /需要个人 API Token/);
    }
    assert.equal(backend.writes.length, 0);
  } finally { await client.close(); await backend.close(); }
});

async function startGateway(env: Record<string, string>): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [path.join(packageRoot, "dist/http-entry.js")], { env: {
    ...env, NOWEN_MCP_HTTP_TOKEN: gatewayToken, NOWEN_MCP_HTTP_ALLOW_WRITE: "true", NOWEN_MCP_HTTP_PORT: "0",
  }, stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let diagnostics = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Gateway startup timeout: ${diagnostics}`)); }, 10_000);
    child.stderr!.on("data", chunk => {
      diagnostics += String(chunk);
      const match = /HTTP MCP listening on (127\.0\.0\.1:\d+)\/mcp/.exec(diagnostics);
      if (match) { clearTimeout(timer); resolve(`http://${match[1]}/mcp`); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${diagnostics}`)); });
  });
  return { child, url };
}

test("real SDK protected HTTP client uses migration tools but cannot read any server local file", async () => {
  const backend = await backendFixture();
  const gateway = await startGateway(environment(backend.url));
  const client = new Client({ name: "migration-http-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { Authorization: `Bearer ${gatewayToken}` } },
    }));
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes("nowen_migration_stage"));
    assert.ok(!tools.includes("nowen_migration_approve"));
    const staged = await client.callTool({ name: "nowen_migration_stage", arguments: { jobId: "job-1", items: [note] } });
    assert.ok(!staged.isError, resultText(staged));
    const before = backend.writes.length;
    for (const [name, args] of [
      ["nowen_migration_upload", { jobId: "job-1", filePath: "/etc/passwd" }],
      ["nowen_upload_attachment", { filePath: "/etc/passwd" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(resultText(result), /HTTP MCP 不允许读取服务器本地路径/);
    }
    assert.equal(backend.writes.length, before);
  } finally { await client.close(); gateway.child.kill(); await backend.close(); }
});
