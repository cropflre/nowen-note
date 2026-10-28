import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function findRepoFile(relativePath: string): string {
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(process.cwd(), "..", relativePath),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(found, `找不到仓库文件：${relativePath}`);
  return found;
}

test("Docker production entrypoint loads automatic full-backup hardening", () => {
  const dockerfile = fs.readFileSync(findRepoFile("Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /CMD\s*\["node",\s*"backend\/dist\/index\.hardened\.js"\]/,
    "Docker 必须从 index.hardened.js 启动，不能绕过运行时补丁",
  );

  const hardenedEntry = fs.readFileSync(
    findRepoFile("backend/src/index.hardened.ts"),
    "utf8",
  );
  assert.match(
    hardenedEntry,
    /import\s+["']\.\/runtime\/auto-full-backup(?:\.js)?["'];/,
    "hardened 入口必须加载自动全量备份补丁",
  );
});

test("Docker build rejects release versions that differ from packaged app or backend", () => {
  const dockerfile = fs.readFileSync(findRepoFile("Dockerfile"), "utf8");
  const script = dockerfile.match(/^RUN node -e '([^\n]+Docker version mismatch[^\n]+)'$/m)?.[1];
  assert.ok(script, "Docker build must verify the packaged versions");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-image-version-"));
  try {
    fs.mkdirSync(path.join(directory, "backend"));
    for (const [app, backend, expected, succeeds] of [
      ["1.5.3", "1.5.3", "1.5.3", true],
      ["1.5.1", "1.5.1", "1.5.3", false],
      ["1.5.3", "1.5.1", "1.5.3", false],
      ["1.5.3", "1.5.3", "", true],
    ] as const) {
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: app }));
      fs.writeFileSync(path.join(directory, "backend/package.json"), JSON.stringify({ version: backend }));
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: directory, env: { ...process.env, APP_VERSION: expected }, encoding: "utf8",
      });
      assert.equal(result.status === 0, succeeds, result.stderr);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker entrypoint checks app startup and hands incompatible data to the prompt only", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-entrypoint-test-"));
  try {
    fs.writeFileSync(path.join(directory, "node"), `#!/bin/sh
case "$1" in
  -e) printf '1.5.3' ;;
  /app/backend/dist/startup-check.js)
    if [ "\$\{2:-\}" = '--serve' ]; then printf 'TEST_PROMPT_STARTED'; else exit "$TEST_STARTUP_STATUS"; fi ;;
  backend/dist/index.hardened.js|backend/dist/index.js) printf 'TEST_APP_STARTED' ;;
  backend/dist/updater/index.js) printf 'TEST_UPDATER_STARTED' ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    for (const [status, command, expected, marker] of [
      ["0", "backend/dist/index.hardened.js", 0, "TEST_APP_STARTED"],
      ["0", "backend/dist/index.js", 0, "TEST_APP_STARTED"],
      ["78", "backend/dist/index.hardened.js", 0, "TEST_PROMPT_STARTED"],
      ["78", "backend/dist/updater/index.js", 0, "TEST_UPDATER_STARTED"],
      ["1", "backend/dist/index.hardened.js", 1, ""],
    ] as const) {
      const result = spawnSync("/bin/sh", [findRepoFile("docker-entrypoint.sh"), "node", command], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, NOWEN_DATA_DIR: directory,
          JWT_SECRET: "test-secret-for-entrypoint-only", TEST_STARTUP_STATUS: status }, encoding: "utf8",
      });
      assert.equal(result.status, expected, result.stderr);
      if (marker) assert.ok(result.stdout.includes(marker), result.stdout);
      if (marker !== "TEST_APP_STARTED") assert.ok(!result.stdout.includes("TEST_APP_STARTED"));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
