// electron/credentials.js
//
// 桌面端"记住密码 / 自动登录"凭据持久化。
//
// 存储位置：{userData}/nowen-data/credentials.json
// 敏感字段用 Electron safeStorage 加密后写入（base64）：
//   - Windows: DPAPI（绑当前用户）
//   - macOS:   Keychain
//   - Linux:   libsecret / kwallet（若可用），否则降级为 plaintext（由
//              safeStorage.isEncryptionAvailable() 指示）
//
// 文件结构（示例）：
// {
//   "encrypted": true,
//   "remember": {
//     "serverUrl": "http://192.168.1.10:3000",
//     "username": "alice",
//     "passwordCipher": "<base64 safeStorage 密文>"
//   },
//   "autoLogin": true,
//   "savedAt": 1720000000000
// }
//
// 设计：
//   - 读失败永远不抛，返回 null；写失败仅 console.warn，不崩溃；
//   - 切换服务器 / 主动退出登录 → 调用 clear()；
//   - safeStorage 不可用时仍可保存"用户名 + serverUrl"（便于预填），
//     但 passwordCipher 留空，前端逻辑会自动降级为"只预填，不自动提交"。
//
// 与 QuickLogin（生物识别）独立：这套面向 PC + 仅密码复用，不弹生物识别。

const { app, ipcMain, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

let credentialsFile = null;

function setCredentialsPath(userDataPath) {
  credentialsFile = path.join(userDataPath, "credentials.json");
}

function getFile() {
  if (!credentialsFile) {
    throw new Error("credentials.js: setCredentialsPath() must be called first");
  }
  return credentialsFile;
}

function encAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 读取并反序列化 —— 失败一律返回空对象 */
function readRaw() {
  try {
    const file = getFile();
    if (!fs.existsSync(file)) return {};
    const txt = fs.readFileSync(file, "utf8");
    return JSON.parse(txt) || {};
  } catch (e) {
    console.warn("[credentials] read failed:", e?.message || e);
    return {};
  }
}

function writeRaw(obj) {
  const file = getFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.warn("[credentials] write failed:", e?.message || e);
    return false;
  }
}

/**
 * 加载当前保存的凭据。
 * 解密失败（例如跨用户拷贝、DPAPI 密钥变化）时会自动清空并返回 null。
 *
 * @returns {{
 *   serverUrl: string,
 *   username: string,
 *   password: string,
 *   autoLogin: boolean,
 *   hasPassword: boolean,
 * } | null}
 */
function load() {
  const raw = readRaw();
  const rem = raw && raw.remember;
  if (!rem || typeof rem !== "object") return null;
  const out = {
    serverUrl: typeof rem.serverUrl === "string" ? rem.serverUrl : "",
    username: typeof rem.username === "string" ? rem.username : "",
    password: "",
    autoLogin: !!raw.autoLogin,
    hasPassword: false,
  };
  if (rem.passwordCipher && encAvailable()) {
    try {
      const buf = Buffer.from(rem.passwordCipher, "base64");
      const plain = safeStorage.decryptString(buf);
      if (typeof plain === "string" && plain.length > 0) {
        out.password = plain;
        out.hasPassword = true;
      }
    } catch (e) {
      console.warn("[credentials] decrypt failed, clearing:", e?.message || e);
      // 解密失败 → 凭据已失效，直接清空，避免下次又踩坑
      clear();
      return null;
    }
  }
  if (!out.username && !out.serverUrl) return null;
  return out;
}

/**
 * 保存凭据。
 *
 * 语义：
 *   - remember=false → 视同"不记住"，等同 clear()
 *   - remember=true + password 非空 → 加密存密码
 *   - remember=true + password 空 → 仅保存 username+serverUrl（用于下次预填）
 *
 * @param {{
 *   remember: boolean,
 *   autoLogin?: boolean,
 *   serverUrl?: string,
 *   username?: string,
 *   password?: string,
 * }} payload
 * @returns {{ ok: boolean, encrypted: boolean, error?: string }}
 */
function save(payload) {
  try {
    if (!payload || typeof payload !== "object") {
      return { ok: false, encrypted: false, error: "invalid payload" };
    }
    if (!payload.remember) {
      clear();
      return { ok: true, encrypted: false };
    }
    const remember = {
      serverUrl: typeof payload.serverUrl === "string" ? payload.serverUrl : "",
      username: typeof payload.username === "string" ? payload.username : "",
    };
    const canEnc = encAvailable();
    if (typeof payload.password === "string" && payload.password.length > 0) {
      if (canEnc) {
        try {
          const cipher = safeStorage.encryptString(payload.password);
          remember.passwordCipher = cipher.toString("base64");
        } catch (e) {
          console.warn("[credentials] encrypt failed:", e?.message || e);
          // 继续保存用户名，但不保存密码
        }
      } else {
        // 明确拒绝落盘明文密码，避免后续被误用作"自动登录"
        console.warn(
          "[credentials] safeStorage not available on this platform, password NOT persisted"
        );
      }
    }
    const full = {
      encrypted: canEnc,
      remember,
      autoLogin: !!payload.autoLogin,
      savedAt: Date.now(),
    };
    const ok = writeRaw(full);
    return { ok, encrypted: canEnc };
  } catch (e) {
    return { ok: false, encrypted: false, error: e?.message || String(e) };
  }
}

function clear() {
  try {
    const file = getFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    console.warn("[credentials] clear failed:", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 注册 IPC，供 renderer 通过 preload 调用 */
function registerCredentialsIpc() {
  // SEC-ELECTRON-01-B: 高权限 IPC 来源校验
  const { assertMainWindowSender } = require("./security");

  // SEC-ELECTRON-01-C: credentials:load 默认不返回密码
  ipcMain.removeHandler("credentials:load");
  ipcMain.handle("credentials:load", (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    const data = load();
    if (!data) return null;
    const summary = {
      serverUrl: data.serverUrl,
      username: data.username,
      hasPassword: data.hasPassword,
      autoLogin: data.autoLogin,
    };
    if (data.autoLogin && data.hasPassword) {
      summary.password = data.password;
    }
    return summary;
  });

  // SEC-ELECTRON-01-C: credentials:save 参数 schema 校验
  ipcMain.removeHandler("credentials:save");
  ipcMain.handle("credentials:save", (event, payload) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }
    if (payload.serverUrl !== undefined && typeof payload.serverUrl !== "string") {
      return { ok: false, error: "INVALID_SERVER_URL" };
    }
    if (payload.username !== undefined && typeof payload.username !== "string") {
      return { ok: false, error: "INVALID_USERNAME" };
    }
    if (payload.password !== undefined && typeof payload.password !== "string") {
      return { ok: false, error: "INVALID_PASSWORD" };
    }
    if (payload.remember !== undefined && typeof payload.remember !== "boolean") {
      return { ok: false, error: "INVALID_REMEMBER" };
    }
    if (payload.serverUrl && payload.serverUrl.length > 2048) {
      return { ok: false, error: "SERVER_URL_TOO_LONG" };
    }
    if (payload.username && payload.username.length > 256) {
      return { ok: false, error: "USERNAME_TOO_LONG" };
    }
    if (payload.password && payload.password.length > 1024) {
      return { ok: false, error: "PASSWORD_TOO_LONG" };
    }
    return save(payload);
  });

  ipcMain.removeHandler("credentials:clear");
  ipcMain.handle("credentials:clear", (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    return clear();
  });

  ipcMain.removeHandler("credentials:is-encryption-available");
  ipcMain.handle("credentials:is-encryption-available", (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    return encAvailable();
  });
}

module.exports = {
  setCredentialsPath,
  registerCredentialsIpc,
  load,
  save,
  clear,
};
