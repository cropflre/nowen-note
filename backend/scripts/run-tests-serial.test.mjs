import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { enumerateTestFiles, runTestFile } from "./run-tests-serial.mjs";

test("枚举 backend tests 下的 TypeScript 测试文件并保持稳定顺序", async () => {
  const files = await enumerateTestFiles();

  assert.ok(files.length > 0);
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.every((file) => file.endsWith(".test.ts")));
});

test("单文件超时时终止子进程并返回 timeout 结果", async () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "nowen-test-timeout-"));
  const fixture = path.join(fixtureDir, "hang.test.ts");
  writeFileSync(fixture, "import test from 'node:test'; test('hang', () => { setInterval(() => {}, 60000); });", "utf8");
  try {
    const result = await runTestFile(fixture, "hang.test.ts", { timeoutMs: 100 });
    assert.equal(result.status, "timeout");
    assert.match(result.firstError ?? "", /timeout/i);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
