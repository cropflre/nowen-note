import test from "node:test";
import assert from "node:assert/strict";
import { generateOpenAPISpec } from "../src/services/openapi";

test("OpenAPI freezes NMF v1 limits and migration human approval boundaries", () => {
  const spec = generateOpenAPISpec();
  assert.equal(spec.paths["/api/migrations/capabilities"].get.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/MigrationCapabilities");
  assert.deepEqual(spec.components.schemas.MigrationCapabilities.properties.adapterApiVersion.enum, [1]);
  assert.ok(spec.components.schemas.MigrationSourceAdapter.required.includes("unsupported"));
  const note = spec.components.schemas.NmfNote;
  assert.equal(note.additionalProperties, false);
  assert.deepEqual(note.properties.schemaVersion.enum, [1]);
  assert.deepEqual(note.properties.contentFormat.enum, ["markdown", "html", "txt"]);
  assert.equal(note.properties.path.maxItems, 16);
  assert.equal(note.properties.attachments.maxItems, 200);
  assert.equal(spec.paths["/api/migrations/{id}/items"].post.requestBody.content["application/json"].schema.properties.items.maxItems, 50);
  assert.ok(spec.paths["/api/migrations/{id}/uploads"].post.requestBody.content["application/octet-stream"]);
  assert.ok(!spec.paths["/api/migrations/{id}/uploads"].post.parameters.some((item: any) => item.name === "filePath"));
  for (const action of ["approve", "undo"]) {
    assert.equal(spec.paths[`/api/migrations/{id}/${action}`].post["x-human-session-required"], true);
  }
  const approval = spec.paths["/api/migrations/{id}/approve"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(approval.required, ["previewDigest"]);
  assert.equal(approval.additionalProperties, false);
  assert.ok(!("confirmation" in approval.properties));
  assert.ok(!("content" in spec.components.schemas.MigrationJob.properties));
  const manifest = spec.components.schemas.NmfManifest;
  assert.deepEqual(manifest.properties.format.enum, ["nowen-migration"]);
  assert.equal(manifest.properties.notes.maxItems, 10000);
  assert.equal(manifest.properties.notes.items.additionalProperties, false);
  assert.ok(!("content" in manifest.properties.notes.items.properties));
  assert.ok(manifest.properties.notes.items.properties.contentFile);
  assert.ok(manifest.properties.notes.items.properties.sha256);
  assert.equal(spec.components.schemas.MigrationUploadSession.properties.chunkBytes.enum[0], 4 * 1024 * 1024);
  assert.equal(spec.paths["/api/migrations/{id}/upload-sessions/{uploadId}/chunks"].put.parameters.find((parameter: any) => parameter.name === "X-Chunk-SHA256").required, true);
  assert.ok(spec.paths["/api/migrations/{id}/upload-sessions/{uploadId}/complete"].post.responses["202"]);
  assert.ok(spec.paths["/api/migrations/{id}/items/{itemId}/decision"].post.requestBody.content["application/json"].schema.required.includes("previewDigest"));
});
