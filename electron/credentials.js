// electron/credentials.js
// Secure remember-login storage.
const { ipcMain, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let credentialsFile = null;

function setCredentialsPath(userDataPath) {
  credentialsFile = path.join(userDataPath, "credentials.json");
}

function getFile() {
  if (!credentialsFile) throw new Error("credentials.js: setCredentialsPath() must be called first");
  return credentialsFile;
}

function encAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function emptyStore() {
  return { version: 2, accountHistory: [] };
}

function normalizeRaw(value) {
  const raw = value && typeof value === "object" ? value : {};
  const accountHistory = Array.isArray(raw.accountHistory)
    ? raw.accountHistory.filter((item) => item && typeof item === "object").map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        serverUrl: typeof item.serverUrl === "string" ? item.serverUrl : "",
        userId: typeof item.userId === "string" ? item.userId : "",
        username: typeof item.username === "string" ? item.username : "",
        displayName: typeof item.displayName === "string" ? item.displayName : "",
        avatarUrl: typeof item.avatarUrl === "string" ? item.avatarUrl : "",
        tokenCipher: typeof item.tokenCipher === "string" ? item.tokenCipher : "",
        refreshTokenCipher: typeof item.refreshTokenCipher === "string" ? item.refreshTokenCipher : "",
        lastUsedAt: Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : 0,
        requiresReauth: !!item.requiresReauth,
      })).filter((item) => item.id && item.serverUrl && item.userId && item.username)
    : [];
  return {
    version: 2,
    remember: raw.remember && typeof raw.remember === "object" ? raw.remember : undefined,
    autoLogin: !!raw.autoLogin,
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : undefined,
    accountHistory,
  };
}

function readRaw() {
  try {
    const file = getFile();
    if (!fs.existsSync(file)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    const normalized = normalizeRaw(parsed);
    if (Object.hasOwn(parsed, "profiles")) writeRaw(normalized);
    return normalized;
  } catch (error) {
    console.warn("[credentials] read failed:", error?.message || error);
    return emptyStore();
  }
}

function writeRaw(value) {
  const file = getFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeRaw(value), null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    console.warn("[credentials] write failed:", error?.message || error);
    return false;
  }
}

function maybeDeleteEmptyStore(raw) {
  if (raw.remember || raw.accountHistory?.length) return writeRaw(raw);
  try {
    const file = getFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (error) {
    console.warn("[credentials] cleanup failed:", error?.message || error);
    return false;
  }
}

function encryptSecret(value) {
  if (!value || !encAvailable()) return "";
  try { return safeStorage.encryptString(value).toString("base64"); }
  catch (error) {
    console.warn("[credentials] encrypt failed:", error?.message || error);
    return "";
  }
}

function decryptSecret(cipher) {
  if (!cipher || !encAvailable()) return "";
  const buffer = Buffer.from(cipher, "base64");
  return safeStorage.decryptString(buffer);
}

function load() {
  const raw = readRaw();
  const remember = raw.remember;
  if (!remember || typeof remember !== "object") return null;
  const out = {
    serverUrl: typeof remember.serverUrl === "string" ? remember.serverUrl : "",
    username: typeof remember.username === "string" ? remember.username : "",
    password: "",
    autoLogin: !!raw.autoLogin,
    hasPassword: false,
  };
  if (remember.passwordCipher && encAvailable()) {
    try {
      out.password = decryptSecret(remember.passwordCipher);
      out.hasPassword = !!out.password;
    } catch (error) {
      console.warn("[credentials] remember decrypt failed:", error?.message || error);
      clear();
      return null;
    }
  }
  return out.username || out.serverUrl ? out : null;
}

function save(payload) {
  try {
    if (!payload || typeof payload !== "object") return { ok: false, encrypted: false, error: "invalid payload" };
    if (!payload.remember) {
      clear();
      return { ok: true, encrypted: false };
    }
    const raw = readRaw();
    const remember = {
      serverUrl: typeof payload.serverUrl === "string" ? payload.serverUrl : "",
      username: typeof payload.username === "string" ? payload.username : "",
    };
    const cipher = encryptSecret(typeof payload.password === "string" ? payload.password : "");
    if (cipher) remember.passwordCipher = cipher;
    raw.remember = remember;
    raw.autoLogin = !!payload.autoLogin && !!cipher;
    raw.savedAt = Date.now();
    const ok = writeRaw(raw);
    return { ok, encrypted: encAvailable() };
  } catch (error) {
    return { ok: false, encrypted: false, error: error?.message || String(error) };
  }
}

function clear() {
  const raw = readRaw();
  delete raw.remember;
  raw.autoLogin = false;
  delete raw.savedAt;
  return { ok: maybeDeleteEmptyStore(raw) };
}

function normalizeHistoryServerUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

function sanitizeAccountHistoryItem(item) {
  return {
    id: item.id,
    serverUrl: item.serverUrl,
    userId: item.userId,
    username: item.username,
    displayName: item.displayName || "",
    avatarUrl: item.avatarUrl || "",
    lastUsedAt: item.lastUsedAt || 0,
    requiresReauth: !!item.requiresReauth || !item.tokenCipher,
  };
}

function listAccountHistory() {
  return readRaw().accountHistory
    .map(sanitizeAccountHistoryItem)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function saveAccountHistory(payload) {
  const serverUrl = normalizeHistoryServerUrl(payload?.serverUrl);
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  const username = typeof payload?.username === "string" ? payload.username.trim() : "";
  const token = typeof payload?.token === "string" ? payload.token : "";
  const refreshToken = typeof payload?.refreshToken === "string" ? payload.refreshToken : "";
  if (!serverUrl || !userId || !username || !token) return { ok: false, error: "INVALID_PAYLOAD" };
  const tokenCipher = encryptSecret(token);
  if (!tokenCipher) return { ok: false, error: "ENCRYPTION_UNAVAILABLE" };
  const refreshTokenCipher = refreshToken ? encryptSecret(refreshToken) : "";
  if (refreshToken && !refreshTokenCipher) return { ok: false, error: "ENCRYPTION_UNAVAILABLE" };

  const raw = readRaw();
  const existing = raw.accountHistory.find((item) => item.serverUrl === serverUrl && item.userId === userId);
  const id = existing?.id || crypto.randomUUID();
  const next = {
    id,
    serverUrl,
    userId,
    username,
    displayName: typeof payload.displayName === "string" ? payload.displayName.trim() : "",
    avatarUrl: typeof payload.avatarUrl === "string" ? payload.avatarUrl.trim() : "",
    tokenCipher,
    refreshTokenCipher,
    lastUsedAt: Number.isFinite(payload.lastUsedAt) ? payload.lastUsedAt : Date.now(),
    requiresReauth: false,
  };
  raw.accountHistory = [
    next,
    ...raw.accountHistory.filter((item) => item.id !== id),
  ];
  return writeRaw(raw) ? { ok: true, id } : { ok: false, error: "WRITE_FAILED" };
}

function loadAccountHistoryToken(id) {
  if (typeof id !== "string" || !id) return { ok: false, error: "INVALID_ID" };
  const raw = readRaw();
  const item = raw.accountHistory.find((entry) => entry.id === id);
  if (!item || !item.tokenCipher) return { ok: false, error: "TOKEN_UNAVAILABLE" };
  try {
    const token = decryptSecret(item.tokenCipher);
    if (!token) throw new Error("empty token");
    const refreshToken = item.refreshTokenCipher ? decryptSecret(item.refreshTokenCipher) : "";
    return { ok: true, token, ...(refreshToken ? { refreshToken } : {}) };
  } catch (error) {
    console.warn("[credentials] account history decrypt failed:", error?.message || error);
    item.tokenCipher = "";
    item.refreshTokenCipher = "";
    item.requiresReauth = true;
    writeRaw(raw);
    return { ok: false, error: "TOKEN_UNAVAILABLE" };
  }
}

function removeAccountHistory(id) {
  if (typeof id !== "string" || !id) return { ok: false, error: "INVALID_ID" };
  const raw = readRaw();
  raw.accountHistory = raw.accountHistory.filter((item) => item.id !== id);
  return { ok: maybeDeleteEmptyStore(raw) };
}

function markAccountHistoryRequiresReauth(id) {
  if (typeof id !== "string" || !id) return { ok: false, error: "INVALID_ID" };
  const raw = readRaw();
  const item = raw.accountHistory.find((entry) => entry.id === id);
  if (!item) return { ok: false, error: "NOT_FOUND" };
  item.tokenCipher = "";
  item.refreshTokenCipher = "";
  item.requiresReauth = true;
  return { ok: writeRaw(raw) };
}

function registerCredentialsIpc() {
  const { assertMainWindowSender } = require("./security");
  const secure = (event) => assertMainWindowSender(event);

  ipcMain.removeHandler("credentials:load");
  ipcMain.handle("credentials:load", (event) => {
    const reject = secure(event); if (reject) return reject;
    const data = load();
    if (!data) return null;
    const summary = { serverUrl: data.serverUrl, username: data.username, hasPassword: data.hasPassword, autoLogin: data.autoLogin };
    // renderer 只有在用户打开登录页时才会主动读取；safeStorage 负责静态加密，
    // “记住密码”不应被“自动登录”开关阻断，否则桌面端永远无法回填密码。
    if (data.hasPassword) summary.password = data.password;
    return summary;
  });

  ipcMain.removeHandler("credentials:save");
  ipcMain.handle("credentials:save", (event, payload) => {
    const reject = secure(event); if (reject) return reject;
    if (!payload || typeof payload !== "object") return { ok: false, error: "INVALID_PAYLOAD" };
    if (payload.serverUrl !== undefined && (typeof payload.serverUrl !== "string" || payload.serverUrl.length > 2048)) return { ok: false, error: "INVALID_SERVER_URL" };
    if (payload.username !== undefined && (typeof payload.username !== "string" || payload.username.length > 256)) return { ok: false, error: "INVALID_USERNAME" };
    if (payload.password !== undefined && (typeof payload.password !== "string" || payload.password.length > 1024)) return { ok: false, error: "INVALID_PASSWORD" };
    return save(payload);
  });

  ipcMain.removeHandler("credentials:clear");
  ipcMain.handle("credentials:clear", (event) => { const reject = secure(event); return reject || clear(); });
  ipcMain.removeHandler("credentials:is-encryption-available");
  ipcMain.handle("credentials:is-encryption-available", (event) => { const reject = secure(event); return reject || encAvailable(); });

  ipcMain.removeHandler("account-history:list");
  ipcMain.handle("account-history:list", (event) => {
    const reject = secure(event); return reject || listAccountHistory();
  });
  ipcMain.removeHandler("account-history:save");
  ipcMain.handle("account-history:save", (event, payload) => {
    const reject = secure(event); if (reject) return reject;
    if (!payload || typeof payload !== "object") return { ok: false, error: "INVALID_PAYLOAD" };
    if (typeof payload.serverUrl !== "string" || payload.serverUrl.length > 2048) return { ok: false, error: "INVALID_SERVER_URL" };
    if (typeof payload.userId !== "string" || payload.userId.length > 256) return { ok: false, error: "INVALID_USER_ID" };
    if (typeof payload.username !== "string" || payload.username.length > 256) return { ok: false, error: "INVALID_USERNAME" };
    if (typeof payload.token !== "string" || payload.token.length > 16384) return { ok: false, error: "INVALID_TOKEN" };
    if (payload.refreshToken !== undefined && (typeof payload.refreshToken !== "string" || payload.refreshToken.length > 16384)) return { ok: false, error: "INVALID_REFRESH_TOKEN" };
    if (payload.displayName !== undefined && (typeof payload.displayName !== "string" || payload.displayName.length > 256)) return { ok: false, error: "INVALID_DISPLAY_NAME" };
    if (payload.avatarUrl !== undefined && (typeof payload.avatarUrl !== "string" || payload.avatarUrl.length > 2048)) return { ok: false, error: "INVALID_AVATAR_URL" };
    return saveAccountHistory(payload);
  });
  ipcMain.removeHandler("account-history:load-token");
  ipcMain.handle("account-history:load-token", (event, id) => {
    const reject = secure(event); if (reject) return reject;
    if (typeof id !== "string" || id.length > 128) return { ok: false, error: "INVALID_ID" };
    return loadAccountHistoryToken(id);
  });
  ipcMain.removeHandler("account-history:mark-reauth");
  ipcMain.handle("account-history:mark-reauth", (event, id) => {
    const reject = secure(event); if (reject) return reject;
    if (typeof id !== "string" || id.length > 128) return { ok: false, error: "INVALID_ID" };
    return markAccountHistoryRequiresReauth(id);
  });
  ipcMain.removeHandler("account-history:remove");
  ipcMain.handle("account-history:remove", (event, id) => {
    const reject = secure(event); if (reject) return reject;
    if (typeof id !== "string" || id.length > 128) return { ok: false, error: "INVALID_ID" };
    return removeAccountHistory(id);
  });

}

module.exports = {
  setCredentialsPath,
  registerCredentialsIpc,
  load,
  save,
  clear,
  listAccountHistory,
  saveAccountHistory,
  loadAccountHistoryToken,
  markAccountHistoryRequiresReauth,
  removeAccountHistory,
};
