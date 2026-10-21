import { Hono } from "hono";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { AgentError, agentRuntime, runInput } from "../agent/runtime.js";
import { agentModelCapabilities } from "../agent/model.js";
import { getUserAISettings, isManualAIEnabled } from "../services/user-ai-settings.js";
const app = new Hono();
app.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ code: "UNAUTHORIZED" }, 401);
  // Built-in interactive sessions only. PATs (including restricted tokens) fail closed.
  if (c.req.header("X-Auth-Mode") === "api-token") return c.json({ code: "AGENT_SESSION_REQUIRED" }, 403);
  await next();
});
app.onError((error, c) => {
  if (error instanceof AgentError) return c.json({ code: error.code, error: error.code }, error.status as 400);
  const code = error instanceof z.ZodError || error instanceof SyntaxError ? "INVALID_INPUT" : "AGENT_REQUEST_FAILED";
  return c.json({ code, error: code }, 400);
});
app.get("/capabilities", c => c.json({ enabled: process.env.NOWEN_AGENT_ENABLED !== "false" && isManualAIEnabled(c.req.header("X-User-Id")!), ...agentModelCapabilities(getUserAISettings(c.req.header("X-User-Id")!)), verification: "actual_run", formats: ["markdown", "tiptap-json"], maxContextChars: 48000 }));
app.get("/runs", c => c.json(agentRuntime.latest(c.req.header("X-User-Id")!, c.req.query("noteId") || "")));
app.post("/runs", async c => c.json(agentRuntime.create(c.req.header("X-User-Id")!, runInput.parse(await c.req.json()), c.req.header("X-Session-Id")), 202));
app.get("/runs/:id", c => c.json(agentRuntime.get(c.req.param("id"), c.req.header("X-User-Id")!)));
app.get("/runs/:id/events", c => {
  const run = agentRuntime.get(c.req.param("id"), c.req.header("X-User-Id")!);
  const after = Number(c.req.header("Last-Event-ID") || c.req.query("after") || 0);
  return streamSSE(c, async stream => { for (const event of run.steps as Array<{ sequence: number }>) if (event.sequence > after) await stream.writeSSE({ id: String(event.sequence), event: "agent_event", data: JSON.stringify(event) }); });
});
app.post("/runs/:id/approve", async c => {
  const input = z.object({ token: z.string().length(64), snapshot: z.string().max(48000) }).strict().parse(await c.req.json());
  return c.json(agentRuntime.approve(c.req.param("id"), c.req.header("X-User-Id")!, input.token, input.snapshot));
});
app.post("/runs/:id/receipt", c => c.json(agentRuntime.receipt(c.req.param("id"), c.req.header("X-User-Id")!)));
for (const action of ["cancel", "reject"]) app.post(`/runs/:id/${action}`, c => c.json(agentRuntime.cancel(c.req.param("id"), c.req.header("X-User-Id")!)));
export default app;
