import test from "node:test";
import assert from "node:assert/strict";
import { NowenApiClient } from "../src/api-client.js";

test("MCP keeps soft delete separate and sends permanent deletion to its explicit endpoint", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/login") return Response.json({ token: "fixture-token" });
    calls.push({ path, method: init.method, body: init.body && JSON.parse(String(init.body)) });
    return Response.json({ success: true });
  };
  try {
    const client = new NowenApiClient({ baseUrl: "http://qa.test", username: "fixture", password: "fixture" });
    await client.updateNote("qa-note", { isTrashed: 1 });
    await client.deleteNote("qa-note");
    assert.deepEqual(calls, [
      { path: "/api/notes/qa-note", method: "PUT", body: { isTrashed: 1 } },
      { path: "/api/notes/qa-note/permanent", method: "DELETE", body: undefined },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("MCP exposes NOTE_NOT_TRASHED and does not automatically trash an active note", async () => {
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).endsWith("/api/auth/login")) return Response.json({ token: "fixture-token" });
    methods.push(init.method || "GET");
    return Response.json({ error: "Trash first", code: "NOTE_NOT_TRASHED" }, { status: 409 });
  };
  try {
    const client = new NowenApiClient({ baseUrl: "http://qa.test", username: "fixture", password: "fixture" });
    await assert.rejects(() => client.deleteNote("active"), /Trash first/);
    assert.deepEqual(methods, ["DELETE"]);
  } finally {
    globalThis.fetch = original;
  }
});
