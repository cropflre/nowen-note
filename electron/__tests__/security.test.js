const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachPluginFrameGuard, isAllowedMainWindowNavigation, shouldBlockPluginFrameNavigation } = require("../security");

const pluginDocument = (ticket = "a") => `http://127.0.0.1:5000/api/plugin-ui-v3/${ticket.repeat(64)}`;

test("a plugin UI frame cannot navigate itself away from its one-use document", () => {
  const webContents = new EventEmitter();
  webContents.mainFrame = { frameTreeNodeId: 1 };
  let blocked = 0;
  attachPluginFrameGuard(webContents, () => { blocked += 1; });
  const navigate = (details) => {
    let prevented = false;
    webContents.emit("will-frame-navigate", { ...details, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const pluginFrame = { frameTreeNodeId: 7, url: pluginDocument() };
  // Its own script, a child frame inside it, or an unknown initiator.
  assert.equal(navigate({ isMainFrame: false, frame: pluginFrame, initiator: pluginFrame, url: "https://attacker.example/?data=1" }), true);
  assert.equal(navigate({ isMainFrame: false, frame: pluginFrame, initiator: { frameTreeNodeId: 8 }, url: "https://attacker.example/" }), true);
  assert.equal(navigate({ isMainFrame: false, frame: pluginFrame, initiator: null, url: pluginDocument() }), true);
  assert.equal(blocked, 3);
  // The host page may replace the frame; the first load, other frames and the main frame are not affected.
  assert.equal(navigate({ isMainFrame: false, frame: pluginFrame, initiator: webContents.mainFrame, url: pluginDocument("b") }), false);
  assert.equal(navigate({ isMainFrame: false, frame: { frameTreeNodeId: 9, url: "" }, initiator: webContents.mainFrame, url: pluginDocument() }), false);
  assert.equal(navigate({ isMainFrame: false, frame: { frameTreeNodeId: 10, url: "https://www.youtube.com/embed/x" }, initiator: { frameTreeNodeId: 10 }, url: "https://www.youtube.com/watch?v=x" }), false);
  assert.equal(navigate({ isMainFrame: true, frame: webContents.mainFrame, initiator: null, url: "file:///index.html" }), false);
  assert.equal(blocked, 3);
});

test("only a one-use ticket document over http(s) counts as plugin UI", () => {
  for (const url of [pluginDocument(), `https://notes.example/sub/api/plugin-ui-v3/${"f".repeat(64)}`]) {
    assert.equal(shouldBlockPluginFrameNavigation({ isMainFrame: false, frameUrl: url, initiatorIsHost: false }), true);
  }
  for (const url of [`file:///api/plugin-ui-v3/${"a".repeat(64)}`, "http://127.0.0.1:5000/api/plugin-ui-v3/short", "about:blank", "", undefined, "not a url"]) {
    assert.equal(shouldBlockPluginFrameNavigation({ isMainFrame: false, frameUrl: url, initiatorIsHost: false }), false);
  }
});

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
