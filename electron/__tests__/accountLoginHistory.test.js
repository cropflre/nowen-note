const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function loadCredentialsWithSafeStorage() {
  const originalLoad = Module._load;
  const handlers = new Map();
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        ipcMain: {
          removeHandler(channel) { handlers.delete(channel); },
          handle(channel, handler) { handlers.set(channel, handler); },
        },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
          decryptString: (buffer) => {
            const value = buffer.toString("utf8");
            if (!value.startsWith("encrypted:")) throw new Error("cipher damaged");
            return value.slice("encrypted:".length);
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  const modulePath = require.resolve("../credentials");
  delete require.cache[modulePath];
  try {
    return { credentials: require(modulePath), handlers };
  } finally {
    Module._load = originalLoad;
  }
}

test("桌面端记住密码后可在登录页回填，且磁盘不保存明文", async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-remember-login-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { credentials, handlers } = loadCredentialsWithSafeStorage();
  credentials.setCredentialsPath(userDataPath);

  const saved = credentials.save({
    remember: true,
    autoLogin: false,
    serverUrl: "https://notes.example.com",
    username: "alice",
    password: "secret-password",
  });
  assert.equal(saved.ok, true);

  const originalLoad = Module._load;
  Module._load = function patchedSecurityLoad(request, parent, isMain) {
    if (request === "./security") return { assertMainWindowSender: () => null };
    return originalLoad(request, parent, isMain);
  };
  try {
    credentials.registerCredentialsIpc();
  } finally {
    Module._load = originalLoad;
  }
  const loaded = await handlers.get("credentials:load")({});
  assert.equal(loaded.username, "alice");
  assert.equal(loaded.password, "secret-password");
  assert.equal(loaded.autoLogin, false);

  const rawText = fs.readFileSync(path.join(userDataPath, "credentials.json"), "utf8");
  assert.equal(rawText.includes("secret-password"), false);
});

test("桌面端安全保存多个账号且不把 token 明文落盘", (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-account-history-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { credentials } = loadCredentialsWithSafeStorage();
  credentials.setCredentialsPath(userDataPath);

  const first = credentials.saveAccountHistory({
    serverUrl: "https://notes.example.com",
    userId: "user-1",
    username: "alice",
    displayName: "Alice",
    avatarUrl: "https://notes.example.com/avatar.png",
    token: "secret-token-1",
    lastUsedAt: 100,
  });
  const second = credentials.saveAccountHistory({
    serverUrl: "https://notes.example.com",
    userId: "user-2",
    username: "bob",
    displayName: "Bob",
    token: "secret-token-2",
    lastUsedAt: 200,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(credentials.listAccountHistory().map((item) => item.username), ["bob", "alice"]);
  assert.equal(credentials.loadAccountHistoryToken(first.id).token, "secret-token-1");

  const rawText = fs.readFileSync(path.join(userDataPath, "credentials.json"), "utf8");
  assert.equal(rawText.includes("secret-token-1"), false);
  assert.equal(rawText.includes("secret-token-2"), false);
});

test("同一服务器同一用户更新原记录，删除账号不影响其它历史", (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-account-history-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { credentials } = loadCredentialsWithSafeStorage();
  credentials.setCredentialsPath(userDataPath);

  const original = credentials.saveAccountHistory({
    serverUrl: "https://notes.example.com/",
    userId: "user-1",
    username: "alice",
    token: "old-token",
    lastUsedAt: 100,
  });
  const updated = credentials.saveAccountHistory({
    serverUrl: "https://notes.example.com",
    userId: "user-1",
    username: "alice-new",
    token: "new-token",
    lastUsedAt: 300,
  });
  const other = credentials.saveAccountHistory({
    serverUrl: "https://other.example.com",
    userId: "user-1",
    username: "alice",
    token: "other-token",
    lastUsedAt: 200,
  });

  assert.equal(updated.id, original.id);
  assert.equal(credentials.listAccountHistory().length, 2);
  assert.equal(credentials.loadAccountHistoryToken(original.id).token, "new-token");
  assert.equal(credentials.markAccountHistoryRequiresReauth(original.id).ok, true);
  assert.equal(credentials.listAccountHistory().find((item) => item.id === original.id).requiresReauth, true);
  assert.deepEqual(credentials.loadAccountHistoryToken(original.id), { ok: false, error: "TOKEN_UNAVAILABLE" });
  assert.equal(credentials.removeAccountHistory(original.id).ok, true);
  assert.deepEqual(credentials.listAccountHistory().map((item) => item.id), [other.id]);
});

test("损坏的历史令牌只标记该账号需要重新登录", (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-account-history-"));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { credentials } = loadCredentialsWithSafeStorage();
  credentials.setCredentialsPath(userDataPath);

  const saved = credentials.saveAccountHistory({
    serverUrl: "https://notes.example.com",
    userId: "user-1",
    username: "alice",
    token: "secret-token",
  });
  const file = path.join(userDataPath, "credentials.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.accountHistory[0].tokenCipher = Buffer.from("damaged", "utf8").toString("base64");
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");

  assert.deepEqual(credentials.loadAccountHistoryToken(saved.id), {
    ok: false,
    error: "TOKEN_UNAVAILABLE",
  });
  assert.equal(credentials.listAccountHistory()[0].requiresReauth, true);
});
