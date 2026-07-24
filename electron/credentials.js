// electron/credentials.js
// Secure remember-login storage.
const { ipcMain, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

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
  return { version: 2 };
}

function normalizeRaw(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    version: 2,
    remember: raw.remember && typeof raw.remember === "object" ? raw.remember : undefined,
    autoLogin: !!raw.autoLogin,
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : undefined,
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
  if (raw.remember) return writeRaw(raw);
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

function registerCredentialsIpc() {
  const { assertMainWindowSender } = require("./security");
  const secure = (event) => assertMainWindowSender(event);

  ipcMain.removeHandler("credentials:load");
  ipcMain.handle("credentials:load", (event) => {
    const reject = secure(event); if (reject) return reject;
    const data = load();
    if (!data) return null;
    const summary = { serverUrl: data.serverUrl, username: data.username, hasPassword: data.hasPassword, autoLogin: data.autoLogin };
    if (data.autoLogin && data.hasPassword) summary.password = data.password;
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

}

module.exports = {
  setCredentialsPath,
  registerCredentialsIpc,
  load,
  save,
  clear,
};
