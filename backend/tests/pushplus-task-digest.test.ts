import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPushPlusTaskEvent,
  isPushPlusAccepted,
  isPushPlusJsonWebhook,
} from "../src/services/pushPlusDigest.js";

test("PushPlus adaptation only applies to verified JSON webhook destinations", () => {
  assert.equal(isPushPlusJsonWebhook("https://www.pushplus.plus/send/example-token?template=json"), true);
  assert.equal(isPushPlusJsonWebhook("https://pushplus.plus/send/example-token/?template=JSON"), true);
  assert.equal(isPushPlusJsonWebhook("https://www.pushplus.plus/send?token=example&template=json"), true);
  assert.equal(isPushPlusJsonWebhook("https://api.pushplus.plus/send/example?template=json"), true);
  assert.equal(isPushPlusJsonWebhook("https://www.pushplus.plus/send/example-token?template=markdown"), false);
  assert.equal(isPushPlusJsonWebhook("https://www.pushplus.plus/send/example-token"), false);
  assert.equal(isPushPlusJsonWebhook("https://www.pushplus.plus.evil.example/send/example?template=json"), false);
  assert.equal(isPushPlusJsonWebhook("https://evil.example/?next=www.pushplus.plus/send/test&template=json"), false);
  assert.equal(isPushPlusJsonWebhook("http://www.pushplus.plus/send/example?template=json"), false);
  assert.equal(isPushPlusJsonWebhook("https://www.pushplus.plus:9443/send/example?template=json"), false);
  assert.equal(isPushPlusJsonWebhook("not-a-url"), false);
});

test("Chinese summary keeps the local date/time and never repeats private task IDs", () => {
  const body = formatPushPlusTaskEvent("task.digest.evening", "2026-10-19T16:45:09.076+08:00", {
    kind: "evening", date: "2026-10-19", timezone: "Asia/Shanghai",
    test: true,
    summary: "今日完成 2 项，尚未完成 1 项",
    counts: { dueToday: 3, pendingToday: 1, completedDueToday: 2, completedToday: 2, overdue: 0 },
    tasks: [{ taskId: "private-id", title: "完成前端回归" }, { title: "准备日报" }],
  });
  assert.equal(body["标题"], "每日任务简报 · 晚间总结（测试）");
  assert.equal(body["日期"], "2026-10-19");
  assert.equal(body["推送时间"], "2026-10-19 16:45:09+08:00（Asia/Shanghai）");
  assert.deepEqual(body["重点任务"], ["完成前端回归", "准备日报"]);
  assert.equal((body["任务统计"] as Record<string, unknown>)["今日已完成"], 2);
  assert.equal(JSON.stringify(body).includes("private-id"), false);
});

test("empty digest and due-time push remain readable", () => {
  const empty = formatPushPlusTaskEvent("task.digest.morning", "2026-10-19T09:00:00.000+08:00", {
    date: "2026-10-19", timezone: "Asia/Shanghai", counts: {},
    tasks: [],
  });
  assert.equal(empty["重点任务"], "暂无需要关注的任务");
  const due = formatPushPlusTaskEvent("task.due", "2026-10-19T09:00:00.000+08:00", {
    title: "代码复查", timezone: "Asia/Shanghai", dueAt: "2026-10-19T09:30:00",
  });
  assert.equal(due["任务名称"], "代码复查");
  assert.equal(due["截止时间"], "2026-10-19 09:30:00");
});

test("PushPlus HTTP 200 with a non-success API code is not accepted", () => {
  assert.equal(isPushPlusAccepted('{"code":200,"msg":"执行成功"}'), true);
  assert.equal(isPushPlusAccepted('{"code":500,"msg":"令牌无效"}'), false);
  assert.equal(isPushPlusAccepted("ok"), false);
  assert.equal(isPushPlusAccepted("{}"), false);
});
