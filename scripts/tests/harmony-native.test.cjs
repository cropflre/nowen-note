const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const ts = require('../../frontend/node_modules/typescript');

const root = path.resolve(__dirname, '../..');
const bridgeRoot = path.join(root, 'nowen-harmony/entry/src/main/ets/bridge');
function loadAdapter(file, dependencies, extra = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(bridgeRoot, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, ...extra, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected adapter dependency ${name}`);
    return dependencies[name];
  } });
  return exports;
}

function relationalStore(directory) {
  return {
    SecurityLevel: { S1: 1 },
    async getRdbStore(_context, options) {
      const db = new DatabaseSync(path.join(directory, options.name));
      return {
        async executeSql(sql, values = []) { db.prepare(sql).run(...values); },
        async execute(sql, values = []) {
          const result = db.prepare(sql).run(...values);
          return /^\s*(INSERT|REPLACE)\b/i.test(sql)
            ? (result.changes ? Number(result.lastInsertRowid) : -1) : Number(result.changes);
        },
        async querySql(sql, values = []) {
          const prepared = db.prepare(sql);
          const rows = prepared.all(...values);
          const columns = prepared.columns().map(column => column.name);
          let index = -1;
          return {
            columnNames: columns,
            goToNextRow() { return ++index < rows.length; },
            goToFirstRow() { index = 0; return rows.length > 0; },
            isColumnNull(column) { return rows[index][columns[column]] === null; },
            getValue(column) { return rows[index][columns[column]]; },
            getLong(column) { return Number(rows[index][columns[column]]); },
            close() {},
          };
        },
        beginTransaction() { db.exec('BEGIN IMMEDIATE'); },
        commit() { db.exec('COMMIT'); },
        rollBack() { db.exec('ROLLBACK'); },
        async close() { db.close(); },
      };
    },
  };
}

test('Harmony SQLite preserves business rows and Outbox across reopen and rolls back both on failure', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-harmony-sqlite-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { HarmonyDatabase } = loadAdapter('NativeDatabase.ets', {
    '@kit.ArkData': { relationalStore: relationalStore(directory) },
  });
  const first = 'nowen_local_0123456789abcdef';
  const second = 'nowen_local_abcdef0123456789';
  let adapter = new HarmonyDatabase({});
  const call = (method, database, extra = {}) => adapter.call(method, { database, ...extra });
  await call('createConnection', first); await call('open', first);
  for (const sql of ['CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT NOT NULL)',
    'CREATE TABLE outbox(id TEXT PRIMARY KEY, noteId TEXT NOT NULL REFERENCES notes(id), payload TEXT NOT NULL)',
    'PRAGMA foreign_keys=ON']) await call('execute', first, { statements: sql });
  await call('execute', first, { statements: 'BEGIN IMMEDIATE' });
  await call('run', first, { statement: 'INSERT INTO notes VALUES(?,?)', values: ['n1', '离线正文'] });
  const receipt = await call('run', first, { statement: 'INSERT INTO outbox VALUES(?,?,?)', values: ['m1', 'n1', 'pending'] });
  assert.equal(receipt.changes.changes, 1);
  assert.equal((await call('run', first, { statement: 'INSERT OR IGNORE INTO notes VALUES(?,?)', values: ['n1', 'ignored'] })).changes.changes, 0);
  await call('execute', first, { statements: 'COMMIT' });
  await call('closeConnection', first);
  adapter = new HarmonyDatabase({});
  await call('createConnection', first); await call('open', first);
  assert.equal((await call('query', first, { statement: 'SELECT body FROM notes' })).values[0].body, '离线正文');
  await call('execute', first, { statements: 'BEGIN IMMEDIATE' });
  await call('run', first, { statement: 'UPDATE notes SET body=?', values: ['未完成事务'] });
  await assert.rejects(call('run', first, { statement: 'INSERT INTO outbox VALUES(?,?,?)', values: ['m1', 'n1', 'duplicate'] }));
  await call('execute', first, { statements: 'ROLLBACK' });
  assert.equal((await call('query', first, { statement: 'SELECT body FROM notes' })).values[0].body, '离线正文');
  assert.equal((await call('query', first, { statement: 'SELECT payload FROM outbox' })).values[0].payload, 'pending');
  await call('createConnection', second); await call('open', second);
  assert.equal((await call('query', second, { statement: "SELECT count(*) AS count FROM sqlite_master WHERE name='notes'" })).values[0].count, 0);
  await assert.rejects(call('createConnection', '../foreign-account'));
  assert.equal((await call('checkConnectionsConsistency', '', { dbNames: [first, second] })).result, true);
  await call('execute', first, { statements: 'BEGIN IMMEDIATE' });
  await call('run', first, { statement: 'UPDATE notes SET body=?', values: ['abandoned transaction'] });
  assert.equal((await call('checkConnectionsConsistency', '', { dbNames: [second] })).result, false);
  await call('createConnection', first); await call('open', first);
  assert.equal((await call('query', first, { statement: 'SELECT body FROM notes' })).values[0].body, '离线正文');
  await call('closeConnection', first); await call('closeConnection', second);
});

test('Harmony bridge isolates callbacks, forwards shared back events, and exposes only the bundled origin', async () => {
  const requests = [];
  const makeWindow = origin => {
    const window = { location: { origin }, addEventListener() {}, NowenNative: { postMessage: raw => requests.push(JSON.parse(raw)) } };
    window.top = window;
    return window;
  };
  const window = makeWindow('https://localhost');
  const source = fs.readFileSync(path.join(root, 'nowen-harmony/runtime/harmony-runtime.js'), 'utf8');
  const context = { window, document: { addEventListener() {} }, history: { length: 1 }, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  assert.equal(window.Capacitor.getPlatform(), 'harmony');
  const one = window.__harmonyBridge__.request('CapacitorSQLite', 'query', {});
  const two = window.__harmonyBridge__.request('Filesystem', 'stat', {});
  window.__harmonyBridge__.resolve(requests[1].id, { size: 42 });
  window.__harmonyBridge__.resolve(requests[0].id, null, { message: 'Disk full', code: 'IO_ERROR' });
  assert.equal((await two).size, 42);
  await assert.rejects(one, error => error.code === 'IO_ERROR');
  let backs = 0;
  const listener = window.Capacitor.nativeCallback('App', 'addListener', { eventName: 'backButton' }, () => backs++);
  await window.__harmonyBridge__.back();
  assert.equal(backs, 1);
  await window.Capacitor.nativePromise('App', 'removeListener', { callbackId: listener });
  window.__harmonyBridge__.emit('App', 'backButton', {});
  assert.equal(backs, 1);
  const foreign = makeWindow('https://untrusted.example');
  vm.runInNewContext(source, { ...context, window: foreign });
  assert.equal(foreign.Capacitor, undefined);
});

test('Harmony native filesystem rejects traversal and foreign sandbox paths', () => {
  const { HarmonyFiles } = loadAdapter('NativeFiles.ets', {
    '@kit.CoreFileKit': { fileIo: {} },
    '@kit.ArkTS': { util: { Base64Helper: class {} } },
  });
  const files = new HarmonyFiles({ filesDir: '/app/files', cacheDir: '/app/cache' });
  assert.equal(files.path('attachments/account/id'), '/app/files/attachments/account/id');
  assert.equal(files.path('temp', 'CACHE'), '/app/cache/temp');
  assert.throws(() => files.path('secret', 'EXTERNAL'));
  for (const value of ['../secret', 'a/../../secret', '/other-app/files/secret', 'a\\..\\secret', 'x\0y']) {
    assert.throws(() => files.path(value));
  }
});

test('Harmony attachment chunks preserve bytes and signal EOF without encoding an empty native buffer', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-harmony-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { HarmonyFiles } = loadAdapter('NativeFiles.ets', {
    '@kit.CoreFileKit': { fileIo: {
      OpenMode: { READ_ONLY: 0 },
      openSync: file => ({ fd: fs.openSync(file, 'r') }),
      closeSync: file => fs.closeSync(file.fd),
      statSync: fs.statSync, accessSync: fs.existsSync,
      renameSync: fs.renameSync,
      readSync: (fd, data, options) => fs.readSync(fd, new Uint8Array(data), 0, options.length, options.offset),
    } },
    '@kit.ArkTS': { util: { Base64Helper: class {
      encodeToStringSync(bytes) {
        assert.ok(bytes.length, 'Native Base64 does not accept an empty buffer');
        return Buffer.from(bytes).toString('base64');
      }
    } } },
  });
  const files = new HarmonyFiles({ filesDir: directory });
  const bytes = Buffer.from(Array.from({ length: 500000 }, (_, i) => i % 251));
  fs.writeFileSync(path.join(directory, 'attachment'), bytes);
  const chunks = [];
  let offset = 0;
  while (true) {
    const chunk = await files.call('readChunk', { path: 'attachment', offset, chunkSize: 196608 });
    if (!chunk.data) { assert.equal(chunk.bytes, 0); break; }
    chunks.push(Buffer.from(chunk.data, 'base64')); offset += chunk.bytes;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await files.call('rename', { from: 'attachment', to: 'renamed', directory: 'DATA' });
  assert.deepEqual(fs.readFileSync(path.join(directory, 'renamed')), bytes);
  for (const method of ['readChunk', 'readdir', 'stat']) {
    await assert.rejects(files.call(method, { path: 'missing' }), /OS-PLUG-FILE-0008/);
  }
});

test('Harmony HTTP retains empty success and non-JSON error responses without replaying writes', async () => {
  let response = { responseCode: 204, result: new ArrayBuffer(0), header: {} };
  let requests = 0;
  let destroyed = 0;
  const { NativeHost } = loadAdapter('NativeHost.ets', {
    '@kit.ArkUI': { window: {} },
    '@kit.NetworkKit': { http: { HttpDataType: { ARRAY_BUFFER: 1 }, createHttp: () => ({
      async request() { requests++; return response; }, destroy() { destroyed++; },
    }) } },
    '@kit.ArkTS': { util: { TextDecoder: { create: () => ({ decodeToString: bytes => new TextDecoder().decode(bytes) }) } } },
    '@kit.AssetStoreKit': { asset: {} },
    './NativeDatabase': { HarmonyDatabase: class {} },
    './NativeFiles': { HarmonyFiles: class {} },
    '../services/NetworkMonitor': { getNetworkType: () => 'wifi' },
  });
  const host = new NativeHost({}, {});
  const empty = await host.fetch({ url: 'https://example.test/api/note', method: 'DELETE', responseType: 'json' });
  assert.equal(empty.status, 204); assert.equal(empty.data, null);
  response = { responseCode: 502, result: new TextEncoder().encode('<html>Gateway error</html>').buffer, header: {} };
  const failure = await host.fetch({ url: 'https://example.test/api/note', method: 'POST', responseType: 'json' });
  assert.equal(failure.status, 502); assert.equal(failure.data, '<html>Gateway error</html>');
  assert.equal(requests, 2); assert.equal(destroyed, 2);
});
