import { z } from "zod";

export const widgetV3Schema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), title: z.string().trim().min(1).max(100),
  type: z.enum(["shortcut", "statistic", "status", "list", "app"]), pageId: z.string(),
  collection: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).optional(),
  field: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/).optional(),
  defaultSize: z.enum(["small", "medium", "large"]).default("small"),
}).strict().superRefine((widget, context) => {
  if (["statistic", "status", "list"].includes(widget.type) && !widget.collection) context.addIssue({ code: z.ZodIssueCode.custom, message: "数据卡片必须声明 collection" });
});
export type PluginWidgetV3 = z.infer<typeof widgetV3Schema>;
