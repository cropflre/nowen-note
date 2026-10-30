const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const os = require("node:os");
const profile = path.resolve(process.env.TASK_COMPOSER_ELECTRON_PROFILE || "");
if (path.dirname(path.dirname(profile)) !== path.resolve(os.tmpdir()) || !path.basename(path.dirname(profile)).startsWith("nowen-task-composer-browser-")) throw new Error("An isolated Electron profile is required");
app.setPath("userData", profile);
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.loadURL(process.env.TASK_COMPOSER_ELECTRON_URL);
});
app.on("window-all-closed", () => app.quit());
