import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const routeSource = fs.readFileSync(
  path.resolve(__dirname, "../src/routes/task-reminders.ts"),
  "utf8",
);

const operationsSource = fs.readFileSync(
  path.resolve(__dirname, "../src/repositories/taskReminderOperationsRepository.ts"),
  "utf8",
);

test("task-reminders route keeps database access behind repositories", () => {
  assert.doesNotMatch(routeSource, /from\s+["']\.\.\/db\/schema["']/);
  assert.doesNotMatch(routeSource, /\bgetDb\s*\(/);
  assert.doesNotMatch(routeSource, /\.prepare\s*\(/);
  assert.match(routeSource, /listOverviewAsync/);
  assert.match(routeSource, /getTaskScopeAsync/);
  assert.match(routeSource, /createAsync/);
  assert.match(routeSource, /updateAsync/);
  assert.match(routeSource, /deleteAsync/);
});

test("task reminder operations expose runtime Adapter and sync scanner compatibility", () => {
  assert.match(operationsSource, /getDatabaseAdapter/);
  assert.match(operationsSource, /listOverviewAsync/);
  assert.match(operationsSource, /booleanValue\(true, dialect\)/);
  assert.match(operationsSource, /nowExpression\(dialect\)/);
  assert.match(operationsSource, /listDueCandidates\s*\(/);
  assert.match(operationsSource, /getDb\s*\(/);
});
