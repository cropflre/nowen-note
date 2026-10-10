import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { AppError } from "../src/lib/app-error";
import { handleUnhandledRequestError, requestErrorTracing } from "../src/middleware/request-error";
import { requestLogMiddleware, resolveHttpRequestLogMode, safeRequestRoute } from "../src/middleware/request-logging";
import { logNoteWrite } from "../src/services/note-write-observability";

function app() {
  const app = new Hono();
  app.onError(handleUnhandledRequestError);
  app.use("*", requestErrorTracing);
  app.use("*", requestLogMiddleware);
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/cached", (c) => c.body(null, 304));
  app.get("/bad", (c) => c.json({ error: "invalid" }, 400));
  app.get("/hidden/:id", (c) => c.json({ error: "not found" }, 404));
  app.get("/fail", () => { throw new Error("password=secret /srv/private/notes.db"); });
  app.get("/known", () => { throw new AppError("STORAGE_NO_SPACE", "空间不足", { status: 507 }); });
  return app;
}

test("the default access logger prints only failed responses, without signed URL parameters", async () => {
  const previous = process.env.HTTP_REQUEST_LOG;
  delete process.env.HTTP_REQUEST_LOG;
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const oldError = console.error, oldWarn = console.warn, oldInfo = console.info;
  console.error = (...args) => { errors.push(args.join(" ")); };
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  console.info = (...args) => { infos.push(args.join(" ")); };
  try {
    const instance = app();
    assert.equal((await instance.request("/ok?sig=secret")).status, 200);
    assert.equal((await instance.request("/cached")).status, 304);
    assert.equal(infos.length + warnings.length + errors.length, 0);

    const failed = await instance.request("/bad?sig=secret&scope=private", {
      headers: { "X-Request-Id": "request_123456789" },
    });
    assert.equal(failed.status, 400);
    assert.equal(warnings.length, 1);
    const entry = JSON.parse(warnings[0]) as Record<string, unknown>;
    assert.equal(entry.httpStatus, 400);
    assert.equal(entry.requestId, "request_123456789");
    assert.equal(entry.route, "/bad");
    assert.equal(entry.method, "GET");
    assert.equal(entry.event, "http.request.failed");
    assert.doesNotMatch(warnings[0], /secret|scope|private/);

    await instance.request("/hidden/12345678-1234-1234-1234-123456789abc?sig=secret");
    assert.equal(warnings.length, 2);
    assert.equal((JSON.parse(warnings[1]) as Record<string, unknown>).route, "/hidden/:id");
    assert.doesNotMatch(warnings[1], /sig|secret|12345678-1234-1234-1234-123456789abc/);

    const thrown = await instance.request("/fail?token=secret");
    assert.equal(thrown.status, 500);
    assert.equal(errors.length, 1, "unhandled errors are logged exactly once");
    assert.doesNotMatch(errors[0], /secret|private|notes\\.db|token/);
    assert.equal((JSON.parse(errors[0]) as Record<string, unknown>).event, "http.request.failed");

    await instance.request("/known");
    assert.equal(errors.length, 2, "typed errors are also logged exactly once");
  } finally {
    console.error = oldError;
    console.warn = oldWarn;
    console.info = oldInfo;
    if (previous === undefined) delete process.env.HTTP_REQUEST_LOG;
    else process.env.HTTP_REQUEST_LOG = previous;
  }
});

test("log mode accepts explicit overrides; unsafe route components are masked", () => {
  assert.equal(resolveHttpRequestLogMode(undefined), "errors");
  assert.equal(resolveHttpRequestLogMode("all"), "all");
  assert.equal(resolveHttpRequestLogMode("off"), "off");
  assert.equal(resolveHttpRequestLogMode("unexpected"), "errors");
  assert.equal(safeRequestRoute("/api/attachments/:id?sig=secret"), "/api/attachments/:id");
  assert.equal(safeRequestRoute("/api/secret%2Ftoken"), "/[redacted]");
  assert.equal(safeRequestRoute("/api/attachment/12345678-1234-1234-1234-123456789abc"), "/api/attachment/:id");
});

test("successful note autosaves stay silent while rejected writes are reported", () => {
  const previous = process.env.NOTE_WRITE_DEBUG;
  delete process.env.NOTE_WRITE_DEBUG;
  const info: unknown[][] = [], warnings: unknown[][] = [];
  const oldInfo = console.info, oldWarn = console.warn;
  console.info = (...args) => { info.push(args); };
  console.warn = (...args) => { warnings.push(args); };
  const base = { noteId: "note-1", source: "live-autosave" as const, baseVersion: 1, oldVersion: 1, newVersion: 2 };
  try {
    logNoteWrite({ ...base, outcome: "committed" });
    assert.equal(info.length + warnings.length, 0);
    logNoteWrite({ ...base, outcome: "rejected", reason: "version_conflict" });
    assert.equal(warnings.length, 1);
    process.env.NOTE_WRITE_DEBUG = "1";
    logNoteWrite({ ...base, outcome: "committed" });
    assert.equal(info.length, 1);
  } finally {
    console.info = oldInfo;
    console.warn = oldWarn;
    if (previous === undefined) delete process.env.NOTE_WRITE_DEBUG;
    else process.env.NOTE_WRITE_DEBUG = previous;
  }
});
