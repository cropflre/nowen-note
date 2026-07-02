import assert from "node:assert/strict";
import test from "node:test";
import { resolveCorsOrigin } from "../src/lib/cors-policy";

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
