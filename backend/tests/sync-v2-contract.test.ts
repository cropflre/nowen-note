import assert from "node:assert/strict";
import test from "node:test";
import { isLocalFirstSyncV2Enabled } from "../src/sync/flag";
import {
  SYNC_ENTITY_TYPES,
  SYNC_OPERATIONS,
  isSyncEntityType,
  isSyncOperation,
} from "../src/sync/types";
import {
  SYNC_RETRY_BACKOFF_MS,
  SYNC_V2_BASE_PATH,
  syncRetryDelayMs,
} from "../src/sync/constants";
import {
  SyncError,
  isRetryableSyncError,
  isSyncErrorCode,
} from "../src/sync/errors";
import {
  assertNotOutboxSuppressed,
  isOutboxSuppressed,
  runWithOutboxSuppressed,
} from "../src/sync/context";
import { formatSyncLog } from "../src/sync/log";

test("Sync V2 开关默认关闭，仅显式 1/true 才启用", () => {
  assert.equal(isLocalFirstSyncV2Enabled(undefined), false);
  assert.equal(isLocalFirstSyncV2Enabled(""), false);
  assert.equal(isLocalFirstSyncV2Enabled("0"), false);
  assert.equal(isLocalFirstSyncV2Enabled("1"), true);
  assert.equal(isLocalFirstSyncV2Enabled("true"), true);
});

test("开关拒绝模糊取值，避免配置拼写意外开启改造路径", () => {
  assert.equal(isLocalFirstSyncV2Enabled("TRUE"), false);
  assert.equal(isLocalFirstSyncV2Enabled("True"), false);
  assert.equal(isLocalFirstSyncV2Enabled("yes"), false);
  assert.equal(isLocalFirstSyncV2Enabled("on"), false);
  assert.equal(isLocalFirstSyncV2Enabled(" 1"), false);
  assert.equal(isLocalFirstSyncV2Enabled("2"), false);
});

test("同步实体范围锁定已实现完整链路的十类，防止越界扩张", () => {
  // 断言精确列表而非"至少包含"：新增实体必须同时补齐服务端 apply、
  // 本地 apply、Change Feed 触发器、Outbox 触发器与 CHECK 约束，
  // 只改这个数组会让链路某一环静默失败。改这里就必须回答"七环节都做了吗"。
  assert.deepEqual([...SYNC_ENTITY_TYPES], [
    // 第一版：个人知识库核心
    "notebook",
    "note",
    "tag",
    "note_tag",
    "favorite",
    "attachment",
    // 阶段 J：其余个人数据
    "task",
    "task_reminder",
    "diary",
    "mindmap",
  ]);
});

test("实体类型守卫只接受已实现完整链路的实体", () => {
  assert.equal(isSyncEntityType("note"), true);
  assert.equal(isSyncEntityType("attachment"), true);
  // task 已在阶段 J 纳入（完整七环节链路）
  assert.equal(isSyncEntityType("task"), true);
  assert.equal(isSyncEntityType("mindmap"), true);
  // 工作区实体仍未纳入：ACL / 成员变更 / 权限撤销需单独设计（阶段 K）
  assert.equal(isSyncEntityType("workspace"), false);
  assert.equal(isSyncEntityType("habit"), false);
  assert.equal(isSyncEntityType("diary"), true, "diary 已在阶段 J 纳入");
  // 大小写敏感：'Note' 不是合法实体类型，避免协议里出现两种写法
  assert.equal(isSyncEntityType("Note"), false);
  assert.equal(isSyncEntityType(undefined), false);
  assert.equal(isSyncEntityType(null), false);
  assert.equal(isSyncEntityType(42), false);
});

test("操作类型只允许 upsert 与 delete", () => {
  assert.deepEqual([...SYNC_OPERATIONS], ["upsert", "delete"]);
  assert.equal(isSyncOperation("upsert"), true);
  assert.equal(isSyncOperation("delete"), true);
  assert.equal(isSyncOperation("update"), false);
  assert.equal(isSyncOperation("create"), false);
  assert.equal(isSyncOperation(""), false);
  assert.equal(isSyncOperation(null), false);
});

test("V2 协议前缀与 V1 完全隔离，旧客户端路径不受影响", () => {
  assert.equal(SYNC_V2_BASE_PATH, "/api/sync/v2");
  assert.ok(!SYNC_V2_BASE_PATH.startsWith("/api/offline-sync"));
});

test("退避节奏单调不减，越界后收敛到最后一档而不是无限增长", () => {
  for (let i = 1; i < SYNC_RETRY_BACKOFF_MS.length; i += 1) {
    assert.ok(SYNC_RETRY_BACKOFF_MS[i] > SYNC_RETRY_BACKOFF_MS[i - 1]);
  }
  const last = SYNC_RETRY_BACKOFF_MS[SYNC_RETRY_BACKOFF_MS.length - 1];
  assert.equal(syncRetryDelayMs(0), SYNC_RETRY_BACKOFF_MS[0]);
  assert.equal(syncRetryDelayMs(-5), SYNC_RETRY_BACKOFF_MS[0]);
  assert.equal(syncRetryDelayMs(1), SYNC_RETRY_BACKOFF_MS[1]);
  assert.equal(syncRetryDelayMs(999), last);
  assert.equal(syncRetryDelayMs(Number.NaN), SYNC_RETRY_BACKOFF_MS[0]);
});

test("只有网络与服务端错误可自动重试，冲突/授权/重置需要介入", () => {
  assert.equal(isRetryableSyncError("NETWORK_UNAVAILABLE"), true);
  assert.equal(isRetryableSyncError("SERVER_ERROR"), true);
  assert.equal(isRetryableSyncError("VERSION_CONFLICT"), false);
  assert.equal(isRetryableSyncError("AUTH_EXPIRED"), false);
  assert.equal(isRetryableSyncError("SYNC_RESET_REQUIRED"), false);
  assert.equal(isRetryableSyncError("INVALID_PAYLOAD"), false);
  assert.equal(isSyncErrorCode("VERSION_CONFLICT"), true);
  assert.equal(isSyncErrorCode("SOMETHING_ELSE"), false);
});

test("SyncError 保留错误码与可重试语义", () => {
  const conflict = new SyncError("VERSION_CONFLICT");
  assert.equal(conflict.code, "VERSION_CONFLICT");
  assert.equal(conflict.retryable, false);
  assert.ok(conflict instanceof Error);

  const network = new SyncError("NETWORK_UNAVAILABLE", "远端不可达");
  assert.equal(network.retryable, true);
  assert.equal(network.message, "远端不可达");
});

test("默认不处于 outbox 抑制上下文，用户写入始终会入队", () => {
  assert.equal(isOutboxSuppressed(), false);
  assert.doesNotThrow(() => assertNotOutboxSuppressed("updateNote"));
});

test("抑制上下文仅在回调内生效，且支持嵌套", () => {
  const observed = runWithOutboxSuppressed(() => {
    assert.equal(isOutboxSuppressed(), true);
    return runWithOutboxSuppressed(() => isOutboxSuppressed());
  });
  assert.equal(observed, true);
  assert.equal(isOutboxSuppressed(), false);
});

test("抑制上下文抛异常后必须自动恢复，避免同步状态永久卡住", () => {
  assert.throws(() => {
    runWithOutboxSuppressed(() => {
      throw new Error("apply failed");
    });
  }, /apply failed/);
  assert.equal(isOutboxSuppressed(), false);
});

test("异步 apply 结束后抑制状态不泄漏到后续用户写入", async () => {
  await runWithOutboxSuppressed(async () => {
    assert.equal(isOutboxSuppressed(), true);
    await Promise.resolve();
    assert.equal(isOutboxSuppressed(), true);
  });
  assert.equal(isOutboxSuppressed(), false);
});

test("在抑制上下文中提交用户写入必须报错，而不是静默丢失修改", () => {
  runWithOutboxSuppressed(() => {
    assert.throws(
      () => assertNotOutboxSuppressed("updateNote"),
      /updateNote/,
    );
  });
});

test("同步日志按白名单输出，绝不泄漏正文与凭据", () => {
  const line = formatSyncLog("push.done", {
    profileId: "p1",
    deviceId: "d1",
    pushCount: 3,
    conflictCount: 1,
    durationMs: 42,
  });
  assert.equal(
    line,
    "[sync-v2] push.done profileId=p1 deviceId=d1 pushCount=3 conflictCount=1 durationMs=42",
  );

  const leaky = formatSyncLog("push.done", {
    profileId: "p1",
    // 未列入白名单的字段必须被丢弃
    ...({ content: "笔记正文", token: "secret-token", password: "hunter2" } as Record<string, never>),
  });
  assert.equal(leaky, "[sync-v2] push.done profileId=p1");
  assert.ok(!leaky.includes("笔记正文"));
  assert.ok(!leaky.includes("secret-token"));
  assert.ok(!leaky.includes("hunter2"));
});

test("日志跳过空值并截断超长标识符，避免误传 payload", () => {
  assert.equal(formatSyncLog("pull.start"), "[sync-v2] pull.start");
  assert.equal(
    formatSyncLog("pull.start", { profileId: "", deviceId: null }),
    "[sync-v2] pull.start",
  );
  const long = formatSyncLog("apply.item", { entityId: "x".repeat(500) });
  assert.ok(long.length < 200);
});

test("数值 0 必须保留：游标停在起点是诊断同步问题的关键信息", () => {
  assert.equal(
    formatSyncLog("pull.start", { pullSequence: 0, pendingCount: 0 }),
    "[sync-v2] pull.start pullSequence=0 pendingCount=0",
  );
});
