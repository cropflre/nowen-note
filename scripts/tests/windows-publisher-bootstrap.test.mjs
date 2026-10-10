import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("bootstrap CLI prints the actual CN then fails closed; configured CN must match exactly", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nowen-publisher-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = path.join(root, "signatures.json");
  await writeFile(report, JSON.stringify(["Nowen-Note-1.5.0-setup.exe", "Nowen-Note-Lite-1.5.0-setup.exe"].map((fileName) => ({
    fileName, status: "Valid", signerCommonName: "Actual Release CN", thumbprint: "ABC123",
    signerNotBefore: "2026-01-01T00:00:00.000Z", signerNotAfter: "2031-01-01T00:00:00.000Z", timestampPresent: true,
  }))));
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("../verify-windows-signatures.mjs", import.meta.url)), "--report", report, "--require", "full,lite", ...args], { encoding: "utf8" });
  const bootstrap = run("--bootstrap-publisher", "--signing-policy", "release-signing");
  assert.equal(bootstrap.status, 1);
  assert.match(bootstrap.stdout, /detected release-signing publisher CN: Actual Release CN/);
  assert.match(bootstrap.stderr, /set GitHub Repository Variable NOWEN_WINDOWS_PUBLISHER_NAME/);
  assert.match(bootstrap.stderr, /rerun the entire Windows build and signing job/);
  assert.equal(run("--publisher", "Actual Release CN").status, 0);
  assert.equal(run("--publisher", "actual release cn").status, 1);
  const testSigning = run("--bootstrap-publisher", "--signing-policy", "test-signing");
  assert.equal(testSigning.status, 1);
  assert.doesNotMatch(testSigning.stdout, /detected release-signing publisher CN/);
  assert.equal(run("--bootstrap-publisher", "--signing-policy", "release-signing", "--publisher", "Actual Release CN").status, 1);
});

test("tag bootstrap runs after both release requests and before formal metadata and upload", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const verify = workflow.indexOf("- name: Verify signed Windows publisher and required channels");
  assert.ok(verify > workflow.indexOf("- name: Submit Lite Windows artifact to SignPath release-signing"));
  assert.ok(verify < workflow.indexOf("- name: Refresh signed Windows blockmaps and updater metadata"));
  assert.ok(verify < workflow.indexOf("- name: Upload formal signed Windows artifact"));
  const step = workflow.slice(verify, workflow.indexOf("- name: Refresh signed Windows blockmaps", verify));
  assert.match(step, /github\.event_name == 'push'/);
  assert.match(step, /--bootstrap-publisher --signing-policy/);
  assert.match(step, /--publisher "\$NOWEN_WINDOWS_PUBLISHER_NAME"/);
  const guard = await readFile(new URL("../release.sh", import.meta.url), "utf8");
  const publisherGate = guard.indexOf("NOWEN_WINDOWS_PUBLISHER_NAME is unconfirmed");
  assert.ok(publisherGate > 0 && publisherGate < guard.indexOf('node "$VERIFY_SCRIPT" remote'));
  assert.match(guard.slice(publisherGate, guard.indexOf('node "$VERIFY_SCRIPT" remote')), /--draft=true[\s\S]*exit 1/);
});
