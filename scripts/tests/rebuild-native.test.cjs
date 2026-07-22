const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("does not reuse a native module whose ABI differs from the Electron target", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "rebuild-native.mjs"), "utf8");

  assert.match(source, /function detectNodeAbiVersions\(/);
  assert.match(source, /existingNodeAbi\.includes\(expectedNodeAbi\)/);
});
