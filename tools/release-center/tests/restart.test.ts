import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual process crash and restart reclaim stale worker and attach once without redispatch", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nowen-rc-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const driver = fileURLToPath(new URL("./worker-fixture.ts", import.meta.url));
  const first = spawnSync(
    process.execPath,
    ["--import", "tsx", driver, directory, "crash"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(first.status, 77, first.stderr);
  const recovered = spawnSync(
    process.execPath,
    ["--import", "tsx", driver, directory, "recover"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.dispatchCount, "1");
  assert.equal(result.task.state, "running");
  assert.equal(result.task.runId, 101);
});
