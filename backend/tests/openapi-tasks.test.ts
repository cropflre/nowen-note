import assert from "node:assert/strict";
import test from "node:test";
import { generateOpenAPISpec } from "../src/services/openapi";

test("OpenAPI documents task update, deletion preview, deletion and batch endpoints with token rules", () => {
  const paths = generateOpenAPISpec().paths;
  const update = paths["/api/tasks/{id}"]?.put;
  assert.ok(update, "PUT /api/tasks/{id}");
  assert.deepEqual(update.requestBody.content["application/json"].schema.properties.status.enum, ["todo", "doing", "blocked", "done"]);

  const remove = paths["/api/tasks/{id}"]?.delete;
  assert.ok(remove, "DELETE /api/tasks/{id}");
  assert.deepEqual(remove.parameters.find((item: any) => item.name === "mode")?.schema.enum, ["single", "series"]);
  assert.deepEqual(Object.keys(remove.requestBody.content["application/json"].schema.properties).sort(), ["confirmation", "expectedRevision"]);
  assert.match(remove.description, /tasks:write/);
  assert.match(remove.description, /DELETE_TASK/);
  assert.match(remove.responses["409"].description, /TASK_DELETION_CONFLICT/);

  const preview = paths["/api/tasks/{id}/deletion-preview"]?.get;
  assert.ok(preview, "GET /api/tasks/{id}/deletion-preview");
  assert.deepEqual(preview.parameters.find((item: any) => item.name === "mode")?.schema.enum, ["single", "series"]);

  const batch = paths["/api/tasks/batch"]?.post;
  assert.ok(batch, "POST /api/tasks/batch");
  const batchSchema = batch.requestBody.content["application/json"].schema;
  assert.deepEqual(batchSchema.properties.action.enum, ["complete", "delete"]);
  assert.deepEqual(batchSchema.required, ["ids", "action"]);
  assert.match(batch.description, /API Token/);
});
