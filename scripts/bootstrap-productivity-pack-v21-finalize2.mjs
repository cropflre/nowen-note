import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const write = (file, content) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
function patch(file, search, replacement) {
  const source = read(file);
  const next = typeof search === "string" ? source.replace(search, replacement) : source.replace(search, replacement);
  if (next === source) throw new Error("Patch did not match: " + file + " :: " + String(search).slice(0, 100));
  write(file, next);
}
const block = (value) => value.replace(/^\n/, "");

patch("backend/src/plugins/pluginService.ts",
  'import { isDeclarativePluginManifest, pluginManifestActions, type PluginManifest, type PluginRegistryRecord } from "./types.js";',
  'import { isDeclarativePluginManifest, pluginManifestActions, type PluginManifest, type PluginRegistryRecord } from "./types.js";\nimport { createNoteFromPluginTemplate } from "./contributions/noteTemplateContribution.js";');
patch("backend/src/plugins/pluginService.ts",
  '  async checkUpdates(sourceId: string): Promise<Array<Record<string, unknown>>> {',
  block(`
  createNoteFromTemplateContribution(pluginId: string, templateId: string, userId: string, input: { workspaceId?: string | null; parentId?: string | null; values?: Record<string, unknown> }): Record<string, unknown> {
    const record = this.requireRecord(pluginId);
    if (record.status !== "enabled") throw Object.assign(new Error("插件未启用"), { code: "PLUGIN_NOT_ENABLED" });
    const manifest = manifestOf(record);
    const template = manifest.apiVersion === 2 ? manifest.contributes?.noteTemplates?.find((item) => item.id === templateId) : undefined;
    if (!template) throw Object.assign(new Error("Note Template 不存在"), { code: "PLUGIN_TEMPLATE_NOT_FOUND" });
    return createNoteFromPluginTemplate({ userId, workspaceId: input.workspaceId, parentId: input.parentId || null, template, values: input.values || {} });
  }

  async checkUpdates(sourceId: string): Promise<Array<Record<string, unknown>>> {`));
patch("backend/src/routes/plugins.ts",
  'pluginsRouter.put("/:id/update-policy", requireAdmin, async (c) => {',
  block(`
pluginsRouter.post("/:id/note-templates/:templateId/create", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { workspaceId?: string | null; parentId?: string | null; values?: Record<string, unknown> };
    return c.json({ success: true, ...getPluginService().createNoteFromTemplateContribution(c.req.param("id"), c.req.param("templateId"), userId(c), body) }, 201);
  } catch (error) { return errorResponse(c, error); }
});
pluginsRouter.put("/:id/update-policy", requireAdmin, async (c) => {`));

write("backend/src/plugins/contributions/promptPackContribution.ts", block(`
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
  return contribution.prompt.replace(/\{\{\s*([a-z][a-z0-9_-]{0,63})\s*\}\}/gi, (_all, key: string) => key in values ? String(values[key]) : "{{" + key + "}}");
}
export function selectPromptContext(contribution: PluginPromptPackContribution, context: PromptHostContext): PromptHostContext {
  const allowed = new Set(contribution.context || []); const result: PromptHostContext = {};
  if (allowed.has("title") && context.title) result.title = context.title;
  if (allowed.has("note") && context.note) result.note = context.note;
  if (allowed.has("selection") && context.selection) result.selection = context.selection;
  if (allowed.has("tags") && context.tags?.length) result.tags = [...context.tags];
  return result;
}
`));

patch("frontend/src/lib/pluginApi.ts", /(  installAutomationTemplate:[^\n]+\n)/, '$1  createNoteFromTemplate: (id: string, templateId: string, input: { workspaceId?: string | null; parentId?: string | null; values?: Record<string, unknown> }) => request<{ success: true; noteId: string; node: unknown }>("/plugins/" + encodeURIComponent(id) + "/note-templates/" + encodeURIComponent(templateId) + "/create", { method: "POST", body: JSON.stringify(input) }),\n');

write("frontend/src/components/PluginNoteTemplatePickerSection.tsx", block(`
import { useCallback, useEffect, useState } from "react";
import { Boxes, FileCode, FileText, Loader2 } from "lucide-react";
import { pluginApi } from "@/lib/pluginApi";
import { listPluginNoteTemplates, replacePluginNoteTemplates, type RegisteredPluginNoteTemplate } from "@/lib/pluginTemplateRegistry";
import { prompt } from "@/components/ui/confirm";
export default function PluginNoteTemplatePickerSection({ disabled, onCreate }: { disabled?: boolean; onCreate?: (pluginId: string, templateId: string, values: Record<string, unknown>) => Promise<void> }) {
  const [templates, setTemplates] = useState<RegisteredPluginNoteTemplate[]>([]); const [creating, setCreating] = useState<string | null>(null);
  const load = useCallback(async () => { try { replacePluginNoteTemplates(await pluginApi.contributions()); setTemplates(listPluginNoteTemplates()); } catch { setTemplates([]); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!templates.length || !onCreate) return null;
  const create = async (template: RegisteredPluginNoteTemplate) => {
    const values: Record<string, unknown> = {};
    for (const field of template.variables || []) {
      const raw = await prompt({ title: field.label || field.id, description: template.name + " · " + field.type, defaultValue: field.default == null ? "" : String(field.default), confirmText: "继续" });
      if (raw == null) return;
      if (field.type === "number") { const value = Number(raw); if (!Number.isFinite(value)) return; values[field.id] = value; }
      else if (field.type === "boolean") values[field.id] = /^(1|true|yes|是)$/i.test(raw.trim()); else values[field.id] = raw;
    }
    setCreating(template.runtimeId); try { await onCreate(template.pluginId, template.id, values); } finally { setCreating(null); }
  };
  return <div className="mt-3 border-t border-app-border pt-3"><div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-semibold text-tx-tertiary"><Boxes size={13}/>来自插件</div><div className="space-y-2">{templates.map((template) => { const Icon = template.contentFormat === "markdown" ? FileCode : FileText; return <button key={template.runtimeId} type="button" disabled={disabled || Boolean(creating)} onClick={() => void create(template)} className="flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-bg/35 p-3 text-left transition-colors hover:border-accent-primary/35 hover:bg-app-hover disabled:opacity-50"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">{creating === template.runtimeId ? <Loader2 size={16} className="animate-spin"/> : <Icon size={16}/>}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-tx-primary">{template.name}</span><span className="mt-1 block truncate text-[11px] text-tx-tertiary">{template.description || template.pluginId} · {template.publisher || template.pluginId}</span></span></button>; })}</div></div>;
}
`));
patch("frontend/src/components/NoteTemplatePickerDialog.tsx", 'import { noteTemplatesApi, type NoteTemplateSummary } from "@/lib/noteTemplatesApi";', 'import { noteTemplatesApi, type NoteTemplateSummary } from "@/lib/noteTemplatesApi";\nimport PluginNoteTemplatePickerSection from "@/components/PluginNoteTemplatePickerSection";');
patch("frontend/src/components/NoteTemplatePickerDialog.tsx", '  onCreate: (templateId: string) => Promise<void>;\n}', '  onCreate: (templateId: string) => Promise<void>;\n  onCreatePlugin?: (pluginId: string, templateId: string, values: Record<string, unknown>) => Promise<void>;\n}');
patch("frontend/src/components/NoteTemplatePickerDialog.tsx", '  onCreate,\n}: NoteTemplatePickerDialogProps) {', '  onCreate,\n  onCreatePlugin,\n}: NoteTemplatePickerDialogProps) {');
patch("frontend/src/components/NoteTemplatePickerDialog.tsx", '          )}\n        </div>\n      </section>', '          )}\n          <PluginNoteTemplatePickerSection disabled={Boolean(creatingId || deletingId)} onCreate={onCreatePlugin} />\n        </div>\n      </section>');

patch("frontend/src/components/KnowledgeTreeCreateMenuRuntime.tsx", 'import { toast } from "@/lib/toast";', 'import { toast } from "@/lib/toast";\nimport { getCurrentWorkspace } from "@/lib/api";\nimport { pluginApi } from "@/lib/pluginApi";');
patch("frontend/src/components/KnowledgeTreeCreateMenuRuntime.tsx", '  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {', block(`
  const requestPluginTemplateCreate = useCallback(async (pluginId: string, templateId: string, values: Record<string, unknown>) => {
    const parentId = templatePicker?.parentId ?? null;
    await pluginApi.createNoteFromTemplate(pluginId, templateId, { workspaceId: getCurrentWorkspace(), parentId, values });
    window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, { detail: { reason: "plugin-template-created", parentId } }));
    actions.refreshNotebooks(); actions.refreshNotes(); toast.success("已从插件模板创建笔记");
  }, [actions, templatePicker?.parentId]);

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {`));
patch("frontend/src/components/KnowledgeTreeCreateMenuRuntime.tsx", '        onCreate={requestTemplateCreate}\n      />', '        onCreate={requestTemplateCreate}\n        onCreatePlugin={requestPluginTemplateCreate}\n      />');

patch("frontend/src/components/MobileKnowledgeTreePanel.tsx", 'import { api } from "@/lib/api";', 'import { api, getCurrentWorkspace } from "@/lib/api";\nimport { pluginApi } from "@/lib/pluginApi";');
patch("frontend/src/components/MobileKnowledgeTreePanel.tsx", '  const rename = async (node: KnowledgeTreeNode) => {', block(`
  const createFromPluginTemplate = useCallback(async (pluginId: string, templateId: string, values: Record<string, unknown>) => {
    const targetParentId = templatePicker?.parentId ?? null;
    const result = await pluginApi.createNoteFromTemplate(pluginId, templateId, { workspaceId: getCurrentWorkspace(), parentId: targetParentId, values });
    emitTreeChanged("plugin-template-created-quick-browse"); await reload(); actions.refreshNotebooks(); actions.refreshNotes();
    const node = result.node as KnowledgeTreeNode; rememberOpened(node.id);
    try { activateNote(await api.getNote(result.noteId), targetParentId); } catch (openError: any) { toast.error(openError?.message || "文档已创建，但自动打开失败"); }
    toast.success("已从插件模板创建笔记");
  }, [actions, activateNote, reload, rememberOpened, templatePicker?.parentId]);

  const rename = async (node: KnowledgeTreeNode) => {`));
patch("frontend/src/components/MobileKnowledgeTreePanel.tsx", '        onCreate={createFromTemplate}\n      />', '        onCreate={createFromTemplate}\n        onCreatePlugin={createFromPluginTemplate}\n      />');

write("frontend/src/components/PluginPromptPicker.tsx", block(`
import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { pluginApi } from "@/lib/pluginApi";
import { listPluginPrompts, renderPluginPrompt, replacePluginPrompts, type RegisteredPluginPrompt } from "@/lib/pluginPromptRegistry";
import { useApp } from "@/store/AppContext";
function currentPlatform(): "web" | "desktop" { return typeof window !== "undefined" && "electronAPI" in window ? "desktop" : "web"; }
export default function PluginPromptPicker({ onSelect, disabled }: { onSelect: (value: string) => void; disabled?: boolean }) {
  const { state } = useApp(); const [items, setItems] = useState<RegisteredPluginPrompt[]>([]); const [open, setOpen] = useState(false);
  const load = useCallback(async () => { try { replacePluginPrompts(await pluginApi.contributions()); setItems(listPluginPrompts(currentPlatform()).filter((item) => !item.context?.includes("selection"))); } catch { setItems([]); } }, []);
  useEffect(() => { void load(); }, [load]); const note = state.activeNote as any;
  const select = async (item: RegisteredPluginPrompt) => { const values: Record<string, unknown> = {};
    for (const field of item.inputs || []) { const raw = window.prompt(field.label || field.id, field.default == null ? "" : String(field.default)); if (raw == null) return; values[field.id] = field.type === "number" ? Number(raw) : field.type === "boolean" ? /^(1|true|yes|是)$/i.test(raw.trim()) : raw; }
    let value = renderPluginPrompt(item, values); const context: string[] = [];
    if (item.context?.includes("title") && note?.title) context.push("标题：" + note.title);
    if (item.context?.includes("note") && (note?.contentText || note?.content)) context.push("笔记内容：\n" + String(note.contentText || note.content).slice(0, 12000));
    if (item.context?.includes("tags") && Array.isArray(note?.tags) && note.tags.length) context.push("标签：" + note.tags.map((tag: any) => tag.name || tag).join(", "));
    if (context.length) value += "\n\n以下是 Host 按声明提供的最小上下文：\n" + context.join("\n\n"); onSelect(value); setOpen(false);
  };
  if (!items.length) return null;
  return <div className="relative"><button type="button" disabled={disabled} onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-violet-500 hover:bg-violet-500/10 disabled:opacity-50"><Sparkles size={11}/>Prompt Pack</button>{open && <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-app-border bg-app-surface p-1.5 shadow-xl">{items.map((item) => <button key={item.runtimeId} type="button" onClick={() => void select(item)} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-app-hover"><span className="block text-xs font-medium text-tx-primary">{item.name}</span><span className="mt-0.5 block text-[10px] text-tx-tertiary">{item.description || item.pluginId}</span></button>)}</div>}</div>;
}
`));
patch("frontend/src/components/AIChatPanel.tsx", 'import AIKnowledgeScopePicker from "@/components/AIKnowledgeScopePicker";', 'import AIKnowledgeScopePicker from "@/components/AIKnowledgeScopePicker";\nimport PluginPromptPicker from "@/components/PluginPromptPicker";');
patch("frontend/src/components/AIChatPanel.tsx", '              <span className="ml-auto hidden text-tx-tertiary lg:inline">Enter 发送 · Shift + Enter 换行</span>', '              <PluginPromptPicker disabled={isLoading} onSelect={(value) => { setInput(value); requestAnimationFrame(() => inputRef.current?.focus()); }} />\n              <span className="ml-auto hidden text-tx-tertiary lg:inline">Enter 发送 · Shift + Enter 换行</span>');

write("frontend/src/components/settings/PluginPromptPackSettingsSection.tsx", block(`
import { useEffect, useState } from "react"; import { Sparkles } from "lucide-react";
import { pluginApi } from "@/lib/pluginApi"; import { listPluginPrompts, replacePluginPrompts, type RegisteredPluginPrompt } from "@/lib/pluginPromptRegistry";
export default function PluginPromptPackSettingsSection() { const [items, setItems] = useState<RegisteredPluginPrompt[]>([]); useEffect(() => { void pluginApi.contributions().then((records) => { replacePluginPrompts(records); setItems(listPluginPrompts()); }).catch(() => setItems([])); }, []); if (!items.length) return null;
  return <section className="rounded-xl border border-app-border bg-app-surface p-4"><div className="mb-3 flex items-center gap-2"><Sparkles size={16} className="text-violet-500"/><div><div className="text-sm font-semibold text-tx-primary">来自插件的 Prompt Pack</div><div className="text-[11px] text-tx-tertiary">只声明 Prompt 和最小上下文，不会获得你的 AI Key。</div></div></div><div className="grid gap-2 sm:grid-cols-2">{items.map((item) => <div key={item.runtimeId} className="rounded-lg border border-app-border bg-app-bg/40 p-3"><div className="text-xs font-medium text-tx-primary">{item.name}</div><div className="mt-1 text-[10px] text-tx-tertiary">{item.description || item.pluginId}</div><div className="mt-2 text-[9px] text-tx-tertiary">上下文：{item.context?.join(" · ") || "无"}</div></div>)}</div></section>;
}
`));
patch("frontend/src/components/AISettingsPanel.tsx", 'import { cn } from "@/lib/utils";', 'import { cn } from "@/lib/utils";\nimport PluginPromptPackSettingsSection from "@/components/settings/PluginPromptPackSettingsSection";');
patch("frontend/src/components/AISettingsPanel.tsx", /([ \t]*<\/section>\n[ \t]*<\/div>\n[ \t]*<\/div>\n[ \t]*\);\n}\s*)$/, (match) => match.replace('</section>\n      </div>\n    </div>', '</section>\n      </div>\n      <PluginPromptPackSettingsSection />\n    </div>'));

write("backend/tests/productivity-contribution-host.test.ts", block(`
import assert from "node:assert/strict"; import test from "node:test";
import { renderPromptPackContribution, selectPromptContext } from "../src/plugins/contributions/promptPackContribution.js";
test("Prompt Pack exposes only declared host context", () => { const contribution: any = { id: "summary", name: "Summary", prompt: "{{tone}}", inputs: [{ id: "tone", type: "string", default: "clear" }], context: ["title", "note"] }; assert.equal(renderPromptPackContribution(contribution, {}), "clear"); assert.deepEqual(selectPromptContext(contribution, { title: "T", note: "N", selection: "SECRET", tags: ["x"] }), { title: "T", note: "N" }); });
`));

let ci = read(".github/workflows/extension-v2-1-ci.yml");
ci = ci.replaceAll('      - "examples/plugins/theme-pack/**"', '      - "examples/plugins/theme-pack/**"\n      - "examples/plugins/productivity-pack/**"\n      - "backend/tests/productivity-contribution*.test.ts"\n      - "frontend/src/lib/pluginTemplateRegistry.ts"\n      - "frontend/src/lib/pluginPromptRegistry.ts"\n      - "frontend/src/lib/__tests__/pluginProductivityRegistry.test.ts"\n      - "frontend/src/components/PluginNoteTemplatePickerSection.tsx"\n      - "frontend/src/components/PluginPromptPicker.tsx"\n      - "frontend/src/components/settings/PluginPromptPackSettingsSection.tsx"');
ci = ci.replace('      - name: Install backend dependencies', '      - name: Validate and pack official Productivity Pack\n        working-directory: examples/plugins/productivity-pack\n        run: |\n          node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs validate\n          node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs doctor\n          node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack\n      - name: Install backend dependencies');
ci = ci.replace('          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/note-appearance.test.ts', '          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/note-appearance.test.ts\n          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/productivity-contribution.test.ts\n          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/productivity-contribution-host.test.ts');
ci = ci.replace('      - name: Frontend production build', '      - name: Productivity contribution registry\n        working-directory: frontend\n        run: npx vitest run src/lib/__tests__/pluginProductivityRegistry.test.ts --reporter=verbose\n      - name: Frontend production build');
write(".github/workflows/extension-v2-1-ci.yml", ci);
console.log("Productivity Pack Host integration finalized safely");
