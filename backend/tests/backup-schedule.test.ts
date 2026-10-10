import assert from "node:assert/strict";
import test from "node:test";
import { isValidBackupTimeZone, nextDailyBackupRunAt } from "../src/services/backup-schedule";

test("Issue #816: 03:15 Shanghai backup is 19:15Z, not 03:15Z on a UTC Docker host", () => {
  const at = new Date("2026-10-10T18:00:00.000Z"); // Shanghai 02:00, Oct 11
  assert.equal(nextDailyBackupRunAt("03:15", "Asia/Shanghai", at).toISOString(),
    "2026-10-10T19:15:00.000Z");
  assert.equal(nextDailyBackupRunAt("03:15", "UTC", at).toISOString(),
    "2026-10-11T03:15:00.000Z");
});

test("daily scheduled time rolls to next calendar date if today's instant passed", () => {
  assert.equal(nextDailyBackupRunAt("03:15", "Asia/Shanghai",
    new Date("2026-10-10T20:00:00.000Z")).toISOString(),
    "2026-10-11T19:15:00.000Z");
});

test("time zone definitions are validated and do not accept malformed zones", () => {
  assert.equal(isValidBackupTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidBackupTimeZone("America/New_York"), true);
  assert.equal(isValidBackupTimeZone("invalid/unknown"), false);
  assert.equal(isValidBackupTimeZone(""), false);
  assert.throws(() => nextDailyBackupRunAt("25:00", "Asia/Shanghai"), /Invalid daily backup time/);
  assert.throws(() => nextDailyBackupRunAt("03:00", "invalid/unknown"), /Invalid backup time zone/);
});

test("New York daily backup follows daylight saving offset", () => {
  // March 7: New York EST, March 9: EDT (DST begins March 8, 2026).
  assert.equal(nextDailyBackupRunAt("03:15", "America/New_York",
    new Date("2026-03-07T06:00:00.000Z")).toISOString(), "2026-03-07T08:15:00.000Z");
  assert.equal(nextDailyBackupRunAt("03:15", "America/New_York",
    new Date("2026-03-09T06:00:00.000Z")).toISOString(), "2026-03-09T07:15:00.000Z");
});

test("legacy schedules preserve server-local wall-time semantics when zone is omitted", () => {
  const anchor = new Date("2026-10-10T14:00:00.000Z");
  const next = nextDailyBackupRunAt("03:15", undefined, anchor);
  assert.equal(next.getHours(), 3);
  assert.equal(next.getMinutes(), 15);
  assert.ok(next.getTime() > anchor.getTime());
});
