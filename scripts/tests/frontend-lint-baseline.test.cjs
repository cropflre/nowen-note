const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { compare, fingerprint } = require("../frontend-lint-baseline.cjs");

const root = path.resolve("frontend");
const error = { severity: 2, ruleId: "example/rule", message: "Known error", line: 1, column: 1 };
const known = fingerprint("src/example.ts", error, "old code");
const baseline = { errors: { [known]: 1 } };
const report = (messages, source, file = "src/example.ts") => compare([
  { filePath: path.join(root, file), messages },
], root, baseline, () => source);

test("a moved historical diagnostic remains recognized", () => {
  assert.deepEqual(report([{ ...error, line: 3 }], "\n\n  old code  \n"), { existing: 1, added: [] });
});
test("changed source and a new file cannot consume historical allowances", () => {
  assert.equal(report([error], "new code").added.length, 1);
  assert.equal(report([error], "old code", "src/new.ts").added.length, 1);
});
test("additional occurrences fail even with an identical fingerprint", () => {
  const result = report([error, { ...error, line: 2 }], "old code\nold code");
  assert.equal(result.existing, 1);
  assert.equal(result.added.length, 1);
});
test("fatal parsing errors always fail and warnings do not consume allowances", () => {
  assert.equal(report([{ ...error, fatal: true }], "old code").added.length, 1);
  assert.deepEqual(report([{ ...error, severity: 1 }, error], "old code"), { existing: 1, added: [] });
});
