import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBlockAuthorityMode,
  selectBlockAuthorityRead,
} from "../src/lib/blockAuthorityMode";

const healthy = {
  content: "blocks",
  source: "blocks" as const,
  status: "healthy" as const,
};

const mismatch = {
  content: "snapshot",
  source: "notes" as const,
  status: "mismatch" as const,
};

test("未知 Block 权威模式保持 shadow，避免配置拼写触发主读", () => {
  assert.equal(resolveBlockAuthorityMode(undefined), "shadow");
  assert.equal(resolveBlockAuthorityMode("shadow"), "shadow");
  assert.equal(resolveBlockAuthorityMode("PRIMARY"), "shadow");
  assert.equal(resolveBlockAuthorityMode("primary"), "primary");
});

test("shadow 始终返回兼容快照，primary 只采用健康 Block", () => {
  assert.deepEqual(selectBlockAuthorityRead("shadow", healthy, "snapshot"), {
    content: "snapshot",
    source: "notes",
    status: "healthy",
  });
  assert.deepEqual(selectBlockAuthorityRead("primary", healthy, "snapshot"), healthy);
  assert.deepEqual(selectBlockAuthorityRead("primary", mismatch, "snapshot"), mismatch);
});

test("只有缺失 shadow 才允许读取修复，mismatch 必须保留现场", () => {
  assert.equal(selectBlockAuthorityRead("shadow", {
    content: "snapshot",
    source: "notes",
    status: "missing",
  }, "snapshot").shouldRepair, true);
  assert.notEqual(selectBlockAuthorityRead("primary", mismatch, "snapshot").shouldRepair, true);
});
