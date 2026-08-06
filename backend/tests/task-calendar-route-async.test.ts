import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const routeSource = fs.readFileSync(
  path.resolve(__dirname, "../src/routes/task-calendar.ts"),
  "utf8",
);

const operationsSource = fs.readFileSync(
  path.resolve(__dirname, "../src/repositories/taskCalendarOperationsRepository.ts"),
  "utf8",
);

test("task-calendar route keeps database access behind repositories", () => {
  assert.doesNotMatch(routeSource, /from\s+["']\.\.\/db\/schema["']/);
  assert.doesNotMatch(routeSource, /\bgetDb\s*\(/);
  assert.doesNotMatch(routeSource, /\.prepare\s*\(/);
  assert.match(routeSource, /getByUserAsync/);
  assert.match(routeSource, /loadFeedDataAsync/);
});

test("task calendar operations expose async Adapter and sync compatibility paths", () => {
  assert.match(operationsSource, /getDatabaseAdapter/);
  assert.match(operationsSource, /loadFeedDataAsync/);
  assert.match(operationsSource, /loadFeedData\s*\(/);
  assert.match(operationsSource, /booleanValue\(false, dialect\)/);
  assert.match(operationsSource, /booleanValue\(true, dialect\)/);
});
