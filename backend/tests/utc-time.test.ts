import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSqlUtcAsIso,
  normalizeUtcDateBound,
  normalizeUtcInputToSql,
} from "../src/lib/utc-time";

test("timezone offset input is normalized to UTC SQL", () => {
  assert.equal(
    normalizeUtcInputToSql("2026-07-31T13:30:00+08:00"),
    "2026-07-31 05:30:00",
  );
});

test("UTC and SQL inputs preserve the same instant", () => {
  assert.equal(normalizeUtcInputToSql("2026-07-31T05:30:00Z"), "2026-07-31 05:30:00");
  assert.equal(normalizeUtcInputToSql("2026-07-31 05:30:00"), "2026-07-31 05:30:00");
});

test("date bounds and export metadata are unambiguous UTC", () => {
  assert.equal(normalizeUtcDateBound("2026-07-31", "to"), "2026-07-31 23:59:59");
  assert.equal(formatSqlUtcAsIso("2026-07-31 05:30:00"), "2026-07-31T05:30:00.000Z");
});
