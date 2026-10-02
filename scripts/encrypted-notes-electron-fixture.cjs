// Private acceptance window. Never boot the product backend or its user profile.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { attachEncryptedAutoLock } = require("../electron/encrypted-notes-auto-lock");
const directory = path.resolve(process.env.NOWEN_ENCRYPTED_TEST_PROFILE || "");
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("nowen-encrypted-electron-")) {
  console.error("An isolated temporary userData directory is required"); process.exit(1);
}
app.setPath("userData", directory);
app.setPath("sessionData", directory);
globalThis.encryptedFixtureRequests = [];
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1100, height: 800,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "../electron/preload.js"),
    },
  });
  attachEncryptedAutoLock(window);
  if (process.env.NOWEN_ENCRYPTED_FILE === "1") {
    // Restricted test transport: real preload + frontend bridge + session.fetch,
    // but never any product IPC handler, external server or real account.
    ipcMain.handle("client:http-json", async (event, payload) => {
      const target = new URL(payload.url);
      if (event.sender.id !== window.webContents.id || target.origin !== "http://127.0.0.1:5177" || !target.pathname.startsWith("/api/")) throw new Error("Invalid fixture request");
      globalThis.encryptedFixtureRequests.push(payload);
      const response = await window.webContents.session.fetch(target.href, {
        method: payload.method, headers: payload.headers,
        body: ["GET", "HEAD"].includes(payload.method) ? undefined : payload.body,
        redirect: "error",
      });
      return { ok: true, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: await response.text(), url: response.url };
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.NOWEN_ENCRYPTED_FILE === "1") window.loadFile(path.join(process.env.NOWEN_ENCRYPTED_RENDERER_ROOT, "benchmarks/encrypted-notes.html"));
  else window.loadURL("http://127.0.0.1:5176/benchmarks/encrypted-notes.html");
});
app.on("window-all-closed", () => app.quit());
