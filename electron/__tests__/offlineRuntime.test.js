const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const settings = require('../settings');
const { requestLocalAccountBootstrap } = require('../localAccountBootstrap');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');

function migrationHandler(context) {
  const start = source.indexOf('  ipcMain.handle("sync:start-lite-migration",');
  const end = source.indexOf('\n  });',start);
  assert.ok(start>=0 && end>start);
  context.ipcMain={handle:(_name,handler)=>{context.migrate=handler;}};
  vm.createContext(context);vm.runInContext(source.slice(start,end+6),context);
  return context.migrate;
}

test('DCC-006: remote full-build download reports local auth failure and resumes after confirmed recovery', async () => {
  const calls = [];
  const context = {
    backendPort: 1234, localAuthCache: null, localAuthBootstrapError: null,
    localAuthBootstrapSucceeded: false, currentMode: 'lite', currentRuntime: 'remote', console,
    assertMainWindowSender: () => null, isLiteOnlyBuild: () => false,
    ensureLocalAccount: async () => { context.localAuthBootstrapError = 'LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN'; return null; },
    getLocalAccountSecret: () => 'secret',
    provisionLocalAdminAccount: async () => { calls.push('reset'); return {token:'local-token'}; },
    readSettings: () => ({}), writeSettings: (patch) => patch,
    fetch: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer local-token');
      assert.equal(JSON.parse(options.body).token, 'remote-token');
      return {ok:true,json:async()=>({stage:'complete',remoteUrl:'https://nas.test',profileId:'profile'})};
    },
  };
  const migrate = migrationHandler(context);
  const first = await migrate({}, {serverUrl:'https://nas.test',token:'remote-token'});
  assert.equal(first.error, 'LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN');
  assert.deepEqual(calls, []);
  const start = source.indexOf('async function resetLocalAccountAuth()');
  const end = source.indexOf('\n}\n', start);
  vm.runInContext(source.slice(start,end+2), context);
  assert.equal((await context.resetLocalAccountAuth()).ok, true);
  assert.equal((await migrate({}, {serverUrl:'https://nas.test',token:'remote-token'})).ok, true);
  assert.equal(context.currentRuntime, 'local');
  context.isLiteOnlyBuild = () => true;
  assert.equal((await context.resetLocalAccountAuth()).ok, false);
  assert.deepEqual(calls, ['reset']);
});

test('local account recovery requires a trusted sender and explicit native confirmation', async () => {
  let resets = 0, prompts = 0;
  const context = {
    assertMainWindowSender: () => null,
    BrowserWindow: {getFocusedWindow: () => null}, mainWindow: null,
    getUserDataPath: () => 'local-data',
    dialog: {showMessageBox: async () => { prompts++; return {response:0}; }},
    resetLocalAccountAuth: async () => { resets++; return {ok:true}; },
    ipcMain: {handle: (_name,handler) => { context.recover = handler; }},
  };
  vm.createContext(context);
  const start = source.indexOf('  ipcMain.handle("desktop:reset-local-auth",');
  const end = source.indexOf('\n  });', start);
  vm.runInContext(source.slice(start,end+6), context);
  assert.equal((await context.recover({})).cancelled, true);
  assert.equal(resets, 0);
  context.dialog.showMessageBox = async () => { prompts++; return {response:1}; };
  assert.equal((await context.recover({})).ok, true);
  context.assertMainWindowSender = () => ({ok:false,error:'forbidden'});
  assert.equal((await context.recover({})).error, 'forbidden');
  assert.equal(prompts, 2);
  assert.equal(resets, 1);
});

test('DCC-006: a refused NAS switch cannot persist an old complete profile as the new source', async () => {
  for (const [status,remoteUrl] of [[500,'https://nas-a.test'],[200,'https://nas-a.test'],[500,'https://nas-b.test']]) {
    const saved={liteMigrationStatus:'complete',remoteUrl:'https://nas-a.test',activeSyncProfileId:'profile-a'};
    const context={backendPort:1234,localAuthCache:{token:'local'},currentRuntime:'local',console,
      assertMainWindowSender:()=>null,isLiteOnlyBuild:()=>false,
      readSettings:()=>({...saved}),writeSettings:(patch)=>Object.assign(saved,patch),
      fetch:async()=>({ok:status===200,status,json:async()=>({stage:'complete',remoteUrl,profileId:'profile-a',error:'source refused'})})};
    const result=await migrationHandler(context)({}, {serverUrl:'https://nas-b.test',token:'remote-b'});
    assert.equal(result.ok,false);
    assert.equal(saved.remoteUrl,'https://nas-a.test');
    assert.equal(saved.liteMigrationStatus,'complete');
    assert.equal(saved.activeSyncProfileId,'profile-a');
  }
});

test('DCC-009: verified automatic download activates the matching local profile immediately', async () => {
  const saved={liteMigrationStatus:'running',remoteUrl:'https://nas.test'};
  const context={backendPort:1234,localAuthCache:{token:'local'},currentRuntime:'remote',console,
    assertMainWindowSender:()=>null,isLiteOnlyBuild:()=>false,
    readSettings:()=>({...saved}),writeSettings:(patch)=>Object.assign(saved,patch),
    fetch:async()=>({ok:true,status:200,json:async()=>({stage:'complete',remoteUrl:'https://nas.test',profileId:'profile'})})};
  const result=await migrationHandler(context)({}, {serverUrl:'https://nas.test/',token:'remote'});
  assert.equal(result.ok,true);assert.equal(saved.remoteUrl,'https://nas.test');
  assert.equal(saved.liteMigrationStatus,'complete');assert.equal(saved.activeSyncProfileId,'profile');
  assert.equal(context.currentRuntime,'local');
});

test('DCC-009: a completed remote migration reopens the local runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-offline-runtime-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mode: 'lite', remoteUrl: 'https://nas.test', runtime: 'remote' }));
    settings.setSettingsPath(dir);
    settings.writeSettings({ liteMigrationStatus: 'complete' });
    settings.setSettingsPath(dir);
    assert.equal(settings.readSettings().runtime, 'local');
    const switched = settings.writeSettings({ mode: 'lite', remoteUrl: 'https://another-nas.test' });
    assert.equal(switched.runtime, 'remote', 'a new source cannot inherit the old migration');
    assert.equal(switched.liteMigrationStatus, 'none');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DCC-009: migrated desktop starts locally without contacting the NAS', async () => {
  const start = source.indexOf('async function initializeDesktopDataRuntime()');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, 'startup has a testable runtime initialization');
  const calls = [];
  const context = {
    currentMode: 'lite', currentRuntime: 'local', currentRemoteUrl: 'https://nas.test', localAuthCache: null, backendPort: 0,
    startBackend: async () => { calls.push('backend'); },
    ensureLocalAccount: async () => { calls.push('local-auth'); return { token: 'local-token' }; },
    waitForRemoteReady: async () => { throw new Error('NAS unavailable'); },
    getDevelopmentBackendUrl: () => '', console,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end + 2), context);
  await context.initializeDesktopDataRuntime();
  assert.deepEqual(calls, ['backend', 'local-auth']);
  assert.equal(context.localAuthCache.token, 'local-token');
});

test('DCC-008: startup recovers a committed local migration after a settings write failure', async () => {
  const start = source.indexOf('async function recoverCompletedLocalMigration()');
  const end = source.indexOf('\n}\n', start);
  let saved;
  const context = {
    isLiteOnlyBuild: () => false, readSettings: () => ({liteMigrationStatus:'running'}),
    backendPort: 1234, localAuthCache: null, currentRemoteUrl:'https://nas.test', currentRuntime:'remote',
    ensureLocalAccount: async () => ({token:'local'}),
    fetch: async (url) => {
      assert.ok(url.startsWith('http://127.0.0.1:1234/'));
      return {ok:true,json:async()=>({stage:'complete',remoteUrl:'https://nas.test',profileId:'p'})};
    },
    writeSettings: (patch) => { saved = patch; }, console,
  };
  vm.createContext(context); vm.runInContext(source.slice(start,end+2),context);
  await context.recoverCompletedLocalMigration();
  assert.equal(context.currentRuntime,'local');
  assert.equal(saved.activeSyncProfileId,'p');
  context.currentRuntime='remote';
  context.currentRemoteUrl='https://another-nas.test'; saved=null;
  await context.recoverCompletedLocalMigration();
  assert.equal(context.currentRuntime,'remote'); assert.equal(saved,null);
});

// Runs the real startBackend(), ensureLocalAccount() and download handler together. Only the process, the health
// probe and the local HTTP call are replaced, so the state a failed start leaves behind is the real one.
function backendHarness(dir, health) {
  const children = [];
  const context = {
    backendPort: 0, backendProcess: null, clipperHost: null, localAuthCache: null,
    localAuthBootstrapError: null, localAuthBootstrapSucceeded: false, localAccountCreationAllowed: false,
    reachable: false, process: { env: {}, resourcesPath: dir }, __dirname: dir,
    console: { log() {}, warn() {}, error() {} }, app: { isPackaged: false }, fs, path, requestLocalAccountBootstrap,
    require: () => ({ setRuntimeDir() {}, publishRuntime() {} }),
    getFreePort: async () => 4321, getBackendEntry: () => path.join(dir, 'backend-entry.js'), getUserDataPath: () => dir,
    findNodeExecutable: () => ({ cmd: 'node', useElectron: false }), getLocalAccountSecret: () => 'secret-secret-secret',
    ensureJwtSecret: () => 'jwt', getFrontendDist: () => '', registerClipperNativeHost: () => {},
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 100 + children.length, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
      });
      children.push(child);
      return child;
    },
    waitForBackendReady: async () => health(children[children.length - 1], children.length, context),
    localApiRequest: async () => {
      if (!context.reachable) throw new Error('connect ECONNREFUSED 127.0.0.1:4321');
      return { status: 200, data: { token: 'local-token', user: { role: 'admin' } } };
    },
    isLiteOnlyBuild: () => false, assertMainWindowSender: () => null, readSettings: () => ({}), writeSettings: (patch) => patch,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ stage: 'complete', remoteUrl: 'https://nas.test', profileId: 'profile' }) }),
  };
  const migrate = migrationHandler(context);
  const begin = source.indexOf('// ---------- 启动后端 ----------');
  const end = source.indexOf('/**\n * 注册 Clipper Native Messaging 宿主。');
  const ensure = source.indexOf('async function ensureLocalAccount()');
  assert.ok(begin >= 0 && end > begin && ensure >= 0, 'backend start and local account bootstrap are testable');
  vm.runInContext(source.slice(begin, end) + source.slice(ensure, source.indexOf('\n}\n', ensure) + 2), context);
  return { context, children, download: () => migrate({}, { serverUrl: 'https://nas.test', token: 'remote-token' }) };
}

test('DCC-006: a backend that died while starting is started again and every attempt reports the real failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-backend-restart-'));
  try {
    fs.writeFileSync(path.join(dir, 'backend-entry.js'), '');
    const { children, download } = backendHarness(dir, (child, attempt, ctx) => {
      if (attempt >= 3) { ctx.reachable = true; return Promise.resolve(); }
      child.exitCode = 1; child.emit('exit', 1, null);
      return new Promise(() => {});
    });
    const first = await download();
    assert.equal(first.ok, false);
    assert.match(first.error, /^backend-start-failed: 后端进程已退出/);
    // The download gate retries on its own. A retry must start the backend again and show why it failed,
    // not skip the start and report a connection error that hides the cause.
    const second = await download();
    assert.match(second.error, /^backend-start-failed: 后端进程已退出/);
    assert.equal((await download()).ok, true);
    assert.equal(children.length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DCC-006: a backend that is still starting is waited for, never started twice on the same database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-backend-slow-'));
  try {
    fs.writeFileSync(path.join(dir, 'backend-entry.js'), '');
    const { context, children, download } = backendHarness(dir, async () => { throw new Error('后端启动超时（30000ms）'); });
    assert.match((await download()).error, /^backend-start-failed/);
    context.reachable = true; // the process outlived the 30s probe and finished starting
    assert.equal((await download()).ok, true);
    assert.equal(children.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DCC-006: a backend that stops before it is ready fails the attempt at once instead of waiting out the probe', async () => {
  const stops = [
    ['exits', (child) => { child.exitCode = 1; child.emit('exit', 1, null); },
      /^backend-start-failed: 后端进程已退出（code=1 signal=）/],
    ['cannot be spawned', (child) => {
      child.pid = undefined; child.exitCode = -2;
      child.emit('error', new Error('spawn node ENOENT'));
    }, /^backend-start-failed: 后端进程未能启动；子进程启动错误：spawn node ENOENT/],
  ];
  for (const [name, stop, expected] of stops) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-backend-stops-'));
    try {
      fs.writeFileSync(path.join(dir, 'backend-entry.js'), '');
      // The 30s health probe never answers; only the process stopping can end the attempt.
      const { children, download } = backendHarness(dir, (child) => { setImmediate(() => stop(child)); return new Promise(() => {}); });
      const attempt = () => Promise.race([download(), new Promise((resolve) => setTimeout(() => resolve({ error: 'still waiting for the probe' }), 2000).unref())]);
      assert.match((await attempt()).error, expected, `a backend that ${name}`);
      assert.match((await attempt()).error, expected, `a backend that ${name}, again`);
      assert.equal(children.length, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('DCC-006: a missing backend entry is reported on every attempt instead of a connection error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-backend-missing-'));
  try {
    const { children, download } = backendHarness(dir, async () => {});
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.match((await download()).error, /^backend-start-failed: 后端入口文件不存在/);
    }
    assert.equal(children.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
