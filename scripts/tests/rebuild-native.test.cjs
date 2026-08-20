const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("does not reuse a native module whose ABI differs from the Electron target", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "rebuild-native.mjs"), "utf8");

  assert.match(source, /function detectNodeAbiVersions\(/);
  assert.match(source, /existingNodeAbi\.includes\(expectedNodeAbi\)/);
});

test("removes the build-root native module that shadows the verified Release binary", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "rebuild-native.mjs"), "utf8");
  const declarationIndex = source.indexOf(
    'const shadowingNodeFile = path.join(bsBuildDir, "better_sqlite3.node");',
  );
  const cleanupIndex = source.indexOf("rimrafSync(shadowingNodeFile);");
  const reuseCheckIndex = source.indexOf("const canReuseExisting =");

  assert.notEqual(declarationIndex, -1);
  assert.notEqual(cleanupIndex, -1);
  assert.ok(cleanupIndex > declarationIndex);
  assert.ok(cleanupIndex < reuseCheckIndex);
});
