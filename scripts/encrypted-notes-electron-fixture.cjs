// Private acceptance window. Never boot the product backend or its user profile.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { attachEncryptedAutoLock } = require("../electron/encrypted-notes-auto-lock");
const directory = path.resolve(process.env.NOWEN_ENCRYPTED_TEST_PROFILE || "");
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("nowen-encrypted-electron-")) {
  console.error("An isolated temporary userData directory is required"); process.exit(1);
}
app.setPath("userData", directory);
app.setPath("sessionData", directory);
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
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.loadURL("http://127.0.0.1:5176/benchmarks/encrypted-notes.html");
});
app.on("window-all-closed", () => app.quit());
