const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedMainWindowNavigation } = require("../security");

const indexUrl = "file:///Users/example/nowen-note/frontend/dist/index.html?serverUrl=http%3A%2F%2F127.0.0.1%3A5000";

test("allows reloading the current local frontend entry", () => {
  assert.equal(isAllowedMainWindowNavigation(indexUrl, indexUrl), true);
  assert.equal(
    isAllowedMainWindowNavigation("file:///Users/example/nowen-note/frontend/dist/index.html?serverUrl=http%3A%2F%2F127.0.0.1%3A5001", indexUrl),
    true,
  );
});

test("blocks navigation from the frontend entry to another local file", () => {
  assert.equal(
    isAllowedMainWindowNavigation("file:///Users/example/.ssh/id_rsa", indexUrl),
    false,
  );
});
