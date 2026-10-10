const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  attachWindowStatePersistence,
  normalizeStoredWindowState,
  resolveWindowBounds,
} = require("../window-state");
const { readSettings, setSettingsPath, writeSettings } = require("../settings");

const primaryWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };

test("normalizes persisted bounds and preserves maximized state", () => {
  assert.deepEqual(normalizeStoredWindowState({
    x: 123.8,
    y: 45.2,
    width: 720,
    height: 480,
    maximized: true,
  }), {
    x: 124,
    y: 45,
    width: 900,
    height: 600,
    maximized: true,
  });
  assert.equal(normalizeStoredWindowState({ x: "bad", y: 0, width: 1200, height: 800 }), null);
});

test("restores saved bounds on the display that still contains them", () => {
  const restored = resolveWindowBounds(
    { x: 2200, y: 120, width: 1400, height: 850, maximized: false },
    [primaryWorkArea, { x: 1920, y: 0, width: 2560, height: 1400 }],
    primaryWorkArea,
  );

  assert.deepEqual(restored, {
    bounds: { x: 2200, y: 120, width: 1400, height: 850 },
    maximized: false,
  });
});

test("keeps partially visible and cross-display bounds unchanged", () => {
  const secondaryWorkArea = { x: 1920, y: 0, width: 2560, height: 1400 };
  const partiallyVisible = resolveWindowBounds(
    { x: 1800, y: 100, width: 1280, height: 800, maximized: false },
    [primaryWorkArea],
    primaryWorkArea,
  );
  const crossDisplay = resolveWindowBounds(
    { x: 1600, y: 80, width: 1200, height: 900, maximized: false },
    [primaryWorkArea, secondaryWorkArea],
    primaryWorkArea,
  );

  assert.deepEqual(partiallyVisible.bounds, { x: 1800, y: 100, width: 1280, height: 800 });
  assert.deepEqual(crossDisplay.bounds, { x: 1600, y: 80, width: 1200, height: 900 });
});

test("moves a window from a disconnected display back to the primary display", () => {
  const restored = resolveWindowBounds(
    { x: 3200, y: 200, width: 1280, height: 800, maximized: true },
    [primaryWorkArea],
    primaryWorkArea,
  );

  assert.deepEqual(restored, {
    bounds: { x: 320, y: 120, width: 1280, height: 800 },
    maximized: true,
  });
});

test("fits oversized saved bounds into the current display work area", () => {
  const compactWorkArea = { x: 0, y: 0, width: 1366, height: 728 };
  const restored = resolveWindowBounds(
    { x: 4000, y: 80, width: 1800, height: 1000, maximized: false },
    [compactWorkArea],
    compactWorkArea,
  );

  assert.deepEqual(restored.bounds, { x: 0, y: 0, width: 1366, height: 728 });
});

test("persists normal bounds after window changes and on close", async () => {
  class FakeWindow extends EventEmitter {
    getNormalBounds() {
      return { x: 140, y: 90, width: 1500, height: 900 };
    }
    isMaximized() {
      return true;
    }
    isDestroyed() {
      return false;
    }
  }

  const fakeWindow = new FakeWindow();
  const snapshots = [];
  attachWindowStatePersistence(fakeWindow, (state) => snapshots.push(state), { debounceMs: 1 });

  fakeWindow.emit("move");
  await new Promise((resolve) => setTimeout(resolve, 10));
  fakeWindow.emit("close");

  assert.deepEqual(snapshots.at(-1), {
    x: 140,
    y: 90,
    width: 1500,
    height: 900,
    maximized: true,
  });
  assert.ok(snapshots.length >= 2);
});

test("settings.json keeps window state across a fresh read", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-window-state-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  setSettingsPath(tempRoot);
  writeSettings({
    windowState: { x: 40, y: 60, width: 1440, height: 900, maximized: false },
  });
  setSettingsPath(tempRoot);

  assert.deepEqual(readSettings().windowState, {
    x: 40,
    y: 60,
    width: 1440,
    height: 900,
    maximized: false,
  });
});
