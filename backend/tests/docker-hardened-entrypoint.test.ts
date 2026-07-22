import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
