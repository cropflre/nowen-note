// electron/credentials.js
// Secure remember-login and per-server account vault.
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
  return { version: 2, profiles: {} };
}

function normalizeRaw(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    version: 2,
    remember: raw.remember && typeof raw.remember === "object" ? raw.remember : undefined,
    autoLogin: !!raw.autoLogin,
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : undefined,
    profiles: raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles) ? raw.profiles : {},
  };
}

function readRaw() {
  try {
    const file = getFile();
    if (!fs.existsSync(file)) return emptyStore();
    return normalizeRaw(JSON.parse(fs.readFileSync(file, "utf8")) || {});
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
  if (raw.remember || Object.keys(raw.profiles || {}).length > 0) return writeRaw(raw);
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

function validProfileId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
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

// Clearing the current login helper must not delete saved server-account profiles.
function clear() {
  const raw = readRaw();
  delete raw.remember;
  raw.autoLogin = false;
  delete raw.savedAt;
  return { ok: maybeDeleteEmptyStore(raw) };
}

function loadProfile(profileId) {
  if (!validProfileId(profileId)) return null;
  const raw = readRaw();
  const entry = raw.profiles[profileId];
  if (!entry || typeof entry !== "object") return null;
  const out = {
    profileId,
    serverUrl: typeof entry.serverUrl === "string" ? entry.serverUrl : "",
    username: typeof entry.username === "string" ? entry.username : "",
    token: "",
    password: "",
    autoLogin: !!entry.autoLogin,
    hasToken: false,
    hasPassword: false,
    savedAt: entry.savedAt,
  };
  try {
    if (entry.tokenCipher) out.token = decryptSecret(entry.tokenCipher);
    if (entry.passwordCipher) out.password = decryptSecret(entry.passwordCipher);
    out.hasToken = !!out.token;
    out.hasPassword = !!out.password;
    return out;
  } catch (error) {
    console.warn("[credentials] profile decrypt failed, removing one profile:", error?.message || error);
    delete raw.profiles[profileId];
    maybeDeleteEmptyStore(raw);
    return null;
  }
}

function saveProfile(payload) {
  try {
    if (!payload || typeof payload !== "object" || !validProfileId(payload.profileId)) {
      return { ok: false, encrypted: false, persisted: false, error: "INVALID_PROFILE" };
    }
    const raw = readRaw();
    const canEncrypt = encAvailable();
    const tokenCipher = canEncrypt ? encryptSecret(typeof payload.token === "string" ? payload.token : "") : "";
    const passwordCipher = canEncrypt ? encryptSecret(typeof payload.password === "string" ? payload.password : "") : "";
    raw.profiles[payload.profileId] = {
      serverUrl: typeof payload.serverUrl === "string" ? payload.serverUrl : "",
      username: typeof payload.username === "string" ? payload.username : "",
      tokenCipher,
      passwordCipher,
      autoLogin: !!payload.autoLogin && !!passwordCipher,
      savedAt: Date.now(),
    };
    const ok = writeRaw(raw);
    return { ok, encrypted: canEncrypt, persisted: ok && !!(tokenCipher || passwordCipher) };
  } catch (error) {
    return { ok: false, encrypted: false, persisted: false, error: error?.message || String(error) };
  }
}

function removeProfile(profileId) {
  if (!validProfileId(profileId)) return { ok: false, error: "INVALID_PROFILE_ID" };
  const raw = readRaw();
  delete raw.profiles[profileId];
  return { ok: maybeDeleteEmptyStore(raw) };
}

function listProfiles() {
  const raw = readRaw();
  return Object.entries(raw.profiles).map(([profileId, entry]) => ({
    profileId,
    hasToken: !!entry?.tokenCipher,
    hasPassword: !!entry?.passwordCipher,
    autoLogin: !!entry?.autoLogin,
    savedAt: entry?.savedAt,
  }));
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

  ipcMain.removeHandler("credentials:profile-load");
  ipcMain.handle("credentials:profile-load", (event, profileId) => {
    const reject = secure(event); if (reject) return reject;
    return loadProfile(profileId);
  });
  ipcMain.removeHandler("credentials:profile-save");
  ipcMain.handle("credentials:profile-save", (event, payload) => {
    const reject = secure(event); if (reject) return reject;
    if (!payload || typeof payload !== "object") return { ok: false, error: "INVALID_PAYLOAD" };
    for (const [key, limit] of [["profileId", 160], ["serverUrl", 2048], ["username", 256], ["token", 8192], ["password", 1024]]) {
      if (payload[key] !== undefined && (typeof payload[key] !== "string" || payload[key].length > limit)) return { ok: false, error: `INVALID_${key.toUpperCase()}` };
    }
    return saveProfile(payload);
  });
  ipcMain.removeHandler("credentials:profile-remove");
  ipcMain.handle("credentials:profile-remove", (event, profileId) => {
    const reject = secure(event); if (reject) return reject;
    return removeProfile(profileId);
  });
  ipcMain.removeHandler("credentials:profile-list");
  ipcMain.handle("credentials:profile-list", (event) => {
    const reject = secure(event); if (reject) return reject;
    return listProfiles();
  });
}

module.exports = {
  setCredentialsPath,
  registerCredentialsIpc,
  load,
  save,
  clear,
  loadProfile,
  saveProfile,
  removeProfile,
  listProfiles,
};
