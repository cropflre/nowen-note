import crypto from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/schema.js";
import type { PluginExecutionContext } from "./types.js";
import { getApplicationV3FeatureFlags } from "./applicationV3.js";

export const COLLECTION_PREFIX = "__nowen_collection__:";
export const PLUGIN_SCOPE_BYTES = 192 * 1024;
const name = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fields = z.record(z.unknown());
const record = z.object({ id, value: fields, revision: integer.positive(), updatedAt: z.string() }).strict();
const state = z.object({ schemaVersion: integer.positive(), revision: integer, records: z.array(record).max(100), backup: z.object({ schemaVersion: integer.positive(), records: z.array(record).max(100) }).strict().optional() }).strict().superRefine((value, context) => {
  for (const rows of [value.records, value.backup?.records || []]) {
    if (new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => row.revision > value.revision)) context.addIssue({ code: z.ZodIssueCode.custom, message: "集合记录 ID 或修订无效" });
  }
});
type State = z.infer<typeof state>;
function fail(code = "PLUGIN_DATA_INVALID"): never { throw Object.assign(new Error(code), { code }); }
function json(value: unknown): string {
  const walk = (value: unknown, depth: number): void => {
    if (depth > 16) fail();
    if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object" || Object.keys(value).length > 1000) fail();
    for (const key of Object.keys(value)) { if (["__proto__", "constructor", "prototype"].includes(key)) fail(); walk((value as any)[key], depth + 1); }
  };
  walk(value, 0); return JSON.stringify(value);
}
export function pluginDataScope(context: PluginExecutionContext): [string, string, string] {
  return [context.pluginId, context.workspaceId ? "workspace" : "user", context.workspaceId || context.userId];
}
export function checkPluginStorageQuota(context: PluginExecutionContext, key: string, serialized: string): void {
  const rows = getDb().prepare("SELECT key,value FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=?").all(...pluginDataScope(context)) as Array<{ key: string; value: string }>;
  if (rows.length >= 1000 && !rows.some(row => row.key === key)) fail("PLUGIN_DATA_QUOTA_EXCEEDED");
  const total = rows.filter(row => row.key !== key).reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.key)) + Buffer.byteLength(row.value), Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(serialized));
  if (total > PLUGIN_SCOPE_BYTES) fail("PLUGIN_DATA_QUOTA_EXCEEDED");
}

export function callPluginDataV3(context: PluginExecutionContext, operation: string, input: Record<string, unknown>): unknown {
  if (!getApplicationV3FeatureFlags().pluginData) fail("PLUGIN_DATA_DISABLED");
  const db = getDb(), scope = pluginDataScope(context);
  const rows = () => db.prepare("SELECT key,value FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=? ORDER BY key").all(...scope) as Array<{ key: string; value: string }>;
  const digest = () => crypto.createHash("sha256").update(JSON.stringify(rows())).digest("hex");
  const put = (key: string, value: string) => db.prepare(`INSERT INTO plugin_storage(pluginId,scopeType,scopeId,key,value,updatedAt) VALUES (?,?,?,?,?,?)
    ON CONFLICT(pluginId,scopeType,scopeId,key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`).run(...scope, key, value, new Date().toISOString());
  try {
    if (operation === "export") {
      z.object({}).strict().parse(input);
      return { format: 1, pluginId: context.pluginId, digest: digest(), entries: rows().map(row => ({ key: row.key, value: JSON.parse(row.value) })) };
    }
    if (operation === "import") {
      const args = z.object({ expectedDigest: z.string(), snapshot: z.object({ format: z.literal(1), pluginId: z.literal(context.pluginId), digest: z.string(), entries: z.array(z.object({ key: z.string().min(1).max(200), value: z.unknown() }).strict()).max(1000) }).strict() }).strict().parse(input);
      return db.transaction(() => {
        if (args.expectedDigest !== digest()) fail("PLUGIN_DATA_CONFLICT");
        const unique = new Set<string>(); let total = 0;
        const imported = args.snapshot.entries.map(entry => {
          if (unique.has(entry.key)) fail(); unique.add(entry.key);
          if (entry.key.startsWith(COLLECTION_PREFIX)) {
            name.parse(entry.key.slice(COLLECTION_PREFIX.length));
            const restored = state.parse(entry.value);
            const current = db.prepare("SELECT value FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=? AND key=?").get(...scope, entry.key) as { value: string } | undefined;
            const previous = current ? state.parse(JSON.parse(current.value)) : null;
            restored.revision = Math.max(restored.revision, previous?.revision || 0) + 1;
            restored.records.forEach(row => { row.revision = restored.revision; });
            state.parse(restored);
            for (const row of [...restored.records, ...(restored.backup?.records || [])]) if (Buffer.byteLength(json(row.value)) > 4096) fail("PLUGIN_DATA_QUOTA_EXCEEDED");
            entry.value = restored;
          }
          const value = json(entry.value); total += Buffer.byteLength(JSON.stringify(entry.key)) + Buffer.byteLength(value);
          if (entry.key.startsWith(COLLECTION_PREFIX) && Buffer.byteLength(value) > 48 * 1024) fail("PLUGIN_DATA_QUOTA_EXCEEDED");
          return { key: entry.key, value };
        });
        if (total > PLUGIN_SCOPE_BYTES) fail("PLUGIN_DATA_QUOTA_EXCEEDED");
        db.prepare("DELETE FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=?").run(...scope);
        imported.forEach(row => put(row.key, row.value));
        return { success: true, digest: digest() };
      })();
    }
    const common = { collection: name };
    const schemas: Record<string, z.ZodTypeAny> = {
      query: z.object({ ...common, where: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).optional(), orderBy: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/).optional(), descending: z.boolean().optional(), offset: integer.max(100).optional(), limit: integer.min(1).max(10).optional() }).strict(),
      get: z.object({ ...common, id }).strict(),
      put: z.object({ ...common, id, value: fields, schemaVersion: integer.positive(), expectedRevision: integer }).strict(),
      delete: z.object({ ...common, id, schemaVersion: integer.positive(), expectedRevision: integer.positive() }).strict(),
      migrate: z.object({ ...common, expectedRevision: integer, fromVersion: integer.positive(), toVersion: integer.positive(), defaults: fields }).strict(),
      restore: z.object({ ...common, expectedRevision: integer }).strict(),
    };
    const schema = schemas[operation]; if (!schema) fail();
    const args = schema.parse(input);
    return db.transaction(() => {
      const key = COLLECTION_PREFIX + args.collection;
      const raw = db.prepare("SELECT value FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=? AND key=?").get(...scope, key) as { value: string } | undefined;
      const current: State = raw ? state.parse(JSON.parse(raw.value)) : { schemaVersion: 1, revision: 0, records: [] };
      const summary = () => ({ schemaVersion: current.schemaVersion, revision: current.revision, total: current.records.length, items: current.records.slice(0, 10) });
      if (operation === "get") return { schemaVersion: current.schemaVersion, revision: current.revision, item: current.records.find(row => row.id === args.id) || null };
      if (operation === "query") {
        let items = current.records.filter(row => Object.entries(args.where || {}).every(([key, value]) => Object.hasOwn(row.value, key) && row.value[key] === value));
        if (args.orderBy) items = [...items].sort((a, b) => {
          const left = args.orderBy === "updatedAt" ? a.updatedAt : a.value[args.orderBy];
          const right = args.orderBy === "updatedAt" ? b.updatedAt : b.value[args.orderBy];
          const comparison = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
          return (args.descending ? -comparison : comparison) || a.id.localeCompare(b.id);
        });
        return { ...summary(), total: items.length, items: items.slice(args.offset || 0, (args.offset || 0) + (args.limit || 10)) };
      }
      if (args.schemaVersion !== undefined && args.schemaVersion !== current.schemaVersion) fail("PLUGIN_DATA_CONFLICT");
      let result: unknown;
      if (operation === "put" || operation === "delete") {
        const existing = current.records.find(row => row.id === args.id);
        if ((existing?.revision || 0) !== args.expectedRevision) fail("PLUGIN_DATA_CONFLICT");
        current.records = current.records.filter(row => row.id !== args.id);
        if (operation === "put") {
          if (Buffer.byteLength(json(args.value)) > 4096 || current.records.length >= 100) fail("PLUGIN_DATA_QUOTA_EXCEEDED");
          const next = { id: args.id, value: args.value, revision: current.revision + 1, updatedAt: new Date().toISOString() };
          current.records.push(next); result = next;
        } else result = { success: true };
      } else {
        if (current.revision !== args.expectedRevision) fail("PLUGIN_DATA_CONFLICT");
        const backup = { schemaVersion: current.schemaVersion, records: structuredClone(current.records) };
        if (operation === "migrate") {
          if (args.fromVersion !== current.schemaVersion || args.toVersion !== current.schemaVersion + 1) fail("PLUGIN_DATA_CONFLICT");
          json(args.defaults);
          current.schemaVersion = args.toVersion;
          current.records.forEach(row => { row.value = { ...args.defaults, ...row.value }; row.revision++; });
        } else {
          if (!current.backup) fail("PLUGIN_DATA_BACKUP_MISSING");
          current.schemaVersion = current.backup.schemaVersion;
          current.records = current.backup.records.map(row => ({ ...row, revision: Math.max(row.revision, backup.records.find(other => other.id === row.id)?.revision || 0) + 1 }));
        }
        current.backup = backup;
      }
      current.revision++;
      state.parse(current);
      if (current.records.some(row => Buffer.byteLength(json(row.value)) > 4096)) fail("PLUGIN_DATA_QUOTA_EXCEEDED");
      const serialized = json(current);
      if (Buffer.byteLength(serialized) > 48 * 1024) fail("PLUGIN_DATA_QUOTA_EXCEEDED");
      checkPluginStorageQuota(context, key, serialized); put(key, serialized);
      return result || summary();
    })();
  } catch (error) { if (error instanceof z.ZodError) fail(); throw error; }
}
