import type { WorkflowDefinition, WorkflowStep } from "./types.js";

const STEP_TYPES = new Set(["action", "condition", "delay", "transform", "stop"]);
const OPERATORS = new Set(["equals", "not_equals", "contains", "starts_with", "ends_with", "exists", "greater_than", "less_than"]);
const EVENT_TYPES = new Set([
  "note.created", "note.updated", "note.trashed", "note.restored", "note.deleted",
  "notebook.created", "notebook.updated", "notebook.deleted",
  "tag.created", "tag.added_to_note", "tag.removed_from_note",
  "task.created", "task.updated", "task.completed", "task.reopened", "task.deleted",
  "attachment.created", "attachment.deleted", "diary.created", "diary.updated",
  "mindmap.created", "mindmap.updated", "app.started", "plugin.enabled", "plugin.disabled",
]);

function bad(message: string): never {
  throw Object.assign(new Error(message), { code: "AUTOMATION_DEFINITION_INVALID" });
}

function assertTemplateValue(value: unknown, depth = 0): void {
  if (depth > 12) bad("工作流模板嵌套过深");
  if (typeof value === "string") {
    const matches = value.match(/{{\s*([^}]+)\s*}}/g) || [];
    for (const match of matches) {
      const path = match.slice(2, -2).trim();
      if (!/^(event|steps|workflow|user|workspace)(?:\.[A-Za-z0-9_-]+)+$/.test(path)) bad(`不允许的模板变量: ${path}`);
    }
    if (value.includes("{{") && matches.length === 0) bad("模板表达式格式无效");
    return;
  }
  if (Array.isArray(value)) return value.forEach((item) => assertTemplateValue(item, depth + 1));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).forEach((item) => assertTemplateValue(item, depth + 1));
}

export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) bad("工作流定义必须是对象");
  const value = input as Record<string, unknown>;
  if (value.version !== 1) bad("只支持 Workflow Definition V1");
  if (!value.trigger || typeof value.trigger !== "object") bad("缺少 trigger");
  const trigger = value.trigger as Record<string, unknown>;
  if (!new Set(["event", "schedule", "webhook", "manual"]).has(String(trigger.type))) bad("trigger.type 无效");
  if (trigger.type === "event" && !EVENT_TYPES.has(String(trigger.event))) bad("事件类型不受支持");
  if (trigger.type === "schedule") {
    if (typeof trigger.cron !== "string" || trigger.cron.length > 100) bad("cron 无效");
    if (typeof trigger.timezone !== "string" || trigger.timezone.length > 80) bad("timezone 无效");
    try { new Intl.DateTimeFormat("en", { timeZone: trigger.timezone }); } catch { bad("timezone 无效"); }
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 50) bad("工作流步骤数量必须在 1-50 之间");
  const ids = new Set<string>();
  for (const raw of value.steps as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") bad("步骤必须是对象");
    const id = String(raw.id || "");
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || ids.has(id)) bad(`步骤 ID 无效或重复: ${id}`);
    ids.add(id);
    if (!STEP_TYPES.has(String(raw.type))) bad(`步骤类型无效: ${raw.type}`);
    if (raw.type === "action") {
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(String(raw.pluginId || ""))) bad("Action pluginId 无效");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(raw.actionId || ""))) bad("Action actionId 无效");
      if (raw.maxAttempts !== undefined && (!Number.isInteger(raw.maxAttempts) || Number(raw.maxAttempts) < 1 || Number(raw.maxAttempts) > 3)) bad("maxAttempts 必须在 1-3 之间");
      assertTemplateValue(raw.input ?? {});
    } else if (raw.type === "condition") {
      const condition = raw.if as Record<string, unknown> | undefined;
      if (!condition || !OPERATORS.has(String(condition.operator))) bad("Condition operator 无效");
      assertTemplateValue(condition.left);
      assertTemplateValue(condition.right);
    } else if (raw.type === "delay") {
      if (!Number.isInteger(raw.seconds) || Number(raw.seconds) < 1 || Number(raw.seconds) > 86400 * 30) bad("Delay 必须在 1 秒到 30 天之间");
    } else if (raw.type === "transform") {
      assertTemplateValue(raw.output);
    }
  }
  for (const raw of value.steps as Array<Record<string, unknown>>) {
    if (raw.type !== "condition") continue;
    for (const branch of [raw.then, raw.else]) if (branch && branch !== "stop" && !ids.has(String(branch))) bad(`Condition 跳转目标不存在: ${branch}`);
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) bad("工作流定义超过 256KB");
  return value as unknown as WorkflowDefinition;
}

export function actionStep(definition: WorkflowDefinition, stepId: string): Extract<WorkflowStep, { type: "action" }> | undefined {
  return definition.steps.find((step): step is Extract<WorkflowStep, { type: "action" }> => step.id === stepId && step.type === "action");
}

export const SUPPORTED_AUTOMATION_EVENTS = [...EVENT_TYPES].sort();
