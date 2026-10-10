import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("generator check accepts Windows CRLF but still rejects stale content and missing output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nowen-generator-crlf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "packages/nowen-plugin-sdk"]) await mkdir(path.join(root, dir), { recursive: true });
  await copyFile(new URL("../generate-plugin-host-api.mjs", import.meta.url), path.join(root, "scripts/generate-plugin-host-api.mjs"));
  for (const file of ["host-api-contract.json", "contribution-contract.json", "error-code-contract.json"]) {
    await copyFile(new URL(`../../packages/nowen-plugin-sdk/${file}`, import.meta.url), path.join(root, "packages/nowen-plugin-sdk", file));
  }
  const run = (...args) => spawnSync(process.execPath, [path.join(root, "scripts/generate-plugin-host-api.mjs"), ...args], { encoding: "utf8" });
  const generated = run();
  assert.equal(generated.status, 0, generated.stderr);
  const files = (await readdir(root, { recursive: true })).filter((file) => file.includes(".generated.") || file.endsWith("capability-catalog.json"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const target = path.join(root, file);
    await writeFile(target, (await readFile(target, "utf8")).replace(/\n/g, "\r\n"));
  }
  const checked = run("--check");
  assert.equal(checked.status, 0, checked.stderr);
  const changed = path.join(root, files[0]);
  await writeFile(changed, `${await readFile(changed, "utf8")}stale content\r\n`);
  assert.equal(run("--check").status, 1);
  assert.equal(run().status, 0);
  await rm(changed);
  assert.equal(run("--check").status, 1);
});
