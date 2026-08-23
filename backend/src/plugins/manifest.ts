import path from "node:path";
import { z } from "zod";
import { NOWEN_VERSION, PLUGIN_API_VERSION, PLUGIN_PERMISSIONS, type PluginActionManifest, type PluginManifestV1 } from "./types.js";

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
  input: z.record(inputFieldSchema).default({}),
}).strict();

export const pluginManifestV1Schema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/).max(150),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(""),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  apiVersion: z.literal(PLUGIN_API_VERSION),
  engines: z.object({ nowen: z.string().min(1).max(100) }).strict(),
  runtime: z.literal("node-action"),
  main: z.string().min(1).max(300),
  author: z.object({ name: z.string().min(1).max(100), url: z.string().url().optional() }).strict().optional(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(32).default([]),
  permissionConfig: z.object({
    externalFetchHosts: z.array(z.string().min(1).max(253)).max(50).optional(),
  }).strict().optional(),
  actions: z.array(actionSchema).min(1).max(50),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.actions.map((action) => action.id)).size !== manifest.actions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions"], message: "Action id 不能重复" });
  }
  const normalized = manifest.main.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["main"], message: "main 必须位于插件目录内" });
  }
});

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** V1 支持常见的 >=x.y.z、>、<=、< 和空格 AND 组合。 */
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

export function parsePluginManifest(value: unknown): PluginManifestV1 {
  const manifest = pluginManifestV1Schema.parse(value) as PluginManifestV1;
  if (!nowenVersionSatisfies(manifest.engines.nowen)) {
    throw new Error(`插件要求 Nowen ${manifest.engines.nowen}，当前版本为 ${NOWEN_VERSION}`);
  }
  return manifest;
}

export function validateActionInput(action: PluginActionManifest, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Action input 必须是对象");
  }
  const result = input as Record<string, unknown>;
  const declared = action.input || {};
  for (const key of Object.keys(result)) {
    if (!declared[key]) throw new Error(`未知参数: ${key}`);
  }
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
