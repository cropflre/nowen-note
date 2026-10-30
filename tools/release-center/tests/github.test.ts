import test from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../server/github.ts";
import { AppError } from "../server/errors.ts";

test("REST pagination follows every page and reads artifact digest without claiming verification", async () => {
  const calls: string[] = [];
  const github = new GitHub("", (async (raw: any) => {
    const url = new URL(raw);
    calls.push(url.href);
    if (url.pathname.endsWith("/artifacts"))
      return Response.json({
        artifacts: [
          {
            id: 1,
            name: "test",
            size_in_bytes: 10,
            digest: "sha256:hash",
            expired: false,
          },
        ],
      });
    return Response.json(
      url.searchParams.get("page") === "1"
        ? Array.from({ length: 100 }, (_, id) => ({ id }))
        : [{ id: 100 }],
    );
  }) as typeof fetch);
  assert.equal((await github.list("branches")).length, 101);
  assert.equal(calls.length, 2);
  assert.deepEqual((await github.artifacts(1))[0], {
    id: 1,
    name: "test",
    size: 10,
    digest: "sha256:hash",
    expired: false,
    verification: "not_downloaded",
  });
});
test("dispatch endpoint is hard-coded to the dedicated debug workflow", async () => {
  const requests: any[] = [];
  const github = new GitHub("ghp_fixture", (async (url: any, init: any) => {
    requests.push({ url, init });
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  await github.dispatch("release/v1.5.2", { commit_sha: "a".repeat(40) });
  assert.match(
    requests[0].url,
    /actions\/workflows\/release-center-debug.yml\/dispatches$/,
  );
  assert.equal(requests[0].init.method, "POST");
  assert.equal(JSON.parse(requests[0].init.body).ref, "release/v1.5.2");
});
test("rate-limit and expired-token errors retain actionable status and retry guidance", async () => {
  for (const status of [401, 403, 429]) {
    const github = new GitHub(
      "",
      (async () =>
        new Response("{}", {
          status,
          headers:
            status === 403 || status === 429 ? { "retry-after": "120" } : {},
        })) as typeof fetch,
    );
    await assert.rejects(
      github.runs(),
      (e: any) =>
        e instanceof AppError && e.status === (status === 401 ? 401 : 429),
    );
  }
});
test("job log redirects do not forward GitHub Authorization and reject arbitrary hosts", async () => {
  const calls: any[] = [];
  const github = new GitHub("ghp_secret", (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("api.github.com"))
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://results.blob.core.windows.net/logs?sig=private",
        },
      });
    return new Response("Build log");
  }) as typeof fetch);
  assert.equal(await github.jobLog(1), "Build log");
  assert.equal(calls[1].init.headers, undefined);
  const malicious = new GitHub(
    "",
    (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/logs" },
      })) as typeof fetch,
  );
  await assert.rejects(malicious.jobLog(1), /允许范围/);
});
test("correlation rejects duplicate remote runs and does not select a different task", async () => {
  const github = new GitHub("", (async () =>
    Response.json({
      workflow_runs: [1, 2].map((id) => ({
        id,
        display_title: "Release Center debug same-task",
        event: "workflow_dispatch",
      })),
    })) as typeof fetch);
  await assert.rejects(
    github.findRun("same-task", new Date().toISOString()),
    /重复/,
  );
  assert.equal(
    await github.findRun("different-task", new Date().toISOString()),
    undefined,
  );
});
