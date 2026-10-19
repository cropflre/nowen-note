import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema.js";
import router, { dispatchScheduledTaskDigests } from "../src/routes/task-digest.js";
import { initWebhookTables, webhookDispatcher, type WebhookEvent } from "../src/services/webhook.js";

test("Issue #867 task push timestamps use the configured timezone without shifting the instant", async (t) => {
  const db = getDb();
  initWebhookTables();
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('timestamp-user','timestamp-user','hash')").run();
  db.prepare("INSERT INTO webhooks(id,userId,url,secret,events) VALUES ('timestamp-hook','timestamp-user','https://example.com/hook','test-secret','[\"*\"]')").run();
  const app = new Hono();
  app.route("/api/task-digest", router);
  const headers = { "X-User-Id": "timestamp-user", "Content-Type": "application/json" };
  const captured: Array<{ body: string; headers: Record<string, string> }> = [];
  t.mock.method(dns, "resolveCname", async () => []);
  t.mock.method(dns, "resolve4", async () => ["93.184.216.34"]);
  t.mock.method(dns, "resolve6", async () => []);
  t.mock.method(https, "request", ((_url: URL, options: https.RequestOptions, callback: (response: Readable) => void) => {
    const chunks: Buffer[] = [];
    const outgoing = new EventEmitter() as any;
    outgoing.write = (chunk: Buffer) => chunks.push(Buffer.from(chunk));
    outgoing.end = () => queueMicrotask(() => {
      captured.push({ body: Buffer.concat(chunks).toString(), headers: options.headers as Record<string, string> });
      const incoming = Readable.from([Buffer.from(_url.hostname.endsWith("pushplus.plus") ? '{"code":200,"msg":"success"}' : "ok")]) as any;
      incoming.statusCode = 200;
      incoming.headers = {};
      callback(incoming);
    });
    outgoing.destroy = (error: Error) => outgoing.emit("error", error);
    return outgoing;
  }) as any);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T01:00:00.123Z") });

  async function save(timezone: string) {
    const response = await app.request("/api/task-digest", {
      method: "PUT", headers,
      body: JSON.stringify({ morningEnabled: true, eveningEnabled: true, dueEnabled: true,
        morningTime: "09:00", eveningTime: "21:00", timezone }),
    });
    assert.equal(response.status, 200);
  }

  async function deliveries(expected: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhookId='timestamp-hook'").get() as { n: number };
      if (row.n === expected) break;
      await setImmediate();
    }
    const rows = db.prepare("SELECT payload,success FROM webhook_deliveries WHERE webhookId='timestamp-hook'").all() as Array<{ payload: string; success: number }>;
    assert.equal(rows.length, expected);
    for (const request of captured) {
      assert.equal(request.headers["x-nowen-signature"], `sha256=${crypto.createHmac("sha256", "test-secret").update(request.body).digest("hex")}`);
      assert.ok(rows.some((row) => row.payload === request.body && row.success === 1));
    }
    return captured.map((request) => JSON.parse(request.body));
  }

  try {
    await t.test("scheduled morning and deadline pushes use Asia/Shanghai even on a UTC server", async () => {
      await save("Asia/Shanghai");
      db.prepare("INSERT INTO tasks(id,userId,title,dueAt) VALUES ('timestamp-task','timestamp-user','Reminder','2026-10-08T09:00:00')").run();
      assert.equal(dispatchScheduledTaskDigests(), 2);
      assert.equal(dispatchScheduledTaskDigests(), 0);
      const payloads = await deliveries(2);
      assert.deepEqual(new Set(payloads.map((payload) => payload.event)), new Set(["task.due", "task.digest.morning"]));
      for (const payload of payloads) {
        assert.equal(payload.timestamp, "2026-10-08T09:00:00.123+08:00");
        assert.equal(Date.parse(payload.timestamp), Date.now());
        assert.equal(payload.data.timezone, "Asia/Shanghai");
      }
    });

    for (const fixture of [
      { timezone: "Asia/Shanghai", now: "2026-10-08T16:30:00.123Z", expected: "2026-10-09T00:30:00.123+08:00" },
      { timezone: "Asia/Kolkata", now: "2026-10-08T01:00:00.123Z", expected: "2026-10-08T06:30:00.123+05:30" },
      { timezone: "America/New_York", now: "2026-01-08T01:00:00.123Z", expected: "2026-01-07T20:00:00.123-05:00" },
      { timezone: "America/New_York", now: "2026-07-08T01:00:00.123Z", expected: "2026-07-07T21:00:00.123-04:00" },
      { timezone: "UTC", now: "2026-10-08T01:00:00.123Z", expected: "2026-10-08T01:00:00.123+00:00" },
    ]) {
      await t.test(`test push uses ${fixture.timezone} at ${fixture.now}`, async () => {
        t.mock.timers.setTime(Date.parse(fixture.now));
        await save(fixture.timezone);
        const expectedCount = captured.length + 1;
        const response = await app.request("/api/task-digest/test", { method: "POST", headers, body: JSON.stringify({ kind: "evening" }) });
        assert.equal(response.status, 200);
        const payload = (await deliveries(expectedCount)).at(-1);
        assert.equal(payload.event, "task.digest.evening");
        assert.equal(payload.timestamp, fixture.expected);
        assert.equal(Date.parse(payload.timestamp), Date.parse(fixture.now));
        assert.equal(payload.data.date, fixture.expected.slice(0, 10));
        assert.equal(payload.data.test, true);
      });
    }

    for (const fixture of [
      { event: "task.created", data: { timezone: "Asia/Shanghai" } },
      { event: "task.digest.morning", data: {} },
      { event: "task.due", data: { timezone: "Invalid/Nowhere" } },
    ]) {
      await t.test(`${fixture.event} keeps UTC for unrelated events or unavailable timezones`, async () => {
        const expectedCount = captured.length + 1;
        await webhookDispatcher.emit(fixture.event as WebhookEvent, "timestamp-user", fixture.data);
        const payload = (await deliveries(expectedCount)).at(-1);
        assert.equal(payload.timestamp, new Date().toISOString());
      });
    }
    await t.test("PushPlus JSON webhook gets a readable Chinese digest without leaking its token", async () => {
      t.mock.timers.setTime(new Date("2026-10-08T01:00:00.123Z"));
      await save("Asia/Shanghai");
      db.prepare("UPDATE webhooks SET url=? WHERE id='timestamp-hook'")
        .run("https://www.pushplus.plus/send/sample-secret-token?template=json");
      const expectedCount = captured.length + 1;
      const response = await app.request("/api/task-digest/test", {
        method: "POST", headers, body: JSON.stringify({ kind: "evening" }),
      });
      assert.equal(response.status, 200);
      const payload = (await deliveries(expectedCount)).at(-1);
      assert.equal(payload["标题"], "每日任务简报 · 晚间总结（测试）");
      assert.equal(payload["日期"], "2026-10-08");
      assert.equal(payload["推送时间"], "2026-10-08 09:00:00+08:00（Asia/Shanghai）");
      assert.deepEqual(payload["任务统计"], {
        "今日到期": 1, "今日待完成": 1, "今日到期已完成": 0,
        "今日已完成": 0, "逾期未完成": 0,
      });
      assert.equal("event" in payload, false);
      assert.equal(JSON.stringify(payload).includes("sample-secret-token"), false);
    });

    await t.test("PushPlus task deadline has localized task labels", async () => {
      const expectedCount = captured.length + 1;
      await webhookDispatcher.emit("task.due", "timestamp-user", {
        timezone: "Asia/Shanghai", title: "完成回归", dueAt: "2026-10-08T09:00:00",
      });
      const payload = (await deliveries(expectedCount)).at(-1);
      assert.equal(payload["标题"], "任务到点提醒");
      assert.equal(payload["任务名称"], "完成回归");
      assert.equal(payload["截止时间"], "2026-10-08 09:00:00");
    });
  } finally {
    t.mock.timers.reset();
    t.mock.restoreAll();
    closeDb();
  }
});
