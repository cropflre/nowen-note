import { z } from "zod";

export const inspectorResourceV3Schema = z.object({
  type: z.enum(["note", "task", "attachment"]),
  id: z.string().trim().min(1).max(200),
}).strict();
export type InspectorResourceV3 = z.infer<typeof inspectorResourceV3Schema>;

export const INSPECTOR_PERMISSIONS = { note: "notes:read", task: "tasks:read", attachment: "attachments:read" } as const;
export const INSPECTOR_METHODS = { note: "notes.inspect", task: "tasks.inspect", attachment: "attachments.inspect" } as const;
export const inspectorV3Schema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  title: z.string().trim().min(1).max(100),
  pageId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  resourceTypes: z.array(inspectorResourceV3Schema.shape.type).min(1).max(3)
    .refine(types => new Set(types).size === types.length),
}).strict();
export type PluginInspectorV3 = z.infer<typeof inspectorV3Schema>;
export const inspectorContextV3Schema = z.object({ id: inspectorV3Schema.shape.id, resource: inspectorResourceV3Schema }).strict();
