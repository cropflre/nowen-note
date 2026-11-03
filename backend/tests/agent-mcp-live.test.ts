import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { z } from "zod";

const file = process.env.NOWEN_AGENT_LIVE_MCP_FILE;
test("live MCP discovers explicitly allowlisted tools through the production secure transport", { skip: !file, timeout: 20000 }, async () => {
  const schema = z.object({ url: z.string(), token: z.string().optional(), allowedTools: z.array(z.string()).min(1).max(30) }).strict();
  let config: z.infer<typeof schema>;
  try { config = schema.parse(JSON.parse(fs.readFileSync(file!, "utf8"))); }
  catch { throw new Error("Invalid live MCP configuration file"); }
  const { AgentMcpClient } = await import("../src/agent/mcpClient.js");
  const result = await new AgentMcpClient().request(config.url, config.token, "tools/list");
  const tools = z.array(z.object({ name: z.string(), inputSchema: z.record(z.unknown()) }).passthrough()).parse(result.tools);
  for (const name of config.allowedTools) assert.ok(tools.some(tool => tool.name === name), "An explicitly allowlisted tool is absent from the catalog");
  // Discovery is the only remote operation here. Actual tool calls still require
  // parameter review and approval in the application, regardless of annotations.
});
