import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("标准后端入口会安装笔记本发布与目录权限路由", () => {
  const source = readFileSync("src/index.ts", "utf8");

  assert.match(source, /import "\.\/runtime\/notebook-publication"/);
});
