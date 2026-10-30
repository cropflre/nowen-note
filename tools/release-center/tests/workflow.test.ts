import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { root } from "./helpers.ts";
const require = createRequire(import.meta.url);
const workflow = require("js-yaml").load(
  readFileSync(
    join(root, ".github/workflows/release-center-debug.yml"),
    "utf8",
  ),
);

test("debug workflow only supports dispatch, read-only contents, no secrets or publishers", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(
    serialized,
    /secrets\.|gh release|git push|docker push|release-legacy|release\.sh|appx|TestFlight/,
  );
  const steps = Object.values(workflow.jobs).flatMap(
    (j: any) => j.steps || [],
  ) as any[];
  const builds = steps.filter((s) => s.run?.includes("electron-builder"));
  assert.equal(builds.length, 4);
  for (const s of builds) assert.match(s.run, /--publish never/);
  for (const s of steps.filter((s) => s.uses?.startsWith("actions/checkout"))) {
    assert.equal(s.with["persist-credentials"], false);
    assert.equal(s.with.ref, "${{ inputs.commit_sha }}");
  }
  assert.equal(workflow.jobs.build.strategy["fail-fast"], false);
});
test("matrix execution selects exactly the requested platforms; input is never interpolated into shell", () => {
  const step = workflow.jobs.plan.steps.find((s: any) => s.id === "matrix");
  const code = step.run.split("node <<'NODE'\n")[1].split("\nNODE")[0];
  for (let mask = 1; mask < 8; mask++) {
    let result = "";
    const env: Record<string, string> = {
      TASK_ID: "a".repeat(36),
      COMMIT_SHA: "b".repeat(40),
      VERSION: "1.5.2",
      GITHUB_OUTPUT: "/fixture",
    };
    const names = ["WINDOWS", "MACOS", "LINUX"];
    names.forEach((n, i) => (env[n] = String(!!(mask & (1 << i)))));
    vm.runInNewContext(code, {
      process: { env },
      require: () => ({
        appendFileSync: (_: string, value: string) => {
          result = value;
        },
      }),
    });
    const matrix = JSON.parse(result.replace(/^matrix=/, "").trim());
    assert.deepEqual(
      matrix.include.map((p: any) => p.platform),
      names.filter((n) => env[n] === "true").map((n) => n.toLowerCase()),
    );
  }
  for (const job of Object.values(workflow.jobs) as any[])
    for (const s of job.steps || [])
      if (s.run) assert.doesNotMatch(s.run, /\$\{\{\s*inputs\./);
});
