import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { request } from "node:http";
import { createApp } from "../server/app.ts";
import { fixture } from "./helpers.ts";

test("loopback API requires a server-side session and rejects cross-site / forged-host mutations", async (t) => {
  const f = fixture(t);
  const server = createApp(f.engine, { dist: join(f.directory, "missing") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  const session = await fetch(`${base}/api/session`);
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  assert.match(session.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const headers = {
    cookie,
    "Content-Type": "application/json",
    "X-Release-Center": "1",
  };
  const overview = await fetch(`${base}/api/overview`, { headers });
  assert.equal(overview.status, 200);
  assert.ok(!(await overview.text()).includes("ghp_fixture_secret"));
  assert.equal(
    (
      await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.invalid" },
        body: "{}",
      })
    ).status,
    403,
  );
  const forgedHost = await new Promise<number | undefined>((resolve) => {
    request(
      `${base}/api/session`,
      { headers: { Host: `evil.invalid:${address.port}` } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).end();
  });
  assert.equal(forgedHost, 403);
  assert.equal(
    (
      await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  for (const path of [
    "publish",
    "release",
    "tag",
    "shell",
    "docker",
    "store",
  ]) {
    assert.equal(
      (
        await fetch(`${base}/api/${path}`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      404,
    );
  }
  const invalid = await fetch(`${base}/api/plans`, {
    method: "POST",
    headers,
    body: "{invalid",
  });
  assert.equal(invalid.status, 400);
  const large = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "x".repeat(40_000) }),
  });
  assert.equal(large.status, 413);
  const events = await fetch(`${base}/api/events`, {
    headers,
    signal: AbortSignal.timeout(2000),
  });
  assert.match(events.headers.get("content-type")!, /text\/event-stream/);
  const reader = events.body!.getReader();
  const first = await reader.read();
  await reader.cancel();
  assert.match(new TextDecoder().decode(first.value), /"tasks":/);
  assert.equal((await fetch(`${base}/server/index.ts`)).status, 404);
});
