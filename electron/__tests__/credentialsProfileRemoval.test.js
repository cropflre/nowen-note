const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const credentials = require("../credentials");

test("读取旧凭据时删除 profiles 并保留普通登录记录", (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-credentials-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const file = path.join(userDataPath, "credentials.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    remember: { serverUrl: "http://127.0.0.1:3001", username: "alice" },
    autoLogin: false,
    profiles: { old: { username: "legacy" } },
  }), "utf8");

  credentials.setCredentialsPath(userDataPath);
  const loaded = credentials.load();
  const upgraded = JSON.parse(fs.readFileSync(file, "utf8"));

  assert.equal(loaded.username, "alice");
  assert.deepEqual(upgraded.remember, { serverUrl: "http://127.0.0.1:3001", username: "alice" });
  assert.equal(Object.hasOwn(upgraded, "profiles"), false);
});

test("不再暴露服务器 profile IPC", () => {
  const credentialsSource = fs.readFileSync(path.resolve(__dirname, "../credentials.js"), "utf8");
  const preloadSource = fs.readFileSync(path.resolve(__dirname, "../preload.js"), "utf8");
  for (const channel of [
    "credentials:profile-load",
    "credentials:profile-save",
    "credentials:profile-remove",
    "credentials:profile-list",
  ]) {
    assert.equal(credentialsSource.includes(channel), false);
    assert.equal(preloadSource.includes(channel), false);
  }
  for (const method of ["loadProfile", "saveProfile", "removeProfile", "listProfiles"]) {
    assert.equal(Object.hasOwn(credentials, method), false);
  }
});
