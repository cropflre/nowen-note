const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createRendererRecoveryGate,
  isRendererExitRecoverable,
} = require("../../electron/renderer-recovery");

test("clean renderer exits and transient failures are recoverable", () => {
  assert.equal(isRendererExitRecoverable({ reason: "clean-exit", exitCode: 0 }), true);
  assert.equal(isRendererExitRecoverable({ reason: "memory-eviction" }), true);
  assert.equal(isRendererExitRecoverable({ reason: "crashed" }), true);
  assert.equal(isRendererExitRecoverable({ reason: "launch-failed" }), false);
  assert.equal(isRendererExitRecoverable({ reason: "integrity-failure" }), false);
});

test("renderer recovery is rate limited to prevent an infinite reload loop", () => {
  let now = 10_000;
  const gate = createRendererRecoveryGate({
    maxAttempts: 2,
    windowMs: 60_000,
    now: () => now,
  });

  assert.deepEqual(gate.consume({ reason: "clean-exit" }), {
    recover: true,
    reason: "allowed",
    attempt: 1,
  });
  now += 500;
  assert.deepEqual(gate.consume({ reason: "crashed" }), {
    recover: true,
    reason: "allowed",
    attempt: 2,
  });
  now += 500;
  assert.deepEqual(gate.consume({ reason: "clean-exit" }), {
    recover: false,
    reason: "rate-limited",
    attempt: 2,
  });

  now += 60_000;
  assert.deepEqual(gate.consume({ reason: "clean-exit" }), {
    recover: true,
    reason: "allowed",
    attempt: 1,
  });
});

test("diagnostic reload returns to the application instead of reloading the error page", () => {
  const mainPath = path.resolve(__dirname, "../../electron/main.js");
  const mainSource = fs.readFileSync(mainPath, "utf8");

  assert.match(mainSource, /MAIN_WINDOW_RELOAD_URL = "nowen-reload:\/\/main"/);
  assert.match(mainSource, /reloadMainApplication\("diagnostic-page-button"\)/);
  assert.match(mainSource, /rendererRecoveryGate\.consume\(details\)/);
  assert.match(mainSource, /recoveringRenderer \|\| getIsQuitting\(\)/);
  assert.match(mainSource, /重新加载应用/);
  assert.doesNotMatch(
    mainSource,
    /<button onclick="window\.location\.reload\(\)">重新加载<\/button>/,
  );
});
