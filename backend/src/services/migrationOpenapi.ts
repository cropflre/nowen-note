/** NMF v1 public wire contract; runtime validation lives in migrationFormat.ts. */
const text = (maxLength: number, minLength = 1) => ({ type: "string", minLength, maxLength });
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const source = {
  type: "object", additionalProperties: false, required: ["platform", "exportId"],
  properties: { platform: text(64), exportId: text(128) },
};
const json = (schema: unknown) => ({ "application/json": { schema } });
const jobResponse = { description: "Persisted migration summary; excludes note bodies and attachment bytes", content: json(reference("MigrationJob")) };
const errors = {
  "400": { description: "Invalid NMF, file or input" }, "401": { description: "Authentication required" },
  "403": { description: "Ownership, token scope, target permission or human-session check failed" },
  "409": { description: "Invalid state, changed/expired preview or idempotency conflict" },
  "413": { description: "File, archive or staging quota exceeded" }, "429": { description: "Concurrent task or request limit reached" },
};
const idParameter = { name: "id", in: "path", required: true, schema: text(128) };
const operation = (summary: string, requestSchema?: unknown) => ({
  tags: ["迁移"], summary, "x-required-scopes": ["export:import"],
  parameters: [idParameter],
  ...(requestSchema ? { requestBody: { required: true, content: json(requestSchema) } } : {}),
  responses: { "200": jobResponse, ...errors },
});

const noteAndJobSchemas = {
  MigrationSource: source,
  NmfNote: {
    type: "object", additionalProperties: false,
    required: ["schemaVersion", "source", "title", "contentFormat", "content"],
    properties: {
      schemaVersion: { type: "integer", enum: [1] },
      source: { ...source, required: ["platform", "exportId", "sourceId"], properties: { ...source.properties, sourceId: text(512) } },
      title: text(500),
      path: { type: "array", maxItems: 16, items: text(100), default: [], description: "Normalized folder segments; no slashes, dot segments or control characters" },
      contentFormat: { type: "string", enum: ["markdown", "html", "txt"] },
      content: { ...text(2 * 1024 * 1024, 0), description: "Maximum 2 MiB UTF-8; transferred only during staging, never in task summaries" },
      createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
      tags: { type: "array", maxItems: 100, items: text(100), default: [] },
      attachments: {
        type: "array", maxItems: 200, default: [], items: {
          type: "object", additionalProperties: false, required: ["assetId", "path", "sha256"],
          properties: { assetId: text(128), path: { ...text(512), description: "Safe relative asset path" },
            sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" }, mimeType: text(100), originalPath: text(2048) },
        },
      },
      links: { type: "array", maxItems: 200, default: [], items: {
        type: "object", additionalProperties: false, required: ["href"],
        properties: { href: text(2048), targetSourceId: text(512), label: text(500, 0) },
      } },
      metadata: { type: "object", maxProperties: 32, description: "Flat string/finite number/boolean/null values; maximum 16 KiB JSON. Never written as arbitrary DB columns.",
        additionalProperties: { oneOf: [{ type: "string", nullable: true, maxLength: 2048 }, { type: "number" }, { type: "boolean" }] } },
    },
  },
  CreateMigration: {
    type: "object", additionalProperties: false, required: ["operationId", "source"],
    properties: { operationId: text(128, 8), source: reference("MigrationSource"), name: text(200),
      workspaceId: { ...text(128), nullable: true }, targetNotebookId: { ...text(128), nullable: true } },
  },
  MigrationCounts: {
    type: "object", properties: Object.fromEntries([
      "total", "create", "existing", "skipped", "needsAttention", "imported", "failed", "attachments", "bytes",
    ].map(name => [name, { type: "integer", minimum: 0 }])),
  },
  MigrationJob: {
    type: "object", required: ["id", "status", "source", "counts"], properties: {
      id: text(128), status: { type: "string", enum: ["CREATED", "UPLOADING", "SCANNING", "NORMALIZING", "PREVIEW_READY", "APPROVED", "IMPORTING", "VERIFYING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "PAUSED", "UNDONE"] },
      source: reference("MigrationSource"), name: text(200), workspaceId: { type: "string", nullable: true },
      targetNotebookId: { type: "string", nullable: true }, rootNotebookId: { type: "string", nullable: true },
      counts: reference("MigrationCounts"), previewDigest: { type: "string", nullable: true },
      warnings: { type: "array", items: { type: "string" } }, error: { type: "string", nullable: true },
      createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
      undo: { type: "object", properties: { available: { type: "boolean" }, reason: { type: "string", nullable: true } } },
    },
  },
  MigrationReport: {
    type: "object", properties: {
      job: reference("MigrationJob"), warnings: { type: "array", items: { type: "string" } }, nextCursor: { type: "string", nullable: true },
      items: { type: "array", items: { type: "object", properties: {
        id: text(128), sourceId: text(512), title: text(500), path: { type: "array", items: { type: "string" } },
        status: { type: "string" }, action: { type: "string" }, targetNoteId: { type: "string", nullable: true },
        error: { type: "string", nullable: true }, warnings: { type: "array", items: { type: "string" } },
        unsupportedFields: { type: "array", items: { type: "string" }, description: "Names of source metadata fields that were not converted; no secret values or bodies" },
      } } },
    },
  },
};

export const migrationOpenApiSchemas = {
  ...noteAndJobSchemas,
  MigrationSourceAdapter: {
    type: "object", additionalProperties: false,
    required: ["id", "version", "platforms", "formats", "extensions", "autoDetect", "unsupported"],
    properties: {
      id: text(128), version: { type: "integer", enum: [1] }, autoDetect: { type: "boolean" },
      ...Object.fromEntries(["platforms", "formats", "extensions", "unsupported"].map((key) => [key, { type: "array", maxItems: 100, items: text(2048) }])),
    },
  },
  MigrationCapabilities: {
    type: "object", required: ["schemaVersion", "formats", "humanApprovalRequired"],
    properties: {
      schemaVersion: { type: "integer", enum: [1] }, formats: { type: "array", items: text(64) },
      humanApprovalRequired: { type: "boolean", enum: [true] }, adapterApiVersion: { type: "integer", enum: [1] },
      adapters: { type: "array", maxItems: 50, items: reference("MigrationSourceAdapter") },
      sourceAdapters: { type: "array", items: text(128), description: "Legacy P1 adapter IDs retained for existing clients" },
      limits: { type: "object", additionalProperties: { type: "number" } },
      resumableUploads: { type: "boolean" }, uploadChunkBytes: { type: "integer" },
      remoteFetch: { type: "boolean", enum: [false] }, overwrite: { type: "boolean", enum: [false] },
      permissions: { type: "object", properties: { canApprove: { type: "boolean" } }, description: "Current login/PAT only; not a proof of another AI token or destination access" },
    },
  },
  NmfManifest: {
    type: "object", additionalProperties: false, required: ["format", "schemaVersion", "source", "notes"],
    properties: {
      format: { type: "string", enum: ["nowen-migration"] }, schemaVersion: { type: "integer", enum: [1] },
      source: reference("MigrationSource"), notes: {
        type: "array", minItems: 1, maxItems: 10000, items: {
          type: "object", additionalProperties: false, required: ["sourceId", "title", "contentFormat", "contentFile", "sha256"],
          properties: {
            ...Object.fromEntries(Object.entries(noteAndJobSchemas.NmfNote.properties).filter(([name]) => !["schemaVersion", "source", "content"].includes(name))),
            sourceId: text(512), contentFile: { ...text(512), description: "Safe relative UTF-8 body file path inside the package" },
            sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "SHA-256 of the original body file bytes before HTML sanitization" },
          },
        },
      },
    },
  },
};

export const migrationOpenApiPaths = {
  "/api/migrations/capabilities": { get: {
    tags: ["迁移"], summary: "Query NMF version, supported formats, quotas and permissions", "x-required-scopes": ["export:import"],
    responses: { "200": { description: "Migration capabilities and trusted built-in adapter catalog; read-only, no source connections", content: json(reference("MigrationCapabilities")) }, ...errors },
  } },
  "/api/migrations": {
    get: { tags: ["迁移"], summary: "List the current user's migration history", "x-required-scopes": ["export:import"],
      responses: { "200": { description: "Owned migration summaries", content: json({ type: "object", properties: { items: { type: "array", items: reference("MigrationJob") } } }) }, ...errors } },
    post: { ...operation("Create an idempotent preparation task; creates no notes", reference("CreateMigration")), parameters: [],
      responses: { "201": jobResponse, ...errors } },
  },
  "/api/migrations/{id}": { get: operation("Read owned task progress and counts; no bodies") },
  "/api/migrations/{id}/items": { post: operation("Stage at most 50 normalized notes; no business writes", {
    type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", minItems: 1, maxItems: 50, items: reference("NmfNote") } },
  }) },
  "/api/migrations/{id}/uploads": { post: {
    ...operation("Stream a source file or asset; never accepts a server filesystem path"),
    parameters: [idParameter,
      { name: "filename", in: "query", required: true, schema: text(200) },
      { name: "assetPath", in: "query", schema: text(512) },
      { name: "sha256", in: "query", schema: { type: "string", pattern: "^[a-fA-F0-9]{64}$" } },
    ],
    requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
    responses: { "202": jobResponse, ...errors },
  } },
  "/api/migrations/{id}/preview": { post: operation("Scan and generate the current preview digest") },
  "/api/migrations/{id}/approve": { post: {
    ...operation("Human login session only: approve the current unexpired preview once", {
      type: "object", additionalProperties: false, required: ["previewDigest"], properties: { previewDigest: { type: "string", pattern: "^[a-f0-9]{64}$" } },
    }),
    description: "API tokens and MCP clients cannot approve. The server binds approval to the validated user session and current preview; fixed confirmation strings are not accepted.",
    "x-human-session-required": true,
    responses: { "202": jobResponse, ...errors },
  } },
  "/api/migrations/{id}/report": { get: {
    ...operation("Read a paginated migration report, excluding note bodies"),
    parameters: [idParameter, { name: "cursor", in: "query", schema: { type: "string" } }],
    responses: { "200": { description: "Migration report", content: json(reference("MigrationReport")) }, ...errors },
  } },
  ...Object.fromEntries(["retry", "cancel", "pause", "resume"].map(action =>
    [`/api/migrations/{id}/${action}`, { post: operation(`${action} an owned task using persisted item receipts`) }])),
  "/api/migrations/{id}/undo": { post: { ...operation("Human login session only: undo unchanged migration results safely"), "x-human-session-required": true } },
};
