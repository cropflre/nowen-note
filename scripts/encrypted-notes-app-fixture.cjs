// Boot the unmodified product main process with a private profile and loopback API.
const { app, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const directory = path.resolve(process.env.NOWEN_ENCRYPTED_APP_PROFILE || "");
const full = process.env.NOWEN_ENCRYPTED_APP_MODE === "full";
const target = full ? null : new URL(process.env.NOWEN_ENCRYPTED_APP_SERVER || "");
const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("nowen-encrypted-app-")
  || (!full && (target.hostname !== "127.0.0.1" || target.protocol !== "http:"))) {
  throw new Error("An isolated profile and loopback backend are required");
}
app.setPath("userData", path.join(directory, "profile"));
app.setPath("sessionData", path.join(directory, "profile"));
fs.mkdirSync(path.join(directory, "profile", "nowen-data"), { recursive: true });
const settings = path.join(directory, "profile", "nowen-data", "settings.json");
if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ mode: full ? "full" : "lite", remoteUrl: target?.origin || "" }));
if (full) {
  process.env.DISABLE_MDNS = "1";
  process.env.BACKUP_AUTO_ENABLED = "false";
  process.env.CALENDAR_EXPORT_TIMER_DISABLED = "1";
  process.env.BACKUP_DIR = path.join(directory, "backups");
  process.env.NODE_OPTIONS = `--require=${JSON.stringify(path.join(app.isPackaged ? process.resourcesPath : __dirname, "encrypted-notes-backend-fixture.cjs"))}`;
  // Clipper registration is outside encryption acceptance and writes browser profiles.
  require(app.isPackaged ? path.join(resources, "clipper/clipper-host.js") : "../electron/clipper-host.js").ensureNativeHostRegistered = () => ({ installed: [], failed: [], registry: { registered: [], failed: [] } });
}
globalThis.encryptedAppRequests = [];
globalThis.encryptedAppHeaders = [];
globalThis.encryptedAppScan = (markers) => {
  const db = require(path.join(resources, "backend/node_modules/better-sqlite3"))(full ? path.join(directory, "profile/nowen-data/nowen-note.db") : path.join(directory, "backend/test.db"), { readonly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .filter(({ name }) => !name.startsWith("sqlite_"))
      .filter(({ name }) => {
        const rows = JSON.stringify(db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all());
        return markers.some((marker) => rows.includes(marker));
      }).map(({ name }) => name);
  } finally { db.close(); }
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["http://127.0.0.1/*"] }, (details, callback) => {
    globalThis.encryptedAppHeaders.push({ url: details.url, headers: details.requestHeaders });
    callback({ requestHeaders: details.requestHeaders });
  });
  // Observe production session.fetch, without replacing its IPC handler or auth.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    globalThis.encryptedAppRequests.push({ url: details.url, method: details.method,
      body: (details.uploadData || []).map((entry) => entry.bytes?.toString("utf8") || "").join("") });
    const url = new URL(details.url);
    const runtimeFile = path.join(directory, "profile/nowen-data/clipper-runtime.json");
    const allowedOrigin = full
      ? (fs.existsSync(runtimeFile) ? `http://127.0.0.1:${JSON.parse(fs.readFileSync(runtimeFile, "utf8")).port}` : "")
      : target.origin;
    callback({ cancel: url.origin !== allowedOrigin });
  });
});
require("../electron/main-bootstrap.js");
