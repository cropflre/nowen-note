import assert from "node:assert/strict";
import test from "node:test";
import { batchInputSchema, localCalendarContext, validateComposerDates, wallTimeOccurrences } from "../src/services/task-composer";

const task = (patch = {}) => batchInputSchema.parse({ requestId: "11111111-1111-4111-8111-111111111111", previewId: "22222222-2222-4222-8222-222222222222", timezone: "UTC", tasks: [{ clientId: "draft", title: "Task", ...patch }] }).tasks[0];
test("relative calendar anchors use the user's timezone across month and year boundaries", () => {
  assert.deepEqual(localCalendarContext("Asia/Shanghai", new Date("2026-12-31T16:01:00Z")), { today: "2027-01-01", tomorrow: "2027-01-02", dayAfterTomorrow: "2027-01-03", nextMonday: "2027-01-04" });
  assert.equal(localCalendarContext("America/Los_Angeles", new Date("2026-12-31T16:01:00Z")).today, "2026-12-31");
  assert.equal(localCalendarContext("UTC", new Date("2028-02-28T23:00:00Z")).tomorrow, "2028-02-29");
  assert.equal(localCalendarContext("UTC", new Date("2026-10-12T12:00:00Z")).nextMonday, "2026-10-19");
});
test("date-only values remain calendar keys and precise time stays local without an eight-hour conversion", () => {
  const dated = task({ dueDate: "2026-12-31" }); validateComposerDates(dated, "Asia/Shanghai"); assert.equal(dated.dueDate, "2026-12-31"); assert.equal(dated.dueAt, null);
  const timed = task({ startDate: "2026-12-31T23:00", dueDate: "2027-01-01", dueAt: "2027-01-01T01:00" }); validateComposerDates(timed, "Asia/Shanghai"); assert.equal(timed.dueAt, "2027-01-01T01:00");
  for (const value of ["2026-02-29", "2026-04-31", "2026-00-20", "2026-12-32", "2026-12-31T09:00Z", "2026-12-31T09:00+08:00"]) assert.throws(() => task({ dueDate: value }));
});
test("DST gaps are rejected and ambiguous local times are flagged", () => {
  assert.equal(wallTimeOccurrences("2026-03-08T02:30", "America/New_York"), 0);
  assert.equal(wallTimeOccurrences("2026-11-01T01:30", "America/New_York"), 2);
  assert.throws(() => validateComposerDates(task({ dueDate: "2026-03-08", dueAt: "2026-03-08T02:30" }), "America/New_York"));
  assert.deepEqual(validateComposerDates(task({ dueDate: "2026-11-01", dueAt: "2026-11-01T01:30" }), "America/New_York"), ["AMBIGUOUS_LOCAL_TIME"]);
  assert.equal(wallTimeOccurrences("2026-10-04T02:15", "Australia/Lord_Howe"), 0);
});
test("date ranges, same-day all-day deadlines and recurrence constraints are explicit", () => {
  assert.deepEqual(validateComposerDates(task({ startDate: "2026-12-31T23:59", dueDate: "2026-12-31" }), "UTC"), []);
  for (const patch of [{ startDate: "2027-01-01", dueDate: "2026-12-31" }, { dueDate: "2026-12-31", dueAt: "2027-01-01T00:00" }, { repeatRule: "daily" }, { repeatRule: "weekly", dueDate: "2026-12-31", repeatEndDate: "2026-12-01" }]) assert.throws(() => validateComposerDates(task(patch), "UTC"));
  assert.deepEqual(validateComposerDates(task({ repeatRule: "daily", dueDate: "2026-12-31", repeatEndCount: 14 }), "Asia/Shanghai"), []);
});
