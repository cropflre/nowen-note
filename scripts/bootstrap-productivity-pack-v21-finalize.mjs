import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const write = (file, content) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const replaceOnce = (file, from, to) => {
  const current = read(file);
  if (!current.includes(from)) throw new Error(`Missing patch anchor in ${file}: ${from.slice(0, 120)}`);
  if (current.indexOf(from) !== current.lastIndexOf(from)) throw new Error(`Ambiguous patch anchor in ${file}: ${from.slice(0, 120)}`);
  write(file, current.replace(from, to));
};

// Backend host-owned template creation: plugin never receives notes:write.
replaceOnce(
  "backend/src/plugins/pluginService.ts",
  `import { isDeclarativePluginManifest, pluginManifestActions, type PluginManifest, type PluginRegistryRecord } from "./types.js";`,
  `import { isDeclarativePluginManifest, pluginManifestActions, type PluginManifest, type PluginRegistryRecord } from "./types.js";\nimport { createNoteFromPluginTemplate } from "./contributions/noteTemplateContribution.js";`,
);
replaceOnce(
  "backend/src/plugins/pluginService.ts",
  `  async checkUpdates(sourceId: string): Promise<Array<Record<string, unknown>>> {`,
  `  createNoteFromTemplateContribution(pluginId: string, templateId: string, userId: string, input: { workspaceId?: string | null; parentId?: string | null; values?: Record<string, unknown> }): Record<string, unknown> {\n    const record = this.requireRecord(pluginId);\n    if (record.status !== "enabled") throw Object.assign(new Error("插件未启用"), { code: "PLUGIN_NOT_ENABLED" });\n    const manifest = manifestOf(record);\n    const template = manifest.apiVersion === 2 ? manifest.contributes?.noteTemplates?.find((item) => item.id === templateId) : undefined;\n    if (!template) throw Object.assign(new Error("Note Template 不存在"), { code: "PLUGIN_TEMPLATE_NOT_FOUND" });\n    return createNoteFromPluginTemplate({\n      userId,\n      workspaceId: input.workspaceId,\n      parentId: input.parentId || null,\n      template,\n      values: input.values || {},\n    });\n  }\n\n  async checkUpdates(sourceId: string): Promise<Array<Record<string, unknown>>> {`,
);
replaceOnce(
  "backend/src/routes/plugins.ts",
  `pluginsRouter.put("/:id/update-policy", requireAdmin, async (c) => {`,
  `pluginsRouter.post("/:id/note-templates/:templateId/create", async (c) => {\n  try {\n    const body = await c.req.json().catch(() => ({})) as { workspaceId?: string | null; parentId?: string | null; values?: Record<string, unknown> };\n    return c.json({\n      success: true,\n      ...getPluginService().createNoteFromTemplateContribution(c.req.param("id"), c.req.param("templateId"), userId(c), body),\n    }, 201);\n  } catch (error) { return errorResponse(c, error); }\n});\npluginsRouter.put("/:id/update-policy", requireAdmin, async (c) => {`,
);

write("backend/src/plugins/contributions/promptPackContribution.ts", `import type { PluginPromptPackContribution, PluginStaticInputField } from "../types.js";\n\nexport type PromptHostContext = { title?: string; note?: string; selection?: string; tags?: string[] };\n\nfunction resolveInputs(fields: PluginStaticInputField[] | undefined, input: Record<string, unknown>): Record<string, string | number | boolean> {\n  const values: Record<string, string | number | boolean> = {};\n  for (const field of fields || []) {\n    const value = input[field.id] ?? field.default;\n    if (value === undefined || value === null || value === "") {\n      if (field.required) throw Object.assign(new Error(`缺少 Prompt 输入: ${field.id}`), { code: "PLUGIN_PROMPT_INPUT_REQUIRED" });\n      values[field.id] = "";\n      continue;\n    }\n    if (typeof value !== field.type) throw Object.assign(new Error(`Prompt 输入类型错误: ${field.id}`), { code: "PLUGIN_PROMPT_INPUT_INVALID" });\n    values[field.id] = value as string | number | boolean;\n  }\n  return values;\n}\n\nexport function renderPromptPackContribution(contribution: PluginPromptPackContribution, input: Record<string, unknown>): string {\n  const values = resolveInputs(contribution.inputs, input);\n  return contribution.prompt.replace(/\\{\\{\\s*([a-z][a-z0-9_-]{0,63})\\s*\\}\\}/gi, (_all, key: string) => key in values ? String(values[key]) : `{{${key}}}`);\n}\n\nexport function selectPromptContext(contribution: PluginPromptPackContribution, context: PromptHostContext): PromptHostContext {\n  const allowed = new Set(contribution.context || []);\n  const result: PromptHostContext = {};\n  if (allowed.has("title") && context.title) result.title = context.title;\n  if (allowed.has("note") && context.note) result.note = context.note;\n  if (allowed.has("selection") && context.selection) result.selection = context.selection;\n  if (allowed.has("tags") && context.tags?.length) result.tags = [...context.tags];\n  return result;\n}\n`);

// Frontend API for explicit Host action.
replaceOnce(
  "frontend/src/lib/pluginApi.ts",
  `  installAutomationTemplate: (id: string, templateId: string) => request(\`/plugins/\${encodeURIComponent(id)}/automation-templates/\${encodeURIComponent(templateId)}/install\`, { method: "POST" }),`,
  `  installAutomationTemplate: (id: string, templateId: string) => request(\`/plugins/\${encodeURIComponent(id)}/automation-templates/\${encodeURIComponent(templateId)}/install\`, { method: "POST" }),\n  createNoteFromTemplate: (id: string, templateId: string, input: { workspaceId?: string | null; parentId?: string | null; values?: Record<string, unknown> }) =>\n    request<{ success: true; noteId: string; node: unknown }>(\`/plugins/\${encodeURIComponent(id)}/note-templates/\${encodeURIComponent(templateId)}/create\`, { method: "POST", body: JSON.stringify(input) }),`,
);

write("frontend/src/components/PluginNoteTemplatePickerSection.tsx", `import { useCallback, useEffect, useState } from "react";\nimport { Boxes, FileCode, FileText, Loader2 } from "lucide-react";\nimport { pluginApi } from "@/lib/pluginApi";\nimport { listPluginNoteTemplates, replacePluginNoteTemplates, type RegisteredPluginNoteTemplate } from "@/lib/pluginTemplateRegistry";\nimport { prompt } from "@/components/ui/confirm";\n\nexport default function PluginNoteTemplatePickerSection({ disabled, onCreate }: { disabled?: boolean; onCreate?: (pluginId: string, templateId: string, values: Record<string, unknown>) => Promise<void> }) {\n  const [templates, setTemplates] = useState<RegisteredPluginNoteTemplate[]>([]);\n  const [creating, setCreating] = useState<string | null>(null);\n  const load = useCallback(async () => {\n    try { replacePluginNoteTemplates(await pluginApi.contributions()); setTemplates(listPluginNoteTemplates()); } catch { setTemplates([]); }\n  }, []);\n  useEffect(() => { void load(); }, [load]);\n  if (!templates.length || !onCreate) return null;\n  const create = async (template: RegisteredPluginNoteTemplate) => {\n    const values: Record<string, unknown> = {};\n    for (const field of template.variables || []) {\n      const raw = await prompt({ title: field.label || field.id, description: `${template.name} · ${field.type}`, defaultValue: field.default == null ? "" : String(field.default), confirmText: "继续" });\n      if (raw == null) return;\n      if (field.type === "number") { const value = Number(raw); if (!Number.isFinite(value)) return; values[field.id] = value; }\n      else if (field.type === "boolean") values[field.id] = /^(1|true|yes|是)$/i.test(raw.trim());\n      else values[field.id] = raw;\n    }\n    setCreating(template.runtimeId);\n    try { await onCreate(template.pluginId, template.id, values); } finally { setCreating(null); }\n  };\n  return (\n    <div className="mt-3 border-t border-app-border pt-3">\n      <div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-semibold text-tx-tertiary"><Boxes size={13} />来自插件</div>\n      <div className="space-y-2">\n        {templates.map((template) => {\n          const Icon = template.contentFormat === "markdown" ? FileCode : FileText;\n          return <button key={template.runtimeId} type="button" disabled={disabled || Boolean(creating)} onClick={() => void create(template)} className="flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-bg/35 p-3 text-left transition-colors hover:border-accent-primary/35 hover:bg-app-hover disabled:opacity-50">\n            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">{creating === template.runtimeId ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}</span>\n            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-tx-primary">{template.name}</span><span className="mt-1 block truncate text-[11px] text-tx-tertiary">{template.description || template.pluginId} · {template.publisher || template.pluginId}</span></span>\n          </button>;\n        })}\n      </div>\n    </div>\n  );\n}\n`);

// Integrate plugin templates into the existing picker without replacing the native template flow.
replaceOnce(
  "frontend/src/components/NoteTemplatePickerDialog.tsx",
  `import { noteTemplatesApi, type NoteTemplateSummary } from "@/lib/noteTemplatesApi";`,
  `import { noteTemplatesApi, type NoteTemplateSummary } from "@/lib/noteTemplatesApi";\nimport PluginNoteTemplatePickerSection from "@/components/PluginNoteTemplatePickerSection";`,
);
replaceOnce(
  "frontend/src/components/NoteTemplatePickerDialog.tsx",
  `  onCreate: (templateId: string) => Promise<void>;\n}`,
  `  onCreate: (templateId: string) => Promise<void>;\n  onCreatePlugin?: (pluginId: string, templateId: string, values: Record<string, unknown>) => Promise<void>;\n}`,
);
replaceOnce(
  "frontend/src/components/NoteTemplatePickerDialog.tsx",
  `  onCreate,\n}: NoteTemplatePickerDialogProps) {`,
  `  onCreate,\n  onCreatePlugin,\n}: NoteTemplatePickerDialogProps) {`,
);
replaceOnce(
  "frontend/src/components/NoteTemplatePickerDialog.tsx",
  `          )}\n        </div>`,
  `          )}\n          <PluginNoteTemplatePickerSection disabled={Boolean(creatingId || deletingId)} onCreate={onCreatePlugin} />\n        </div>`,
);

// Desktop knowledge tree explicit Host create.
replaceOnce(
  "frontend/src/components/KnowledgeTreeCreateMenuRuntime.tsx",
  `import { toast } from "@/lib/toast";`,
  `import { toast } from "@/lib/toast";\nimport { getCurrentWorkspace } from "@/lib/api";\nimport { pluginApi } from "@/lib/pluginApi";`,
);
replaceOnce(
  "frontend/src/components/KnowledgeTreeCreateMenuRuntime.tsx",
  `  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {`,
  `  const requestPluginTemplateCreate = useCallback(async (pluginId: string, templateId: string, values: Record<string, unknown>) => {\n    const parentId = templatePicker?.parentId ?? null;\n    await pluginApi.createNoteFromTemplate(pluginId, templateId, { workspaceId: getCurrentWorkspace(), parentId, values });\n    window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, { detail: { reason: "plugin-template-created", parentId } }));\n    actions.refreshNotebooks();\n    actions.refreshNotes();\n    toast.success("已从插件模板创建笔记");\n  }, [actions, templatePicker?.parentId]);\n\n  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {`,
);
replaceOnce(
  "frontend/src/components/KnowledgeTreeCreateMenuRuntime.tsx",
  `        onCreate={requestTemplateCreate}\n      />`,
  `        onCreate={requestTemplateCreate}\n        onCreatePlugin={requestPluginTemplateCreate}\n      />`,
);

// Mobile knowledge tree explicit Host create and refresh.
replaceOnce(
  "frontend/src/components/MobileKnowledgeTreePanel.tsx",
  `import { api } from "@/lib/api";`,
  `import { api, getCurrentWorkspace } from "@/lib/api";\nimport { pluginApi } from "@/lib/pluginApi";`,
);
replaceOnce(
  "frontend/src/components/MobileKnowledgeTreePanel.tsx",
  `  const rename = async (node: KnowledgeTreeNode) => {`,
  `  const createFromPluginTemplate = useCallback(async (pluginId: string, templateId: string, values: Record<string, unknown>) => {\n    const targetParentId = templatePicker?.parentId ?? null;\n    const result = await pluginApi.createNoteFromTemplate(pluginId, templateId, { workspaceId: getCurrentWorkspace(), parentId: targetParentId, values });\n    emitTreeChanged("plugin-template-created-quick-browse");\n    await reload();\n    actions.refreshNotebooks();\n    actions.refreshNotes();\n    const node = result.node as KnowledgeTreeNode;\n    rememberOpened(node.id);\n    try { activateNote(await api.getNote(result.noteId), targetParentId); } catch (openError: any) { toast.error(openError?.message || "文档已创建，但自动打开失败"); }\n    toast.success("已从插件模板创建笔记");\n  }, [actions, activateNote, reload, rememberOpened, templatePicker?.parentId]);\n\n  const rename = async (node: KnowledgeTreeNode) => {`,
);
replaceOnce(
  "frontend/src/components/MobileKnowledgeTreePanel.tsx",
  `        onCreate={createFromTemplate}\n      />`,
  `        onCreate={createFromTemplate}\n        onCreatePlugin={createFromPluginTemplate}\n      />`,
);

write("frontend/src/components/PluginPromptPicker.tsx", `import { useCallback, useEffect, useMemo, useState } from "react";\nimport { Sparkles } from "lucide-react";\nimport { pluginApi } from "@/lib/pluginApi";\nimport { listPluginPrompts, renderPluginPrompt, replacePluginPrompts, type RegisteredPluginPrompt } from "@/lib/pluginPromptRegistry";\nimport { useApp } from "@/store/AppContext";\n\nfunction platform(): "web" | "desktop" { return typeof window !== "undefined" && "electronAPI" in window ? "desktop" : "web"; }\n\nexport default function PluginPromptPicker({ onSelect, disabled }: { onSelect: (value: string) => void; disabled?: boolean }) {\n  const { state } = useApp();\n  const [items, setItems] = useState<RegisteredPluginPrompt[]>([]);\n  const [open, setOpen] = useState(false);\n  const load = useCallback(async () => { try { replacePluginPrompts(await pluginApi.contributions()); setItems(listPluginPrompts(platform()).filter((item) => !item.context?.includes("selection"))); } catch { setItems([]); } }, []);\n  useEffect(() => { void load(); }, [load]);\n  const note = state.activeNote as any;\n  const select = async (item: RegisteredPluginPrompt) => {\n    const values: Record<string, unknown> = {};\n    for (const field of item.inputs || []) {\n      const raw = window.prompt(field.label || field.id, field.default == null ? "" : String(field.default));\n      if (raw == null) return;\n      values[field.id] = field.type === "number" ? Number(raw) : field.type === "boolean" ? /^(1|true|yes|是)$/i.test(raw.trim()) : raw;\n    }\n    let prompt = renderPluginPrompt(item, values);\n    const context: string[] = [];\n    if (item.context?.includes("title") && note?.title) context.push(`标题：${note.title}`);\n    if (item.context?.includes("note") && (note?.contentText || note?.content)) context.push(`笔记内容：\\n${String(note.contentText || note.content).slice(0, 12000)}`);\n    if (item.context?.includes("tags") && Array.isArray(note?.tags) && note.tags.length) context.push(`标签：${note.tags.map((tag: any) => tag.name || tag).join(", ")}`);\n    if (context.length) prompt += `\\n\\n以下是 Host 按声明提供的最小上下文：\\n${context.join("\\n\\n")}`;\n    onSelect(prompt); setOpen(false);\n  };\n  if (!items.length) return null;\n  return <div className="relative">\n    <button type="button" disabled={disabled} onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-violet-500 hover:bg-violet-500/10 disabled:opacity-50"><Sparkles size={11} />Prompt Pack</button>\n    {open && <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-app-border bg-app-surface p-1.5 shadow-xl">{items.map((item) => <button key={item.runtimeId} type="button" onClick={() => void select(item)} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-app-hover"><span className="block text-xs font-medium text-tx-primary">{item.name}</span><span className="mt-0.5 block text-[10px] text-tx-tertiary">{item.description || item.pluginId}</span></button>)}</div>}\n  </div>;\n}\n`);

// Prompt Pack becomes a real AI Chat input source.
replaceOnce(
  "frontend/src/components/AIChatPanel.tsx",
  `import AIKnowledgeScopePicker from "@/components/AIKnowledgeScopePicker";`,
  `import AIKnowledgeScopePicker from "@/components/AIKnowledgeScopePicker";\nimport PluginPromptPicker from "@/components/PluginPromptPicker";`,
);
replaceOnce(
  "frontend/src/components/AIChatPanel.tsx",
  `              <span className="ml-auto hidden text-tx-tertiary lg:inline">Enter 发送 · Shift + Enter 换行</span>`,
  `              <PluginPromptPicker disabled={isLoading} onSelect={(value) => { setInput(value); requestAnimationFrame(() => inputRef.current?.focus()); }} />\n              <span className="ml-auto hidden text-tx-tertiary lg:inline">Enter 发送 · Shift + Enter 换行</span>`,
);

write("frontend/src/components/settings/PluginPromptPackSettingsSection.tsx", `import { useEffect, useState } from "react";\nimport { Sparkles } from "lucide-react";\nimport { pluginApi } from "@/lib/pluginApi";\nimport { listPluginPrompts, replacePluginPrompts, type RegisteredPluginPrompt } from "@/lib/pluginPromptRegistry";\nexport default function PluginPromptPackSettingsSection() {\n  const [items, setItems] = useState<RegisteredPluginPrompt[]>([]);\n  useEffect(() => { void pluginApi.contributions().then((records) => { replacePluginPrompts(records); setItems(listPluginPrompts()); }).catch(() => setItems([])); }, []);\n  if (!items.length) return null;\n  return <section className="rounded-xl border border-app-border bg-app-surface p-4"><div className="mb-3 flex items-center gap-2"><Sparkles size={16} className="text-violet-500"/><div><div className="text-sm font-semibold text-tx-primary">来自插件的 Prompt Pack</div><div className="text-[11px] text-tx-tertiary">只声明 Prompt 和最小上下文，不会获得你的 AI Key。</div></div></div><div className="grid gap-2 sm:grid-cols-2">{items.map((item) => <div key={item.runtimeId} className="rounded-lg border border-app-border bg-app-bg/40 p-3"><div className="text-xs font-medium text-tx-primary">{item.name}</div><div className="mt-1 text-[10px] text-tx-tertiary">{item.description || item.pluginId}</div><div className="mt-2 text-[9px] text-tx-tertiary">上下文：{item.context?.join(" · ") || "无"}</div></div>)}</div></section>;\n}\n`);
replaceOnce(
  "frontend/src/components/AISettingsPanel.tsx",
  `import { cn } from "@/lib/utils";`,
  `import { cn } from "@/lib/utils";\nimport PluginPromptPackSettingsSection from "@/components/settings/PluginPromptPackSettingsSection";`,
);
replaceOnce(
  "frontend/src/components/AISettingsPanel.tsx",
  `      </div>\n    </div>\n  );\n}`,
  `      </div>\n      <PluginPromptPackSettingsSection />\n    </div>\n  );\n}`,
);

// Tests for host-owned creation and context minimization.
write("backend/tests/productivity-contribution-host.test.ts", `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { renderPromptPackContribution, selectPromptContext } from "../src/plugins/contributions/promptPackContribution.js";\n\ntest("Prompt Pack exposes only declared host context", () => {\n  const contribution = { id: "summary", name: "Summary", prompt: "{{tone}}", inputs: [{ id: "tone", type: "string", default: "clear" }], context: ["title", "note"] } as const;\n  assert.equal(renderPromptPackContribution(contribution as any, {}), "clear");\n  assert.deepEqual(selectPromptContext(contribution as any, { title: "T", note: "N", selection: "SECRET", tags: ["x"] }), { title: "T", note: "N" });\n});\n`);

// Extend official V2.1 release gate.
let ci = read(".github/workflows/extension-v2-1-ci.yml");
ci = ci.replaceAll(`      - "examples/plugins/theme-pack/**"`, `      - "examples/plugins/theme-pack/**"\n      - "examples/plugins/productivity-pack/**"\n      - "backend/tests/productivity-contribution*.test.ts"\n      - "frontend/src/lib/pluginTemplateRegistry.ts"\n      - "frontend/src/lib/pluginPromptRegistry.ts"\n      - "frontend/src/lib/__tests__/pluginProductivityRegistry.test.ts"\n      - "frontend/src/components/PluginNoteTemplatePickerSection.tsx"\n      - "frontend/src/components/PluginPromptPicker.tsx"\n      - "frontend/src/components/settings/PluginPromptPackSettingsSection.tsx"`);
ci = ci.replace(`      - name: Install backend dependencies`, `      - name: Validate and pack official Productivity Pack\n        working-directory: examples/plugins/productivity-pack\n        run: |\n          node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs validate\n          node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs doctor\n          node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack\n      - name: Install backend dependencies`);
ci = ci.replace(`          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/appearance-contribution.test.ts\n          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/note-appearance.test.ts`, `          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/appearance-contribution.test.ts\n          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/note-appearance.test.ts\n          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/productivity-contribution.test.ts\n          node --import tsx --import ./tests/setup-db-isolation.ts --test tests/productivity-contribution-host.test.ts`);
ci = ci.replace(`      - name: Frontend production build`, `      - name: Productivity contribution registry\n        working-directory: frontend\n        run: npx vitest run src/lib/__tests__/pluginProductivityRegistry.test.ts --reporter=verbose\n      - name: Frontend production build`);
write(".github/workflows/extension-v2-1-ci.yml", ci);

console.log("Productivity Pack Host integration finalized");
