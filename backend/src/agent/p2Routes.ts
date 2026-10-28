import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { getDb } from "../db/schema.js";
import { aiCustomPromptsRepository } from "../repositories/aiCustomPromptsRepository.js";
import { getWorkflowService } from "../automation/workflowService.js";
import { validateWorkflowDefinition } from "../automation/workflowValidator.js";
import { getAgentTemplate, listAgentTemplates, saveAgentTemplate, promptForAgent, p2Error } from "./templates.js";
import { extensionCatalog, grantedExtensions, createConnection, listConnections, discoverConnection } from "./extensions.js";
import { workflowScope } from "./workflowRuntime.js";

const app = new Hono();
app.use("*", bodyLimit({ maxSize: 64000 }));
const owner = (c: { req: { header(name: string): string | undefined } }) => c.req.header("X-User-Id")!;
const workspace = (c: { req: { query(name: string): string | undefined } }) => { const id = c.req.query("workspaceId"); return !id || id === "personal" ? null : id; };
app.onError((error, c) => {
  const known = error as { code?: string; status?: number };
  const code = error instanceof z.ZodError || error instanceof SyntaxError ? "INVALID_INPUT" : known.code || "AGENT_REQUEST_FAILED";
  return c.json({ code, error: code }, (known.status || 400) as 400);
});
app.get("/templates", c => c.json(listAgentTemplates(owner(c), workspace(c))));
app.get("/prompts", c => c.json(aiCustomPromptsRepository.listByUser(owner(c)).map(({ id, name }) => ({ id, name }))));
app.get("/prompts/:id", c => c.json(promptForAgent(c.req.param("id"), owner(c))));
app.get("/tools", c => c.json(extensionCatalog(owner(c))));
app.post("/templates", async c => {
  const raw = await c.req.json();
  grantedExtensions(owner(c), raw.toolIds || []);
  const result = saveAgentTemplate(owner(c), workspace(c), raw);
  try { workflowScope(owner(c), result.config.input.notebookId, workspace(c)); }
  catch (error) { getDb().prepare("DELETE FROM agent_templates WHERE id=?").run(result.id); throw error; }
  return c.json(result, 201);
});
app.put("/templates/:id", async c => {
  getAgentTemplate(c.req.param("id"), owner(c), workspace(c));
  const body = z.object({ revision: z.string(), config: z.unknown() }).strict().parse(await c.req.json());
  const config = body.config as { toolIds?: string[]; input?: { notebookId?: string } };
  grantedExtensions(owner(c), config?.toolIds || []);
  if (config?.input?.notebookId) workflowScope(owner(c), config.input.notebookId, workspace(c));
  return c.json(saveAgentTemplate(owner(c), workspace(c), body.config, c.req.param("id"), body.revision));
});
app.delete("/templates/:id", c => {
  getAgentTemplate(c.req.param("id"), owner(c), workspace(c));
  getDb().prepare("DELETE FROM agent_templates WHERE id=? AND userId=?").run(c.req.param("id"), owner(c));
  return c.json({ deleted: true });
});
app.get("/connections", c => c.json(listConnections(owner(c))));
app.post("/connections", async c => c.json(createConnection(owner(c), await c.req.json()), 201));
app.post("/connections/:id/discover", async c => c.json(await discoverConnection(c.req.param("id"), owner(c))));
app.delete("/connections/:id", c => {
  getDb().prepare("DELETE FROM agent_mcp_connections WHERE id=? AND userId=?").run(c.req.param("id"), owner(c));
  return c.json({ deleted: true });
});
app.get("/automations", c => {
  const rows = getDb().prepare("SELECT id,name,enabled,triggerType,definitionJson FROM automation_workflows WHERE userId=? AND workspaceId IS ? ORDER BY updatedAt DESC LIMIT 100").all(owner(c), workspace(c)) as Array<{ definitionJson: string }>;
  return c.json(rows.filter(row => JSON.parse(row.definitionJson).steps.some((s: { type: string }) => s.type === "agent")).map(row => ({ ...row, definition: JSON.parse(row.definitionJson), definitionJson: undefined })));
});
app.post("/templates/:id/automations", async c => {
  const body = z.object({ revision: z.string(), trigger: z.unknown() }).strict().parse(await c.req.json());
  const template = getAgentTemplate(c.req.param("id"), owner(c), workspace(c));
  if (template.revision !== body.revision) throw p2Error("TEMPLATE_CHANGED");
  const definition = validateWorkflowDefinition({ version: 1, trigger: body.trigger, steps: [{ id: "agent", type: "agent", templateId: template.id, templateRevision: template.revision }] });
  if (definition.trigger.type === "webhook" && !definition.trigger.requireSignature) throw p2Error("WEBHOOK_SIGNATURE_REQUIRED", 400);
  return c.json(getWorkflowService().create(owner(c), { name: template.name, workspaceId: workspace(c), definition, ignoreBulk: true, ignoreSync: true }), 201);
});
app.post("/automations/:id/enabled", async c => {
  const body = z.object({ enabled: z.boolean() }).strict().parse(await c.req.json());
  const row = getDb().prepare("SELECT id FROM automation_workflows WHERE id=? AND userId=? AND workspaceId IS ?").get(c.req.param("id"), owner(c), workspace(c));
  if (!row) throw p2Error("TEMPLATE_NOT_FOUND", 404);
  return c.json(getWorkflowService().enable(c.req.param("id"), owner(c), body.enabled));
});
export default app;
