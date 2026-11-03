// Acceptance entry only: isolate paths/listeners, then boot the production app.
const { app, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const directory = path.resolve(process.env.NOWEN_NAS_OFFLINE_PROFILE || '');
const server = new URL(process.env.NOWEN_NAS_OFFLINE_SERVER || '');
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('nowen-nas-offline-')
  || server.hostname !== '127.0.0.1' || server.protocol !== 'http:') throw new Error('An isolated profile and loopback NAS are required');
const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
app.setPath('userData', path.join(directory, 'desktop'));
app.setPath('sessionData', path.join(directory, 'desktop'));
const data = path.join(directory, 'desktop/nowen-data');
fs.mkdirSync(data, { recursive: true });
const settings = path.join(data, 'settings.json');
if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ mode: 'lite', remoteUrl: server.origin }));
process.env.DISABLE_MDNS = '1';
process.env.BACKUP_AUTO_ENABLED = 'false';
process.env.CALENDAR_EXPORT_TIMER_DISABLED = '1';
process.env.BACKUP_DIR = path.join(directory, 'desktop-backups');
process.env.NODE_OPTIONS = `--require=${JSON.stringify(path.join(app.isPackaged ? resources : __dirname, 'nas-offline-backend-fixture.cjs'))}`;
require(app.isPackaged ? path.join(resources, 'nas-offline-backend-fixture.cjs') : './nas-offline-backend-fixture.cjs');
const discovery = require('../electron/discovery.js');
discovery.registerDiscoveryIpc = () => {
  for (const name of ['start','stop','list']) {
    ipcMain.removeHandler(`discovery:${name}`);
    ipcMain.handle(`discovery:${name}`, () => name === 'list' ? [] : {ok:true,available:false});
  }
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{
    callback({cancel:!['127.0.0.1','localhost','[::1]'].includes(new URL(details.url).hostname)});
  });
});
// Native browser-host registration would change the user's browser profiles.
require(app.isPackaged ? path.join(resources, 'clipper/clipper-host.js') : '../electron/clipper-host.js').ensureNativeHostRegistered = () => ({ installed: [], failed: [], registry: { registered: [], failed: [] } });
require('../electron/main-bootstrap.js');
