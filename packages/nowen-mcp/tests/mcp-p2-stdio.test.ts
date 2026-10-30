import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const text = (result: any) => result.content?.map((item: any) => item.text || "").join("\n") || "";

test("P2 stdio SDK manages personal workflow through preview-confirm and revisions", async () => {
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/scoped-entry.js");
  let workflow: any = null;
  let writes = 0;
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/$/, "");
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, value: any) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== "Bearer nkn_test_p2_token") return reply(401, { error: "bad PAT" });
    if (path === "/api/automations" && req.method === "GET") {
      return reply(200, workflow ? [workflow] : []);
    }
    if (path === "/api/automations" && req.method === "POST") {
      writes++;
      workflow = { id: "w-1", name: body.name, description: body.description, definition: body.definition,
        userId: "u-1", workspaceId: null, enabled: false, revision: "a".repeat(64) };
      return reply(201, workflow);
    }
    if (path === "/api/automations/w-1" && req.method === "GET") {
      return workflow ? reply(200, workflow) : reply(404, { error: "not found" });
    }
    if (path === "/api/automations/w-1/enable" && req.method === "POST") {
      if (body.expectedRevision !== workflow.revision) return reply(409, { code: "AUTOMATION_VERSION_CONFLICT" });
      writes++; workflow = { ...workflow, enabled: true, revision: "b".repeat(64) };
      return reply(200, workflow);
    }
    if (path === "/api/automations/w-1/runs" && req.method === "GET") {
      return reply(200, []);
    }
    return reply(404, { error: "unsupported" });
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const addr = backend.address();
  assert.ok(addr && typeof addr !== "string");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      NOWEN_URL: `http://127.0.0.1:${addr.port}`,
      NOWEN_API_TOKEN: "nkn_test_p2_token",
      MCP_ACCESS_MODE: "read-write",
      MCP_ENABLE_DANGEROUS_TOOLS: "false",
    } as Record<string, string>,
  });
  const client = new Client({ name: "p2-stdio-integration", version: "1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ["nowen_get_workflow", "nowen_list_workflow_runs",
      "nowen_preview_workflow_change", "nowen_apply_workflow_change", "nowen_mcp_diagnostics"]) {
      assert.ok(tools.tools.some((item) => item.name === name), name);
    }
    const definition = { version: 1, trigger: { type: "manual" }, steps: [{ id: "done", type: "stop" }] };
    const input = { operation: "create", name: "My private workflow", description: "Safe", definition };
    const preview = await client.callTool({ name: "nowen_preview_workflow_change", arguments: input });
    assert.ok(!preview.isError, text(preview));
    const plan = JSON.parse(text(preview));
    assert.match(plan.revision, /^[a-f0-9]{64}$/);
    const denied = await client.callTool({ name: "nowen_apply_workflow_change", arguments: {
      ...input, expectedRevision: plan.revision, confirmation: "DELETE_WORKFLOW",
    } });
    assert.equal(denied.isError, true);
    assert.equal(writes, 0);
    const created = await client.callTool({ name: "nowen_apply_workflow_change", arguments: {
      ...input, expectedRevision: plan.revision, confirmation: "APPLY_WORKFLOW_CHANGE",
    } });
    assert.ok(!created.isError, text(created));
    assert.equal(writes, 1);
    const dangerous = await client.callTool({ name: "nowen_preview_workflow_change", arguments: {
      operation: "create", name: "Unsafe",
      definition: { version: 1, trigger: { type: "webhook" }, steps: [{ id: "done", type: "stop" }] },
    } });
    assert.equal(dangerous.isError, true);
    const enable = await client.callTool({ name: "nowen_preview_workflow_change", arguments: {
      operation: "enable", workflowId: "w-1",
    } });
    assert.ok(!enable.isError, text(enable));
    const enablePlan = JSON.parse(text(enable));
    const applied = await client.callTool({ name: "nowen_apply_workflow_change", arguments: {
      operation: "enable", workflowId: "w-1", expectedRevision: enablePlan.revision,
      confirmation: "APPLY_WORKFLOW_CHANGE",
    } });
    assert.ok(!applied.isError, text(applied));
    assert.equal(writes, 2);
    const stale = await client.callTool({ name: "nowen_apply_workflow_change", arguments: {
      operation: "enable", workflowId: "w-1", expectedRevision: enablePlan.revision,
      confirmation: "APPLY_WORKFLOW_CHANGE",
    } });
    assert.equal(stale.isError, true);
    const diagnostics = await client.callTool({ name: "nowen_mcp_diagnostics", arguments: {} });
    assert.ok(!diagnostics.isError, text(diagnostics));
    assert.ok(!text(diagnostics).includes("nkn_test_p2_token"));
  } finally {
    await client.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
