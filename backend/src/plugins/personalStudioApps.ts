import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

const valueSchema = z.union([z.string().max(240), z.boolean()]);
const fieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  label: z.string().trim().min(1).max(40),
  type: z.enum(["text", "checkbox"]),
}).strict();
export const personalAppSpecSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(200).default(""),
  layout: z.enum(["list", "board"]),
  fields: z.array(fieldSchema).min(1).max(8),
  items: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    values: z.record(valueSchema),
  }).strict()).max(100),
}).strict().superRefine((spec, ctx) => {
  const fields = new Map(spec.fields.map(field => [field.id, field.type]));
  if (fields.size !== spec.fields.length) ctx.addIssue({ code: "custom", path: ["fields"], message: "DUPLICATE_FIELD" });
  const ids = new Set<string>();
  for (const [index, item] of spec.items.entries()) {
    if (ids.has(item.id)) ctx.addIssue({ code: "custom", path: ["items", index], message: "DUPLICATE_ITEM" });
    ids.add(item.id);
    for (const [key, value] of Object.entries(item.values)) {
      const type = fields.get(key);
      if (!type || (type === "checkbox" ? typeof value !== "boolean" : typeof value !== "string")) {
        ctx.addIssue({ code: "custom", path: ["items", index, "values", key], message: "INVALID_FIELD_VALUE" });
      }
    }
  }
});
export type PersonalAppSpec = z.infer<typeof personalAppSpecSchema>;
export interface PersonalStudioApp {
  id: string;
  spec: PersonalAppSpec;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
type Row = { id: string; specJson: string; revision: number; createdAt: string; updatedAt: string };
function problem(code: string): never { throw Object.assign(new Error(code), { code }); }
function decode(row: Row): PersonalStudioApp {
  return { id: row.id, spec: personalAppSpecSchema.parse(JSON.parse(row.specJson)), revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export function parsePersonalAppSpec(input: unknown): PersonalAppSpec {
  const result = personalAppSpecSchema.safeParse(input);
  if (!result.success) problem("STUDIO_INVALID_SPEC");
  const spec = result.data;
  if (Buffer.byteLength(JSON.stringify(spec), "utf8") > 48 * 1024) problem("STUDIO_SPEC_TOO_LARGE");
  return spec;
}
function actorId(userId: string): string {
  if (!userId || userId.length > 128) problem("RESOURCE_FORBIDDEN");
  return userId;
}
export function listPersonalStudioApps(db: Database.Database, userId: string): PersonalStudioApp[] {
  return (db.prepare("SELECT id, specJson, revision, createdAt, updatedAt FROM personal_studio_apps WHERE userId=? ORDER BY updatedAt DESC LIMIT 32").all(actorId(userId)) as Row[]).map(decode);
}
export function getPersonalStudioApp(db: Database.Database, userId: string, id: string): PersonalStudioApp {
  const row = db.prepare("SELECT id, specJson, revision, createdAt, updatedAt FROM personal_studio_apps WHERE userId=? AND id=?").get(actorId(userId), id) as Row | undefined;
  if (!row) problem("STUDIO_APP_NOT_FOUND");
  return decode(row);
}
export function createPersonalStudioApp(db: Database.Database, userId: string, input: unknown): PersonalStudioApp {
  const spec = parsePersonalAppSpec(input);
  return db.transaction(() => {
    const count = db.prepare("SELECT COUNT(*) AS count FROM personal_studio_apps WHERE userId=?").get(actorId(userId)) as { count: number };
    if (count.count >= 32) problem("STUDIO_APP_LIMIT");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO personal_studio_apps(id, userId, specJson, revision, createdAt, updatedAt) VALUES(?,?,?,?,?,?)")
      .run(id, userId, JSON.stringify(spec), 1, now, now);
    return getPersonalStudioApp(db, userId, id);
  })();
}
export function updatePersonalStudioApp(db: Database.Database, userId: string, id: string, expectedRevision: number, input: unknown): PersonalStudioApp {
  const spec = parsePersonalAppSpec(input);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) problem("STUDIO_INVALID_REVISION");
  const result = db.prepare("UPDATE personal_studio_apps SET specJson=?, revision=revision+1, updatedAt=? WHERE id=? AND userId=? AND revision=?")
    .run(JSON.stringify(spec), new Date().toISOString(), id, actorId(userId), expectedRevision);
  if (!result.changes) { getPersonalStudioApp(db, userId, id); problem("STUDIO_CONFLICT"); }
  return getPersonalStudioApp(db, userId, id);
}
export function deletePersonalStudioApp(db: Database.Database, userId: string, id: string, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) problem("STUDIO_INVALID_REVISION");
  const result = db.prepare("DELETE FROM personal_studio_apps WHERE id=? AND userId=? AND revision=?")
    .run(id, actorId(userId), expectedRevision);
  if (!result.changes) { getPersonalStudioApp(db, userId, id); problem("STUDIO_CONFLICT"); }
}
