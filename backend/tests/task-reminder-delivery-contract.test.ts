import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const indexSource = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/routes/task-reminders.ts", import.meta.url), "utf8");

test("task reminders are acknowledged after delivery instead of during scanning", () => {
  assert.match(indexSource, /task-reminders\/recent\/ack/);
  assert.match(indexSource, /markReminderNotified\(item\.reminderId\)/);
  assert.doesNotMatch(indexSource, /recentReminders\.push\(\{ \.\.\.r[^;]+;\s*markReminderNotified\(r\.reminderId\)/s);
});

test("native clients can fetch a future reminder schedule", () => {
  assert.match(routeSource, /taskReminders\.get\("\/schedule"/);
  assert.match(routeSource, /snoozedUntil/);
  assert.match(routeSource, /workspaceId/);
});
