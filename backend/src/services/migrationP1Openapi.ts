const json = (name: string) => ({ "application/json": { schema: { $ref: `#/components/schemas/${name}` } } });
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const hash = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
const id = { name: "id", in: "path", required: true, schema: text(128) };
const uploadId = { name: "uploadId", in: "path", required: true, schema: text(128) };
const responses = { "400": { description: "Invalid input or checksum" }, "401": { description: "Authentication required" },
  "403": { description: "Current and original token/target permissions required" }, "404": { description: "Owned session not found" },
  "409": { description: "Stale preview, offset, operation conflict, expired session or active lease" }, "413": { description: "Chunk or staging quota exceeded" } };
const sessionResponse = { description: "Durable upload session and confirmed offset, no local path or file bytes", content: json("MigrationUploadSession") };
const operation = (summary: string) => ({ tags: ["迁移"], summary, "x-required-scopes": ["export:import"], parameters: [id, uploadId] });

export const migrationP1OpenApiSchemas = {
  CreateMigrationUploadSession: {
    type: "object", additionalProperties: false, required: ["operationId", "filename", "size", "sha256"], properties: {
      operationId: { ...text(128), minLength: 8 }, filename: text(200), size: { type: "integer", minimum: 1, maximum: 512 * 1024 * 1024 },
      sha256: hash, assetPath: { ...text(512), description: "Optional safe assets/ relative path; requires attachment write scope" },
    },
  },
  MigrationUploadSession: {
    type: "object", required: ["id", "jobId", "status", "offset", "size", "sha256", "chunkBytes", "expiresAt"], properties: {
      id: text(128), jobId: text(128), operationId: text(128), filename: text(200), sha256: hash,
      status: { type: "string", enum: ["OPEN", "FINALIZING", "COMPLETE", "FAILED", "EXPIRED", "CANCELLED"] },
      offset: { type: "integer", minimum: 0 }, size: { type: "integer", minimum: 1 }, chunkBytes: { type: "integer", enum: [4 * 1024 * 1024] },
      expiresAt: { type: "string", format: "date-time" }, assetPath: { type: "string", nullable: true }, error: { type: "string", nullable: true },
    },
  },
};
export const migrationP1OpenApiPaths = {
  "/api/migrations/{id}/upload-sessions": { post: {
    ...operation("Create or resume an owner-scoped upload session; operationId and file identity are immutable"), parameters: [id],
    requestBody: { required: true, content: json("CreateMigrationUploadSession") }, responses: { "201": sessionResponse, ...responses },
  } },
  "/api/migrations/{id}/upload-sessions/{uploadId}": {
    get: { ...operation("Query the confirmed byte offset after a lost response or restart"), responses: { "200": sessionResponse, ...responses } },
    delete: { ...operation("Cancel an uncommitted upload session without deleting another session's files"), responses: { "200": sessionResponse, ...responses } },
  },
  "/api/migrations/{id}/upload-sessions/{uploadId}/chunks": { put: {
    ...operation("Stream exactly one 4MiB chunk (or the final remainder); exact replays are idempotent"),
    parameters: [id, uploadId, { name: "offset", in: "query", required: true, schema: { type: "integer", minimum: 0 } },
      { name: "X-Chunk-SHA256", in: "header", required: true, schema: hash }],
    requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary", maxLength: 4 * 1024 * 1024 } } } },
    responses: { "200": sessionResponse, ...responses },
  } },
  "/api/migrations/{id}/upload-sessions/{uploadId}/complete": { post: {
    ...operation("Queue background assembly and full SHA-256 verification; an upload is not an imported note"),
    responses: { "202": { description: "Migration job summary; UPLOADING until verified handoff, then SCANNING/CREATED", content: json("MigrationJob") }, ...responses },
  } },
  "/api/migrations/{id}/items/{itemId}/decision": { post: {
    ...operation("Choose skip, keep-existing or create-copy; rotates the preview and never overwrites existing notes"),
    parameters: [id, { name: "itemId", in: "path", required: true, schema: text(128) }],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false,
      required: ["previewDigest", "decision"], properties: { previewDigest: hash, decision: { type: "string", enum: ["auto", "skip", "keep-existing", "create-copy"] } } } } } },
    responses: { "200": { description: "New preview; user must review again before approval", content: json("MigrationJob") }, ...responses },
  } },
};
