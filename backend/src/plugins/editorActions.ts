import { z } from "zod";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import { canViewNoteThroughFolderPasswords } from "../lib/knowledgeTreePasswordAccess.js";
import { isEncryptedNoteFormat } from "../lib/encryptedNotes.js";
import { resolveUserChatSettings } from "../services/user-chat-settings.js";
import { hasAIAuth } from "../services/ai-provider-config.js";
import { callAIChat, type AISettings, type CallAIOptions, type ChatMessage } from "../services/ai-client.js";
import { getExtensionPlatformFeatureFlags } from "./featureFlags.js";
import { EDITOR_ACTION_LIMITS, validateActionInput } from "./manifest.js";
import type { PluginEditorActionContribution, PluginManifest, PluginManifestV2Executable, PluginRegistryRecord } from "./types.js";

export interface EditorActionResult { text?: string; message?: string; aiGenerated?: true; executionId?: string }

export interface EditorActionHost {
  record(pluginId: string): PluginRegistryRecord | undefined;
  granted(pluginId: string): boolean;
  execute(input: {
    pluginId: string; actionId: string; userId: string; workspaceId: string | null; actionInput: Record<string, unknown>;
    timeoutMs: number; persistLogs: false; executionContext: { source: "user"; sourceId: string };
  }): Promise<{ executionId: string; result: unknown }>;
}

/** Test seam for prompt actions; production uses the same services as the AI writing assistant. */
export const editorActionDeps = {
  settings: (userId: string): AISettings => resolveUserChatSettings(userId),
  ai: (settings: AISettings, messages: ChatMessage[], options: CallAIOptions): Promise<string> => callAIChat(settings, messages, options),
};

const requestSchema = z.object({
  noteId: z.string().min(1).max(128),
  editor: z.enum(EDITOR_ACTION_LIMITS.editors),
  text: z.string().optional(),
}).strict();

// Same system prompt as POST /api/ai/chat so prompt actions behave like the writing assistant.
const WRITING_SYSTEM_PROMPT = "你是一个专业的写作助手，帮助用户优化笔记内容。请直接输出结果，不要添加额外的解释或前缀。";
// Opening fence of an encrypted block (fences may sit in quotes or list items).
const ENCRYPTED_FENCE = /(?:^|\n)[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:`{3,}|~{3,})[ \t]*nowen-encrypted/i;
const MAX_RUNNING_PER_USER = 2;
const running = new Map<string, number>();

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function protectedNote(noteId: string, userId: string, write: boolean): { workspaceId: string | null } {
  const db = getDb();
  const note = db.prepare("SELECT workspaceId, notebookId, isTrashed, isLocked, contentFormat FROM notes WHERE id = ?")
    .get(noteId) as { workspaceId: string | null; notebookId: string; isTrashed: number; isLocked: number; contentFormat: string } | undefined;
  // Missing and inaccessible notes share one answer so note IDs cannot be probed.
  if (!note || note.isTrashed || !hasPermission(resolveNotePermission(noteId, userId).permission, write ? "write" : "read")) {
    fail("PLUGIN_EDITOR_NOTE_FORBIDDEN", "没有权限在这篇笔记中运行编辑器动作");
  }
  if (note.isLocked || isEncryptedNoteFormat(note.contentFormat) || !canViewNoteThroughFolderPasswords(db, noteId, new Set())
    || db.prepare("SELECT 1 FROM notebook_passwords WHERE notebookId = ?").get(note.notebookId)) {
    fail("PLUGIN_EDITOR_NOTE_PROTECTED", "锁定、加密或受密码保护的内容不会发送给编辑器动作");
  }
  return { workspaceId: note.workspaceId };
}

function normalizeResult(action: PluginEditorActionContribution, raw: unknown): { text?: string; message?: string } {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!value) fail("PLUGIN_EDITOR_ACTION_INVALID_RESULT", "编辑器动作返回的结果无效");
  if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 500)) fail("PLUGIN_EDITOR_ACTION_INVALID_RESULT", "编辑器动作返回的提示无效");
  const message = value.message ? { message: value.message as string } : {};
  if (action.resultMode === "none") return message;
  if (typeof value.text !== "string" || !value.text.trim()) fail("PLUGIN_EDITOR_ACTION_INVALID_RESULT", "编辑器动作没有返回文本");
  if (Buffer.byteLength(value.text, "utf8") > EDITOR_ACTION_LIMITS.maxResultBytes) fail("PLUGIN_EDITOR_ACTION_INVALID_RESULT", "编辑器动作返回的文本过长");
  // A forged encrypted fence would make the note unsavable, so it never reaches the editor.
  if (ENCRYPTED_FENCE.test(value.text)) fail("PLUGIN_EDITOR_ACTION_INVALID_RESULT", "编辑器动作返回了不允许的内容");
  return { text: value.text, ...message };
}

/** The sandbox wraps plain return values as { success: true, data }; an explicit failure is never applied. */
function payloadOf(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as { success?: unknown; data?: unknown; text?: unknown; error?: unknown };
  if (value.success === false) fail("PLUGIN_EDITOR_ACTION_INVALID_RESULT", typeof value.error === "string" && value.error ? value.error.slice(0, 200) : "编辑器动作执行失败");
  if (value.data !== undefined) return value.data;
  return value.text === undefined ? raw : { text: value.text };
}

function renderPrompt(prompt: NonNullable<NonNullable<PluginManifestV2Executable["contributes"]>["promptPacks"]>[number]): string {
  return prompt.prompt.replace(/\{\{\s*([a-z][a-z0-9_-]{0,63})\s*\}\}/gi, (all, key: string) => {
    const value = prompt.inputs?.find((field) => field.id === key)?.default;
    return value === undefined || value === null ? all : String(value);
  });
}

async function runPrompt(manifest: PluginManifestV2Executable, action: PluginEditorActionContribution, userId: string, text: string, signal?: AbortSignal) {
  const prompt = manifest.contributes?.promptPacks?.find((item) => item.id === action.prompt);
  if (!prompt) fail("PLUGIN_EDITOR_ACTION_NOT_FOUND", "编辑器动作引用的 Prompt 不存在");
  let settings: AISettings;
  try { settings = editorActionDeps.settings(userId); } catch (error) {
    fail("PLUGIN_EDITOR_AI_NOT_CONFIGURED", (error as Error).message || "请先在设置中开启并配置 AI 模型");
  }
  if (!settings.ai_api_url || !hasAIAuth(settings)) fail("PLUGIN_EDITOR_AI_NOT_CONFIGURED", "请先在设置中配置 AI 模型");
  const messages = [
    { role: "system", content: WRITING_SYSTEM_PROMPT },
    { role: "user", content: `${renderPrompt(prompt)}\n\n${text}` },
  ];
  try {
    return await editorActionDeps.ai(settings, messages, { temperature: 0.7, max_tokens: 4000, timeout_ms: 60_000, signal });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") fail("PLUGIN_TIMEOUT", "AI 响应超时或已取消");
    fail("PLUGIN_EDITOR_AI_FAILED", (error as Error)?.message || "AI 请求失败");
  }
}

/**
 * Runs one declared editor action for the selection the user explicitly submitted.
 * The host checks the gate, plugin, grants, editor kind, note ACL and protection before any text leaves;
 * note content is never logged and the editor applies the result in its own transaction.
 */
export async function runEditorAction(host: EditorActionHost, input: { pluginId: string; actionId: string; userId: string; body: unknown; signal?: AbortSignal }): Promise<EditorActionResult> {
  if (!getExtensionPlatformFeatureFlags().editorActions) fail("PLUGIN_EDITOR_ACTIONS_DISABLED", "编辑器扩展当前未启用");
  const parsed = requestSchema.safeParse(input.body);
  if (!parsed.success) fail("PLUGIN_EDITOR_ACTION_UNSUPPORTED", "编辑器动作请求无效");
  const record = host.record(input.pluginId);
  const parsedManifest = record?.status === "enabled" ? JSON.parse(record.manifestJson) as PluginManifest : null;
  const manifest = parsedManifest?.apiVersion === 2 && parsedManifest.runtime !== "declarative" ? parsedManifest : null;
  const action = manifest?.contributes?.editorActions?.find((item) => item.id === input.actionId);
  if (!manifest || !action) fail("PLUGIN_EDITOR_ACTION_NOT_FOUND", "编辑器动作不存在或插件未启用");
  if (!host.granted(input.pluginId)) fail("PLUGIN_PERMISSION_DENIED", "插件声明的权限尚未全部授予");
  if (!action.appliesTo.includes(parsed.data.editor)) fail("PLUGIN_EDITOR_ACTION_UNSUPPORTED", "此动作不支持当前编辑器");

  const note = protectedNote(parsed.data.noteId, input.userId, action.resultMode !== "none");
  // Actions that do not read the selection never receive any note text.
  const text = action.selectionMode === "none" ? "" : parsed.data.text ?? "";
  if (action.selectionMode === "text" && !text.trim()) fail("PLUGIN_EDITOR_ACTION_UNSUPPORTED", "请先选中要处理的文字");
  if (Buffer.byteLength(text, "utf8") > EDITOR_ACTION_LIMITS.maxInputBytes) fail("PLUGIN_INPUT_TOO_LARGE", "选中的内容超过编辑器动作上限");
  if (ENCRYPTED_FENCE.test(text)) fail("PLUGIN_EDITOR_NOTE_PROTECTED", "选区包含加密内容，不能发送给编辑器动作");

  const count = running.get(input.userId) || 0;
  if (count >= MAX_RUNNING_PER_USER) fail("PLUGIN_EDITOR_ACTION_BUSY", "已有编辑器动作正在运行，请稍后再试");
  running.set(input.userId, count + 1);
  try {
    if (action.prompt) {
      return { ...normalizeResult(action, { text: await runPrompt(manifest, action, input.userId, text, input.signal) }), aiGenerated: true };
    }
    const command = manifest.contributes?.commands?.find((item) => item.id === action.command);
    const pluginAction = command && manifest.actions.find((item) => item.id === command.action);
    if (!pluginAction) fail("PLUGIN_EDITOR_ACTION_NOT_FOUND", "编辑器动作引用的 Command 不存在");
    const actionInput = validateActionInput(pluginAction, action.selectionMode === "none" ? {} : { text });
    const execution = await host.execute({
      pluginId: input.pluginId, actionId: pluginAction.id, userId: input.userId, workspaceId: note.workspaceId, actionInput,
      timeoutMs: 10_000, persistLogs: false, executionContext: { source: "user", sourceId: "editor-action" },
    });
    return { ...normalizeResult(action, payloadOf(execution.result)), executionId: execution.executionId };
  } finally {
    const left = (running.get(input.userId) || 1) - 1;
    if (left > 0) running.set(input.userId, left); else running.delete(input.userId);
  }
}
