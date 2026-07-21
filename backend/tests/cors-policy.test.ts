import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { CORS_ALLOW_HEADERS, resolveCorsOrigin } from "../src/lib/cors-policy";

test("production CORS allows native client origins by default", () => {
  for (const origin of ["https://localhost", "capacitor://localhost", "null"]) {
    assert.equal(resolveCorsOrigin({ origin, isProd: true, corsOrigins: [] }), origin);
  }
});

test("production CORS keeps configured whitelist support", () => {
  assert.equal(
    resolveCorsOrigin({ origin: "https://note.example.com", isProd: true, corsOrigins: ["https://note.example.com"] }),
    "https://note.example.com",
  );
});

test("production CORS rejects unknown browser origins", () => {
  assert.equal(resolveCorsOrigin({ origin: "https://evil.example.com", isProd: true, corsOrigins: [] }), "");
});

test("CORS preflight permits offline mutation idempotency headers", async () => {
  const app = new Hono();
  app.use("*", cors({
    origin: "https://app.example.com",
    allowMethods: ["POST"],
    allowHeaders: CORS_ALLOW_HEADERS,
  }));
  app.post("/tasks", (c) => c.json({ ok: true }));

  const response = await app.request("https://api.example.com/tasks", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,idempotency-key,x-client-mutation-at",
    },
  });

  assert.equal(response.status, 204);
  const allowed = response.headers.get("Access-Control-Allow-Headers")?.toLowerCase() || "";
  assert.match(allowed, /idempotency-key/);
  assert.match(allowed, /x-client-mutation-at/);
});
