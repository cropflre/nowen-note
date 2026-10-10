import path from "node:path";
import { z } from "zod";

const PLUGIN_PERMISSIONS = [
  "notes:read", "notes:write", "notebooks:read", "notebooks:write", "tags:read", "tags:write",
  "tasks:read", "tasks:write", "attachments:read", "attachments:write", "diary:read", "diary:write",
  "mindmaps:read", "mindmaps:write", "plugin-storage:read", "plugin-storage:write", "external:fetch", "secrets:use",
] as const;

const V2_SUPPORTED_PERMISSIONS = new Set<string>([
  "attachments:read", "diary:read", "diary:write", "external:fetch", "mindmaps:read", "mindmaps:write",
  "notebooks:read", "notebooks:write", "notes:read", "notes:write", "plugin-storage:read", "plugin-storage:write",
  "secrets:use", "tags:read", "tags:write", "tasks:read", "tasks:write",
]);

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

const commandSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
  title: z.string().min(1).max(100),
  action: z.string().min(1).max(64),
  category: z.string().max(50).optional(),
}).strict();

const menuSchema = z.object({
  location: z.enum(["commandPalette", "note.contextMenu", "notebook.contextMenu", "editor.toolbar.actions", "attachment.contextMenu", "task.contextMenu", "settings.plugin", "automation.template"]),
  command: z.string().min(1).max(150),
}).strict();

const settingSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  title: z.string().min(1).max(100),
  type: z.enum(["string", "number", "boolean", "select"]),
  description: z.string().max(500).optional(),
  options: z.array(z.union([z.string(), z.number()])).max(100).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  secret: z.boolean().optional(),
}).strict();

const automationTemplateSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(100),
  file: z.string().min(1).max(300),
  description: z.string().max(500).optional(),
}).strict();

export const registryManifestV2Schema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/).max(150),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(""),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  apiVersion: z.literal(2),
  publisher: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  engines: z.object({ nowen: z.string().min(1).max(100) }).strict(),
  runtime: z.enum(["sandbox-js", "node-action"]),
  main: z.string().min(1).max(300),
  categories: z.array(z.string().min(1).max(50)).min(1).max(10),
  keywords: z.array(z.string().min(1).max(50)).max(20).optional(),
  repository: z.string().url(),
  homepage: z.string().url().optional(),
  license: z.string().min(1).max(100),
  icon: z.string().min(1).max(300).optional(),
  screenshots: z.array(z.string().min(1).max(300)).max(10).optional(),
  platforms: z.array(z.enum(["server", "desktop-full"])).min(1).max(2).optional(),
  runtimePlatform: z.array(z.enum(["server", "desktop-full"])).min(1).max(2).optional(),
  uiPlatform: z.array(z.enum(["web", "desktop", "android", "ios"])).max(4).optional(),
  connections: z.array(connectionSchema).max(20).optional(),
  output: z.record(z.unknown()).optional(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(32).default([]),
  permissionConfig: z.object({ externalFetchHosts: z.array(z.string().min(1).max(253)).max(50).optional() }).strict().optional(),
  actions: z.array(actionSchema).min(1).max(50),
  events: z.array(z.string().min(1).max(100)).max(50).optional(),
  eventHandlers: z.array(z.object({ event: z.string().min(1).max(100), action: z.string().min(1).max(64) }).strict()).max(50).optional(),
  contributes: z.object({
    commands: z.array(commandSchema).max(100).optional(),
    menus: z.array(menuSchema).max(100).optional(),
    settings: z.array(settingSchema).max(100).optional(),
    automationTemplates: z.array(automationTemplateSchema).max(50).optional(),
  }).strict().optional(),
  extensionDependencies: z.record(z.string().min(1).max(100)).optional(),
}).strict().superRefine((manifest, context) => {
  if (!manifest.id.startsWith(`${manifest.publisher}.`)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "extension id must use publisher namespace" });
  for (const [index, permission] of manifest.permissions.entries()) {
    if (!V2_SUPPORTED_PERMISSIONS.has(permission)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["permissions", index], message: `Plugin API V2 does not support ${permission}` });
  }
  if (new Set(manifest.actions.map((action) => action.id)).size !== manifest.actions.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "action ids must be unique" });
  const actionIds = new Set(manifest.actions.map((action) => action.id));
  for (const command of manifest.contributes?.commands || []) if (!actionIds.has(command.action)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "commands"], message: `command action does not exist: ${command.action}` });
  const commandIds = new Set((manifest.contributes?.commands || []).map((command) => command.id));
  for (const menu of manifest.contributes?.menus || []) if (!commandIds.has(menu.command)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "menus"], message: `menu command does not exist: ${menu.command}` });
  for (const handler of manifest.eventHandlers || []) if (!actionIds.has(handler.action)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["eventHandlers"], message: `event handler action does not exist: ${handler.action}` });
  if (manifest.connections?.length && !manifest.permissions.includes("secrets:use")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["permissions"], message: "connections require secrets:use" });
  const normalized = manifest.main.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["main"], message: "main must remain inside the package" });
  if (manifest.runtime === "sandbox-js" && !normalized.endsWith(".js")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["main"], message: "sandbox-js main must be a .js IIFE bundle" });
});

export type RegistryManifestV2 = z.infer<typeof registryManifestV2Schema>;

export function parseRegistryManifestV2(value: unknown): RegistryManifestV2 {
  return registryManifestV2Schema.parse(value);
}
