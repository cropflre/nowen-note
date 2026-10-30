import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHub } from "../server/github.ts";
import { Planner, validateInput, versionChecks } from "../server/planner.ts";
import { AppError } from "../server/errors.ts";
import { input, root } from "./helpers.ts";

function transport(
  options: {
    tag?: boolean;
    release?: boolean;
    status?: number;
    mismatch?: boolean;
    workflowMissing?: boolean;
    verifierMissing?: boolean;
    verifierMismatch?: boolean;
    version?: string;
  } = {},
): typeof fetch {
  return (async (raw: string | URL | Request) => {
    const url = new URL(String(raw));
    const path = decodeURIComponent(url.pathname);
    if (options.status)
      return new Response("{}", {
        status: options.status,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "90" },
      });
    let data: any;
    if (path.includes("/branches/")) data = { commit: { sha: "a".repeat(40) } };
    else if (path.includes("/contents/")) {
      const file = path.split("/contents/")[1];
      let text = "";
      if (file.includes("workflows")) {
        if (options.workflowMissing) return new Response("{}", { status: 404 });
        text = readFileSync(
          join(root, ".github/workflows/release-center-debug.yml"),
          "utf8",
        );
      } else if (file.endsWith(".mjs") || file.endsWith(".cjs")) {
        if (options.verifierMissing) return new Response("{}", { status: 404 });
        text = readFileSync(join(root, file), "utf8");
        if (options.verifierMismatch && file.endsWith(".cjs"))
          text += "\n// unreviewed platform protocol";
      } else if (file.endsWith("gradle"))
        text = `versionName "${options.version || "1.5.2"}"`;
      else
        text = JSON.stringify({
          version:
            options.mismatch && file === "package-lock.json"
              ? "1.5.1"
              : options.version || "1.5.2",
          packages: { "": { version: options.version || "1.5.2" } },
        });
      data = {
        encoding: "base64",
        content: Buffer.from(text).toString("base64"),
      };
    } else if (path.includes("/git/ref/"))
      return new Response("{}", { status: options.tag ? 200 : 404 });
    else if (path.endsWith("/releases"))
      data = options.release ? [{ tag_name: "v1.5.2", draft: true }] : [];
    else if (path.includes("/check-runs"))
      data = {
        check_runs: [
          { name: "Tests", status: "completed", conclusion: "success" },
        ],
      };
    else if (path.endsWith("/release-center-debug.yml"))
      data = { state: "active" };
    else throw Error(`Unexpected test request ${path}`);
    return Response.json(data);
  }) as typeof fetch;
}

test("input rejects commands, duplicate/unknown platforms, invalid SemVer and channel mismatch", () => {
  for (const patch of [
    { branch: "-c" },
    { branch: "main;touch /tmp/x" },
    { branch: "main..branch" },
    { version: "01.5.2" },
    { version: "1.5.2;pwd" },
    { version: "1.5.2-rc.1" },
    { platforms: ["ios"] },
    { platforms: ["windows", "windows"] },
    { command: "bash" },
  ]) {
    assert.throws(() => validateInput({ ...input, ...patch }), AppError);
  }
  assert.equal(
    validateInput({ ...input, version: "1.5.2-rc.1", channel: "prerelease" })
      .channel,
    "prerelease",
  );
});
test("version consistency includes lockfile root and packages entry", () => {
  const checks = versionChecks(
    {
      "package-lock.json":
        '{"version":"1.5.2","packages":{"":{"version":"1.5.1"}}}',
      "backend/package.json": '{"version":"1.5.2"}',
      "frontend/android/app/build.gradle": 'versionName "1.5.1"',
    },
    "1.5.2",
  );
  assert.deepEqual(
    checks.map((c) => c.status),
    ["fail", "pass", "fail"],
  );
});
test("preflight pins SHA and validates the exact audited workflow", async () => {
  const planner = new Planner(
    root,
    new GitHub("fixture", transport()),
    "release/v1.5.2",
    true,
  );
  const plan = await planner.create(input);
  assert.equal(plan.ready, true);
  assert.equal(plan.debugReady, true);
  assert.equal(plan.sha, "a".repeat(40));
  assert.equal(
    plan.checks.find((c) => c.name === "正式发布审批")?.status,
    "unknown",
  );
});
test("duplicate tag or published release blocks execution without any write", async () => {
  for (const option of [{ tag: true }, { release: true }]) {
    const planner = new Planner(
      root,
      new GitHub("fixture", transport(option)),
      "release/v1.5.2",
      true,
    );
    const plan = await planner.create(input);
    assert.equal(plan.ready, false);
    assert.equal(plan.debugReady, false);
  }
});
test("inconsistent package files block debug and absent workflow cannot silently fall back", async () => {
  for (const option of [{ mismatch: true }, { workflowMissing: true }]) {
    const planner = new Planner(
      root,
      new GitHub("fixture", transport(option)),
      "release/v1.5.2",
      true,
    );
    assert.equal((await planner.create(input)).debugReady, false);
  }
});
test("expired token and rate limits remain unknown and block candidate execution", async () => {
  for (const status of [401, 429]) {
    const plan = await new Planner(
      root,
      new GitHub("fixture", transport({ status })),
      "release/v1.5.2",
      true,
    ).create(input);
    assert.equal(plan.ready, false);
    assert.equal(plan.debugReady, false);
    assert.ok(
      plan.checks.some(
        (c) => c.status === "unknown" && /Token|限流/.test(c.detail),
      ),
    );
  }
});

test("prerelease plans can dry run but cannot dispatch unsupported updater channels", async () => {
  const planner = new Planner(
    root,
    new GitHub("fixture", transport({ version: "1.5.2-rc.1" })),
    "release/v1.5.2",
    true,
  );
  const plan = await planner.create({
    ...input,
    version: "1.5.2-rc.1",
    channel: "prerelease",
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.debugReady, false);
  assert.match(
    plan.checks.find((c) => c.name === "调试渠道兼容性")!.detail,
    /尚未实现/,
  );
});

test("unexpected transport errors never expose the server credential in plan checks", async () => {
  const token = "private-server-credential";
  const github = new GitHub(token, (async () => {
    throw Error(`Invalid header: ${token}`);
  }) as typeof fetch);
  const plan = await new Planner(root, github, "release/v1.5.2", true).create(
    input,
  );
  assert.equal(plan.ready, false);
  assert.ok(!JSON.stringify(plan).includes(token));
  assert.ok(
    plan.checks
      .filter((c) => c.status === "unknown")
      .every((c) => !c.detail.includes(token)),
  );
});

test("candidate commits with missing or changed artifact protocols cannot dispatch debug builds", async () => {
  for (const options of [
    { verifierMissing: true },
    { verifierMismatch: true },
  ]) {
    const planner = new Planner(
      root,
      new GitHub("fixture", transport(options)),
      "release/v1.5.2",
      true,
    );
    const plan = await planner.create(input);
    assert.equal(plan.ready, true);
    assert.equal(plan.debugReady, false);
    assert.equal(
      plan.checks.find((c) => c.name === "调试产物协议")!.status,
      "unknown",
    );
  }
});
