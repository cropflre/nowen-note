const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../settings');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

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
