const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../settings');
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
