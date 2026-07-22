const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("main window allows the fullscreen permission required by native video controls", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

  assert.match(source, /permission === "notifications" \|\| permission === "fullscreen"/);
});
