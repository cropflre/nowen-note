import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotebookPermission, getUserWorkspaceRole } from "../middleware/acl.js";
import { aiCustomPromptsRepository } from "../repositories/aiCustomPromptsRepository.js";
import { workflowInput } from "./workflowTools.js";

export const p2Error = (code: string, status = 409) => Object.assign(new Error(code), { code, status });
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const templateInput = z.object({
  name: z.string().trim().min(1).max(120),
  input: workflowInput.omit({ templateId: true, templateRevision: true }),
  allowNote: z.boolean().default(false), allowTasks: z.boolean().default(false),
  toolIds: z.array(z.string().min(1).max(256)).max(12).default([]),
}).strict();
export type TemplateConfig = z.infer<typeof templateInput>;
export interface AgentTemplate { id: string; userId: string; workspaceId: string | null; name: string; revision: string; config: TemplateConfig }
interface RecordRow { id: string; userId: string; workspaceId: string | null; name: string; revision: string; configJson: string }

function scope(userId: string, workspaceId: string | null, config: TemplateConfig) {
  const book = getDb().prepare("SELECT workspaceId FROM notebooks WHERE id=? AND isDeleted=0").get(config.input.notebookId) as { workspaceId: string | null } | undefined;
  if (!book || book.workspaceId !== workspaceId || workspaceId && !getUserWorkspaceRole(workspaceId, userId)
    || !hasPermission(resolveNotebookPermission(config.input.notebookId, userId).permission, config.allowNote ? "write" : "read")) throw p2Error("NOTE_ACCESS_DENIED", 403);
}
export function getAgentTemplate(id: string, userId: string, workspaceId: string | null): AgentTemplate {
  const row = getDb().prepare("SELECT * FROM agent_templates WHERE id=? AND userId=? AND workspaceId IS ?").get(id, userId, workspaceId) as RecordRow | undefined;
  if (!row) throw p2Error("TEMPLATE_NOT_FOUND", 404);
  const config = templateInput.parse(JSON.parse(row.configJson)); scope(userId, workspaceId, config);
  return { id: row.id, userId, workspaceId, name: row.name, revision: row.revision, config };
}
export function listAgentTemplates(userId: string, workspaceId: string | null) {
  const rows = getDb().prepare("SELECT id FROM agent_templates WHERE userId=? AND workspaceId IS ? ORDER BY updatedAt DESC LIMIT 50").all(userId, workspaceId) as { id: string }[];
  return rows.flatMap(row => { try { return [getAgentTemplate(row.id, userId, workspaceId)]; } catch { return []; } });
}
export function saveAgentTemplate(userId: string, workspaceId: string | null, raw: unknown, id?: string, expectedRevision?: string) {
  if (id && getAgentTemplate(id, userId, workspaceId).revision !== expectedRevision) throw p2Error("TEMPLATE_CHANGED");
  const config = templateInput.parse(raw); scope(userId, workspaceId, config);
  if (!id && (getDb().prepare("SELECT COUNT(*) AS n FROM agent_templates WHERE userId=?").get(userId) as { n: number }).n >= 50) throw p2Error("TEMPLATE_LIMIT");
  const key = id || randomUUID(), now = new Date().toISOString(), revision = randomUUID();
  getDb().prepare(`INSERT INTO agent_templates(id,userId,workspaceId,name,configJson,revision,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,configJson=excluded.configJson,revision=excluded.revision,updatedAt=excluded.updatedAt`)
    .run(key, userId, workspaceId, config.name, JSON.stringify(config), revision, now, now);
  return getAgentTemplate(key, userId, workspaceId);
}
export function promptForAgent(id: string, userId: string) {
  const prompt = aiCustomPromptsRepository.getByIdAndUser(id, userId);
  if (!prompt) throw p2Error("TEMPLATE_NOT_FOUND", 404);
  return { name: prompt.name, instruction: prompt.prompt };
}
