import { z } from "zod";
import type { ToolDefinition } from "./model.js";

export const workflowInput = z.object({
  notebookId: z.string().min(1).max(128), includeChildren: z.boolean().default(true),
  instruction: z.string().trim().min(1).max(4000),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  lang: z.enum(["zh-CN", "en"]).default("zh-CN"),
  linkNoteId: z.string().min(1).max(128).optional(),
}).strict();
export const workflowPlan = z.object({
  summary: z.string().trim().min(1).max(16000),
  sourceNoteIds: z.array(z.string().min(1).max(128)).max(10),
  note: z.object({ title: z.string().trim().min(1).max(200), content: z.string().min(1).max(48000) }).strict().optional(),
  taskRequest: z.string().trim().min(1).max(4000).optional(),
}).strict();
export const workflowTools: ToolDefinition[] = [
  { type: "function", function: { name: "search_notebook", description: "Search only the user-selected notebook scope. Returns bounded untrusted note context and source IDs. Never searches other scopes.", parameters: { type: "object", properties: { query: { type: "string", maxLength: 1000 } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "propose_workflow", description: "Finish with a cited summary and optional new Markdown note and/or task request. No writes occur. taskRequest is passed to the existing task composer. Human approval is required for all writes.", parameters: {
    type: "object", properties: {
      summary: { type: "string", maxLength: 16000 }, sourceNoteIds: { type: "array", items: { type: "string" }, maxItems: 10 },
      note: { type: "object", properties: { title: { type: "string", maxLength: 200 }, content: { type: "string", maxLength: 48000 } }, required: ["title", "content"], additionalProperties: false },
      taskRequest: { type: "string", maxLength: 4000 },
    }, required: ["summary", "sourceNoteIds"], additionalProperties: false,
  } } },
];
