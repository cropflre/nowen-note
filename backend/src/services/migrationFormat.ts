import { z } from "zod";

/** NMF v1 is deliberately bounded. Raising limits is a protocol/resource-budget change. */
export const MIGRATION_LIMITS = Object.freeze({
  notes: 10_000,
  files: 20_000,
  uploadBytes: 512 * 1024 * 1024,
  extractedBytes: 1024 * 1024 * 1024,
  temporaryBytes: 2 * 1024 * 1024 * 1024,
  uploadBytesPerSecond: 32 * 1024 * 1024,
  assetBytes: 64 * 1024 * 1024,
  contentBytes: 2 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
  stageItems: 50,
  stageBytes: 8 * 1024 * 1024,
});

export const migrationRelativePathSchema = z.string().min(1).max(512).transform((value) => value.normalize("NFC"))
  .refine((value) => !/[\u0000-\u001f\u007f\\:]/u.test(value)
    && !value.startsWith("/")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    && value.split("/").length <= 32, "Expected a safe relative file path");

const segment = z.string().trim().min(1).max(100).transform((value) => value.normalize("NFC"))
  .refine((value) => !/[\u0000-\u001f\u007f/\\]/u.test(value) && value !== "." && value !== "..", "Invalid folder name");
const identifier = z.string().trim().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const migrationSourceSchema = z.object({
  platform: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).transform((value) => value.toLowerCase()),
  exportId: identifier.pipe(z.string().max(128)),
}).strict();

export const migrationAttachmentSchema = z.object({
  assetId: identifier.pipe(z.string().max(128)),
  path: migrationRelativePathSchema,
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase()),
  mimeType: z.string().max(100).optional(),
  // The source href can contain ../; only `path` is ever used for filesystem access.
  originalPath: z.string().min(1).max(2048).optional(),
}).strict();

const noteFields = {
  title: z.string().trim().min(1).max(500).transform((value) => value.normalize("NFC"))
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
  path: z.array(segment).max(16).default([]),
  contentFormat: z.enum(["markdown", "html", "txt"]),
  createdAt: timestamp.optional(),
  updatedAt: timestamp.optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  attachments: z.array(migrationAttachmentSchema).max(200).default([]),
  links: z.array(z.object({
    href: z.string().min(1).max(2048),
    targetSourceId: identifier.optional(),
    label: z.string().max(500).optional(),
  }).strict()).max(200).default([]),
  metadata: z.unknown().superRefine((value, context) => {
    if (value && typeof value === "object" && Object.keys(value).some((key) => ["__proto__", "constructor", "prototype"].includes(key))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Unsafe metadata keys" });
    }
  }).pipe(z.record(z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()])))
    .default({}).superRefine((value, context) => {
      if (Object.keys(value).length > 32 || Buffer.byteLength(JSON.stringify(value), "utf8") > 16 * 1024
        || Object.keys(value).some((key) => key.length > 100 || ["__proto__", "constructor", "prototype"].includes(key))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Metadata exceeds the NMF v1 budget or contains unsafe keys" });
      }
    }),
};

export const nmfNoteSchema = z.object({
  schemaVersion: z.literal(1),
  source: migrationSourceSchema.extend({ sourceId: identifier }).strict(),
  ...noteFields,
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MIGRATION_LIMITS.contentBytes, "Note exceeds content budget"),
}).strict();

export type NmfNote = z.infer<typeof nmfNoteSchema>;

/** Bodies and assets live in separate ZIP entries; the manifest never embeds either. */
export const nmfManifestSchema = z.object({
  format: z.literal("nowen-migration"),
  schemaVersion: z.literal(1),
  source: migrationSourceSchema,
  notes: z.array(z.object({
    sourceId: identifier,
    ...noteFields,
    contentFile: migrationRelativePathSchema,
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase()),
  }).strict()).min(1).max(MIGRATION_LIMITS.notes),
}).strict();

export const migrationStageSchema = z.object({ items: z.array(nmfNoteSchema).min(1).max(MIGRATION_LIMITS.stageItems) }).strict();
