import path from "node:path";
import { z } from "zod";
import { isExtensionV21Enabled } from "./featureFlags.js";
import { isV2SupportedPluginPermission } from "./hostApiContract.js";
import { NOWEN_VERSION, PLUGIN_PERMISSIONS, type PluginActionManifest, type PluginManifest, type PluginManifestV1, type PluginManifestV2 } from "./types.js";

const inputFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean().optional(),
  description: z.string().max(500).optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).optional(),
  default: z.unknown().optional(),
}).strict();

const actionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  execution: z.enum(["interactive", "background"]).default("interactive"),
  idempotent: z.boolean().optional(),
  retryable: z.boolean().optional(),
  input: z.record(inputFieldSchema).default({}),
}).strict();

const connectionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(100),
  type: z.enum(["bearer", "api-key-header", "basic"]),
  headerName: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
}).strict();

export const pluginManifestV1Schema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/).max(150),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(""),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  apiVersion: z.literal(1),
  engines: z.object({ nowen: z.string().min(1).max(100) }).strict(),
  runtime: z.literal("node-action"),
  main: z.string().min(1).max(300),
  author: z.object({ name: z.string().min(1).max(100), url: z.string().url().optional() }).strict().optional(),
  category: z.string().min(1).max(50).optional(),
  keywords: z.array(z.string().min(1).max(50)).max(20).optional(),
  repository: z.string().url().optional(),
  homepage: z.string().url().optional(),
  license: z.string().min(1).max(100).optional(),
  icon: z.string().min(1).max(300).optional(),
  screenshots: z.array(z.string().min(1).max(300)).max(10).optional(),
  connections: z.array(connectionSchema).max(20).optional(),
  output: z.record(z.unknown()).optional(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(32).default([]),
  permissionConfig: z.object({ externalFetchHosts: z.array(z.string().min(1).max(253)).max(50).optional() }).strict().optional(),
  actions: z.array(actionSchema).min(1).max(50),
  events: z.array(z.string().min(1).max(100)).max(50).optional(),
  eventHandlers: z.array(z.object({ event: z.string().min(1).max(100), action: z.string().min(1).max(64) }).strict()).max(50).optional(),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.actions.map((action) => action.id)).size !== manifest.actions.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "Action id 不能重复" });
  if (manifest.connections && new Set(manifest.connections.map((connection) => connection.id)).size !== manifest.connections.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connections"], message: "Connection id 不能重复" });
  if (manifest.connections?.length && !manifest.permissions.includes("secrets:use")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["permissions"], message: "声明 connections 必须请求 secrets:use" });
  for (const connection of manifest.connections || []) {
    if (connection.type === "api-key-header" && connection.headerName && /^(authorization|cookie|proxy-authorization)$/i.test(connection.headerName)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connections", connection.id, "headerName"], message: "API Key Header 名称不安全" });
  }
  const normalized = manifest.main.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["main"], message: "main 必须位于插件目录内" });
});

const commandSchema = z.object({ id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/), title: z.string().min(1).max(100), action: z.string().min(1).max(64), category: z.string().max(50).optional() }).strict();
const menuSchema = z.object({
  location: z.enum(["commandPalette", "note.contextMenu", "notebook.contextMenu", "editor.toolbar.actions", "attachment.contextMenu", "task.contextMenu", "settings.plugin", "automation.template"]),
  command: z.string().min(1).max(150),
}).strict();
const settingSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), title: z.string().min(1).max(100),
  type: z.enum(["string", "number", "boolean", "select"]), description: z.string().max(500).optional(),
  options: z.array(z.union([z.string(), z.number()])).max(100).optional(), default: z.union([z.string(), z.number(), z.boolean()]).optional(), secret: z.boolean().optional(),
}).strict();
const automationTemplateSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), title: z.string().min(1).max(100), file: z.string().min(1).max(300), description: z.string().max(500).optional() }).strict();
const noteThemeColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, "Note Theme 颜色必须是 #RRGGBB 或 #RRGGBBAA");
const noteThemeTokensSchema = z.object({
  canvasBackground: noteThemeColorSchema.optional(), contentBackground: noteThemeColorSchema.optional(),
  contentText: noteThemeColorSchema.optional(), mutedText: noteThemeColorSchema.optional(), headingText: noteThemeColorSchema.optional(),
  linkColor: noteThemeColorSchema.optional(), linkWeight: z.number().int().min(400).max(700).optional(),
  quoteBackground: noteThemeColorSchema.optional(), quoteBorder: noteThemeColorSchema.optional(),
  tableBorder: noteThemeColorSchema.optional(), tableHeaderBackground: noteThemeColorSchema.optional(), tableStripeBackground: noteThemeColorSchema.optional(),
  codeBackground: noteThemeColorSchema.optional(), inlineCodeBackground: noteThemeColorSchema.optional(),
  contentMaxWidth: z.number().int().min(480).max(1200).optional(),
  contentPaddingInline: z.number().min(16).max(96).optional(), contentPaddingBlock: z.number().min(16).max(120).optional(),
  fontCategory: z.enum(["system", "sans", "serif", "mono"]).optional(),
  fontSize: z.number().min(12).max(24).optional(), lineHeight: z.number().min(1.2).max(2.2).optional(),
  letterSpacing: z.number().min(-0.5).max(2).optional(), paragraphSpacing: z.number().min(0).max(32).optional(),
  radius: z.number().min(0).max(24).optional(), controlBackground: noteThemeColorSchema.optional(), controlBorder: noteThemeColorSchema.optional(),
}).strict().superRefine((tokens, ctx) => {
  if (Object.keys(tokens).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Note Theme token 不能为空" });
});
const noteThemeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: z.string().min(1).max(100),
  description: z.string().max(500).optional(), base: z.literal("nowen.default").default("nowen.default"),
  modes: z.object({ light: noteThemeTokensSchema, dark: noteThemeTokensSchema.optional() }).strict(),
}).strict();

const v2BaseShape = {
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/).max(150),
  name: z.string().min(1).max(100), description: z.string().max(1000).default(""),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/), apiVersion: z.literal(2),
  publisher: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/), engines: z.object({ nowen: z.string().min(1).max(100) }).strict(),
  categories: z.array(z.string().min(1).max(50)).min(1).max(10), keywords: z.array(z.string().min(1).max(50)).max(20).optional(),
  repository: z.string().url(), homepage: z.string().url().optional(), license: z.string().min(1).max(100),
  icon: z.string().min(1).max(300).optional(), screenshots: z.array(z.string().min(1).max(300)).max(10).optional(),
  platforms: z.array(z.enum(["server", "desktop-full"])).min(1).max(2).optional(),
  runtimePlatform: z.array(z.enum(["server", "desktop-full"])).min(1).max(2).optional(),
  uiPlatform: z.array(z.enum(["web", "desktop", "android", "ios"])).max(4).optional(),
  output: z.record(z.unknown()).optional(),
  permissionConfig: z.object({ externalFetchHosts: z.array(z.string().min(1).max(253)).max(50).optional() }).strict().optional(),
  extensionDependencies: z.record(z.string().min(1).max(100)).optional(),
};

const executableContributesSchema = z.object({
  commands: z.array(commandSchema).max(100).optional(), menus: z.array(menuSchema).max(100).optional(),
  settings: z.array(settingSchema).max(100).optional(), automationTemplates: z.array(automationTemplateSchema).max(50).optional(),
  noteThemes: z.array(noteThemeSchema).max(20).optional(),
}).strict().optional();

const declarativeContributesSchema = z.object({
  settings: z.array(settingSchema).max(100).optional(),
  automationTemplates: z.array(automationTemplateSchema).max(50).optional(),
  noteThemes: z.array(noteThemeSchema).max(20).optional(),
}).strict().superRefine((contributes, ctx) => {
  if (!(contributes.settings?.length || contributes.automationTemplates?.length || contributes.noteThemes?.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "声明式插件必须至少提供一个静态 Contribution" });
  }
  if (contributes.settings?.some((setting) => setting.secret)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: "声明式插件不能声明 Secret Setting" });
  }
});

const executableV2Schema = z.object({
  ...v2BaseShape,
  runtime: z.enum(["sandbox-js", "node-action"]), main: z.string().min(1).max(300),
  connections: z.array(connectionSchema).max(20).optional(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(32).default([]),
  actions: z.array(actionSchema).min(1).max(50), events: z.array(z.string().min(1).max(100)).max(50).optional(),
  eventHandlers: z.array(z.object({ event: z.string().min(1).max(100), action: z.string().min(1).max(64) }).strict()).max(50).optional(),
  contributes: executableContributesSchema,
}).strict();

const declarativeV2Schema = z.object({
  ...v2BaseShape,
  runtime: z.literal("declarative"),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(0).default([]),
  contributes: declarativeContributesSchema,
}).strict();

export const pluginManifestV2Schema = z.union([executableV2Schema, declarativeV2Schema]).superRefine((manifest, ctx) => {
  if (!manifest.id.startsWith(`${manifest.publisher}.`)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "插件 ID 必须位于 Publisher namespace" });
  const noteThemeIds = (manifest.contributes?.noteThemes || []).map((theme) => theme.id);
  if (new Set(noteThemeIds).size !== noteThemeIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "noteThemes"], message: "Note Theme id 不能重复" });
  for (const [index, permission] of manifest.permissions.entries()) {
    if (!isV2SupportedPluginPermission(permission)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["permissions", index], message: permission === "attachments:write" ? "Plugin API V2 不支持 attachments:write" : `Plugin API V2 不支持权限 ${permission}` });
  }
  if (manifest.runtime === "declarative") {
    if (manifest.permissionConfig) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["permissionConfig"], message: "声明式插件不能声明权限配置" });
    return;
  }
  if (new Set(manifest.actions.map((action) => action.id)).size !== manifest.actions.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "Action id 不能重复" });
  const actionIds = new Set(manifest.actions.map((action) => action.id));
  for (const command of manifest.contributes?.commands || []) if (!actionIds.has(command.action)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "commands"], message: `Command Action 不存在: ${command.action}` });
  const commandIds = new Set((manifest.contributes?.commands || []).map((command) => command.id));
  for (const menu of manifest.contributes?.menus || []) if (!commandIds.has(menu.command)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "menus"], message: `Menu Command 不存在: ${menu.command}` });
  for (const handler of manifest.eventHandlers || []) if (!actionIds.has(handler.action)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["eventHandlers"], message: `Event Handler Action 不存在: ${handler.action}` });
  if (manifest.connections?.length && !manifest.permissions.includes("secrets:use")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["permissions"], message: "声明 connections 必须请求 secrets:use" });
  const normalized = manifest.main.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["main"], message: "main 必须位于插件目录内" });
  if (manifest.runtime === "sandbox-js" && !normalized.endsWith(".js")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["main"], message: "sandbox-js 入口必须是 .js IIFE bundle" });
});

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** 支持常见的 >=x.y.z、>、<=、< 和空格 AND 组合。 */
export function nowenVersionSatisfies(range: string, current = NOWEN_VERSION): boolean {
  const actual = parseVersion(current);
  if (!actual) return false;
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)/.exec(clause);
    if (!match) return false;
    const expected = parseVersion(match[2]);
    if (!expected) return false;
    const comparison = compareVersion(actual, expected);
    switch (match[1] || "=") {
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      case "^": return actual[0] === expected[0] && comparison >= 0;
      case "~": return actual[0] === expected[0] && actual[1] === expected[1] && comparison >= 0;
      default: return comparison === 0;
    }
  });
}

export interface ParsePluginManifestOptions {
  currentVersion?: string;
  extensionsV21?: boolean;
}

export function parsePluginManifest(value: unknown, options: ParsePluginManifestOptions = {}): PluginManifest {
  const apiVersion = Number((value as { apiVersion?: unknown } | null)?.apiVersion);
  const manifest = (apiVersion === 1 ? pluginManifestV1Schema.parse(value) : apiVersion === 2 ? pluginManifestV2Schema.parse(value) : (() => { throw new Error(`不支持 Plugin API V${apiVersion || "unknown"}`); })()) as PluginManifest;
  if (manifest.apiVersion === 2 && manifest.runtime === "declarative") {
    if (!(options.extensionsV21 ?? isExtensionV21Enabled())) throw Object.assign(new Error("声明式 Extension 当前未启用"), { code: "PLUGIN_V21_FEATURE_DISABLED" });
    if (!nowenVersionSatisfies(manifest.engines.nowen, "1.6.0") || nowenVersionSatisfies(manifest.engines.nowen, "1.5.0")) {
      throw Object.assign(new Error("声明式 Extension 必须要求 engines.nowen >=1.6.0"), { code: "PLUGIN_NOWEN_INCOMPATIBLE" });
    }
  }
  if (manifest.apiVersion === 2 && manifest.contributes?.noteThemes?.length) {
    if (!(options.extensionsV21 ?? isExtensionV21Enabled())) throw Object.assign(new Error("Note Theme Contribution 当前未启用"), { code: "PLUGIN_V21_FEATURE_DISABLED" });
    if (!nowenVersionSatisfies(manifest.engines.nowen, "1.6.0") || nowenVersionSatisfies(manifest.engines.nowen, "1.5.0")) {
      throw Object.assign(new Error("Note Theme Contribution 必须要求 engines.nowen >=1.6.0"), { code: "PLUGIN_NOWEN_INCOMPATIBLE" });
    }
  }
  const currentVersion = options.currentVersion || NOWEN_VERSION;
  if (!nowenVersionSatisfies(manifest.engines.nowen, currentVersion)) throw new Error(`插件要求 Nowen ${manifest.engines.nowen}，当前版本为 ${currentVersion}`);
  return manifest;
}

export function validateActionInput(action: PluginActionManifest, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Action input 必须是对象");
  const result = input as Record<string, unknown>;
  const declared = action.input || {};
  for (const key of Object.keys(result)) if (!declared[key]) throw new Error(`未知参数: ${key}`);
  for (const [key, field] of Object.entries(declared)) {
    const value = result[key];
    if (value === undefined || value === null) {
      if (field.required) throw new Error(`缺少必填参数: ${key}`);
      continue;
    }
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (actualType !== field.type) throw new Error(`参数 ${key} 应为 ${field.type}`);
    if (field.enum && !field.enum.includes(value as never)) throw new Error(`参数 ${key} 不在允许范围内`);
  }
  return result;
}
