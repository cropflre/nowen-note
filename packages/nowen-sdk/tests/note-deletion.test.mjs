import test from "node:test";
import assert from "node:assert/strict";
import { NowenClient } from "../dist/index.js";

test("SDK keeps trash and explicit permanent deletion separate, including its deprecated alias", async () => {
  const calls = [];
  const client = new NowenClient({
    baseUrl: "http://qa.test", username: "fixture-user", password: "fixture-password",
    fetch: async (url, init = {}) => {
      if (new URL(url).pathname === "/api/auth/login") {
        return new Response(JSON.stringify({ token: "fixture-token" }), { headers: { "Content-Type": "application/json" } });
      }
      calls.push({ path: new URL(url).pathname, method: init.method, body: init.body && JSON.parse(init.body) });
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    },
  });
  await client.trashNote("qa-note");
  await client.permanentlyDeleteNote("qa-note");
  await client.deleteNote("qa-note");
  assert.deepEqual(calls, [
    { path: "/api/notes/qa-note", method: "PUT", body: { isTrashed: 1 } },
    { path: "/api/notes/qa-note/permanent", method: "DELETE", body: undefined },
    { path: "/api/notes/qa-note/permanent", method: "DELETE", body: undefined },
  ]);
});

test("SDK propagates active-note refusal without silently moving the note to trash", async () => {
  let calls = 0;
  const client = new NowenClient({
    baseUrl: "http://qa.test", username: "fixture-user", password: "fixture-password",
    fetch: async (url) => {
      if (new URL(url).pathname === "/api/auth/login") {
        return new Response(JSON.stringify({ token: "fixture-token" }), { headers: { "Content-Type": "application/json" } });
      }
      calls++;
      return new Response(JSON.stringify({ error: "Trash first", code: "NOTE_NOT_TRASHED" }), {
        status: 409, headers: { "Content-Type": "application/json" },
      });
    },
  });
  await assert.rejects(() => client.deleteNote("active"), /Trash first/);
  assert.equal(calls, 1);
});
