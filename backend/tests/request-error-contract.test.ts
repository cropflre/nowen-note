import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { AppError, toPublicApiError } from "../src/lib/app-error";
import { handleUnhandledRequestError, requestErrorTracing } from "../src/middleware/request-error";

function createApp() {
  const app = new Hono();
  app.onError(handleUnhandledRequestError);
  app.use("*", requestErrorTracing);
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/fail", () => { throw new Error("password=hunter2 /home/private/note.db"); });
  app.get("/known", () => { throw new AppError("STORAGE_NO_SPACE", "存储空间不足", { status: 507, retryable: false }); });
  return app;
}

test("all responses carry correlation header; trusted proxy IDs are preserved", async () => {
  const response = await createApp().request("/ok", { headers: { "X-Request-Id": "req_valid_12345678" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Request-Id"), "req_valid_12345678");
  const generated = await createApp().request("/ok", { headers: { "X-Request-Id": "bad id" } });
  assert.match(generated.headers.get("X-Request-Id") || "", /^[0-9a-f-]{36}$/);
});

test("uncaught exceptions never expose raw stack, file paths or credentials", async () => {
  const response = await createApp().request("/fail");
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 500);
  assert.equal(payload.code, "SYSTEM_INTERNAL_ERROR");
  assert.equal(payload.retryable, true);
  assert.equal(payload.requestId, response.headers.get("X-Request-Id"));
  assert.doesNotMatch(JSON.stringify(payload), /hunter2|private|note\.db/);
});

test("typed AppError keeps stable code and safe message", async () => {
  const response = await createApp().request("/known");
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), {
    error: "存储空间不足",
    code: "STORAGE_NO_SPACE",
    requestId: response.headers.get("X-Request-Id"),
    retryable: false,
  });
  assert.throws(() => new AppError("invalid-code", "x"), /Invalid application error code/);
  assert.equal(toPublicApiError(new Error("raw"), "req").status, 500);
});
