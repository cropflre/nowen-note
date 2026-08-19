// Phase 1：Renderer 数据源选路的等价性保证。
//
// Phase 1 把 main.js 的 targetUrl 判定从 `mode === "lite"` 换成
// `runtime === "remote"`。这次替换必须是行为等价的重构，否则会出现
// 「Full 用户被指向远端」或「Lite 用户被指向空的本地库」这类灾难。
//
// 测试策略：不启动 Electron（不可行），而是复用 settings.js 的真实派生逻辑，
// 对两种判定方式做穷举比对，确保对所有 legacy 组合结论一致。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("../settings");

function readWith(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-runtime-route-"));
  try {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(raw), "utf8");
    settings.setSettingsPath(dir);
    return settings.readSettings();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Phase 1 之前 main.js 的判定：mode === "lite" && remoteUrl */
function legacyUsesRemote(value) {
  return value.mode === "lite" && !!value.remoteUrl;
}

/** Phase 1 之后 main.js 的判定：runtime === "remote" && remoteUrl */
function currentUsesRemote(value) {
  return value.runtime === "remote" && !!value.remoteUrl;
}

test("对所有 legacy 组合，新旧选路判定完全一致", () => {
  const modes = ["full", "lite", undefined, "bogus"];
  const urls = ["", "http://192.168.1.10:3000", "https://notes.example.com"];

  for (const mode of modes) {
    for (const remoteUrl of urls) {
      const value = readWith({ mode, remoteUrl });
      assert.equal(
        currentUsesRemote(value),
        legacyUsesRemote(value),
        `mode=${mode} remoteUrl=${remoteUrl} 的选路结论发生了变化`,
      );
    }
  }
});

test("Legacy Full 始终指向本机后端", () => {
  const value = readWith({ mode: "full", remoteUrl: "" });
  assert.equal(currentUsesRemote(value), false);
});

test("Legacy Lite 始终指向原远端地址，不会被误切到空的本地库", () => {
  const value = readWith({ mode: "lite", remoteUrl: "http://192.168.1.10:3000" });
  assert.equal(currentUsesRemote(value), true);
  assert.equal(value.remoteUrl, "http://192.168.1.10:3000");
});

test("Lite 迁移完成后才允许选路切到本机后端", () => {
  const before = readWith({
    mode: "lite",
    remoteUrl: "http://192.168.1.10:3000",
    liteMigrationStatus: "running",
    runtime: "local",
  });
  assert.equal(currentUsesRemote(before), true, "迁移中不得切本地");

  const after = readWith({
    mode: "lite",
    remoteUrl: "http://192.168.1.10:3000",
    liteMigrationStatus: "complete",
    runtime: "local",
  });
  assert.equal(currentUsesRemote(after), false, "迁移完成后走本地运行时");
  // legacy 字段保留，便于回滚到旧版本客户端。
  assert.equal(after.mode, "lite");
  assert.equal(after.remoteUrl, "http://192.168.1.10:3000");
});
