import type { PluginPromptPackContribution, PluginStaticInputField } from "../types.js";
export type PromptHostContext = { title?: string; note?: string; selection?: string; tags?: string[] };
function resolveInputs(fields: PluginStaticInputField[] | undefined, input: Record<string, unknown>): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const field of fields || []) {
    const value = input[field.id] ?? field.default;
    if (value === undefined || value === null || value === "") {
      if (field.required) throw Object.assign(new Error("缺少 Prompt 输入: " + field.id), { code: "PLUGIN_PROMPT_INPUT_REQUIRED" });
      values[field.id] = ""; continue;
    }
    if (typeof value !== field.type) throw Object.assign(new Error("Prompt 输入类型错误: " + field.id), { code: "PLUGIN_PROMPT_INPUT_INVALID" });
    values[field.id] = value as string | number | boolean;
  }
  return values;
}
export function renderPromptPackContribution(contribution: PluginPromptPackContribution, input: Record<string, unknown>): string {
  const values = resolveInputs(contribution.inputs, input);
  return contribution.prompt.replace(/{{s*([a-z][a-z0-9_-]{0,63})s*}}/gi, (_all, key: string) => key in values ? String(values[key]) : "{{" + key + "}}");
}
export function selectPromptContext(contribution: PluginPromptPackContribution, context: PromptHostContext): PromptHostContext {
  const allowed = new Set(contribution.context || []); const result: PromptHostContext = {};
  if (allowed.has("title") && context.title) result.title = context.title;
  if (allowed.has("note") && context.note) result.note = context.note;
  if (allowed.has("selection") && context.selection) result.selection = context.selection;
  if (allowed.has("tags") && context.tags?.length) result.tags = [...context.tags];
  return result;
}
