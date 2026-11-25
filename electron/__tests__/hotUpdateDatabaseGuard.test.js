// DCC-013 桌面端：数据库比代码新时（多半是热更新包升级过数据库后又被退回），
// 主进程必须识别出来并只给安全出口，不启动后端、不打开主界面、不写库。
// 与 offlineRuntime.test.js 一样，截取 main.js 里的真实代码放进 vm 运行。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
const quiet = { log() {}, error() {}, warn() {} };

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `main.js 里找不到 ${startMarker}`);
  return source.slice(start, end);
}

/** 运行 launchBackend 里「读 stderr」和「就绪前退出」这两段，返回就绪前退出时的 Promise。 */
function watchBackend() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  const timers = [];
  const context = { backendProcess: child, console: quiet, setTimeout: (callback) => timers.push(callback), clearTimeout: () => undefined, Number };
  vm.createContext(context);
  const stderrHandler = between('  let databaseUpgrade = null;', '  backendProcess.on("exit"');
  const exitWatcher = between('  const child = backendProcess;', '  try {\n    await Promise.race([waitForBackendReady');
  const stopped = vm.runInContext(`(() => {\n${stderrHandler}\n${exitWatcher}\nreturn stoppedBeforeReady;\n})()`, context);
  stopped.catch(() => undefined);
  return { child, stopped, timers };
}

const NEWER = '[migrations] 数据库版本 99999 高于当前程序支持的 147。\n请升级服务端程序，保留原数据目录，禁止旧程序继续写入新版数据库。\n';

test('DCC-013: a backend that refuses a newer database is recognised even though it exits with code 1', async () => {
  const { child, stopped } = watchBackend();
  child.stderr.write(`DatabaseUpgradeRequiredError: ${NEWER}`);
  child.stderr.end();
  child.emit('exit', 1, null);
  const error = await stopped.catch((value) => value);
  assert.equal(error.code, 'DATABASE_UPGRADE_REQUIRED');
  assert.deepEqual({ ...error.databaseUpgrade }, { databaseVersion: 99999, supportedVersion: 147 });
});

test('DCC-013: the newer-database message still counts when it arrives after the exit event or split across chunks', async () => {
  const { child, stopped } = watchBackend();
  child.emit('exit', 1, null);
  child.stderr.write('[migrations] 数据库版本 99999 高于当前');
  child.stderr.write('程序支持的 147。\n');
  child.stderr.end();
  const error = await stopped.catch((value) => value);
  assert.equal(error.code, 'DATABASE_UPGRADE_REQUIRED');
  assert.equal(error.databaseUpgrade.databaseVersion, 99999);
});

test('DCC-013: other backend failures stay ordinary startup errors; exit code 78 alone also means a newer database', async () => {
  const crashed = watchBackend();
  crashed.child.stderr.write('Error: Cannot find module better-sqlite3\n');
  crashed.child.stderr.end();
  crashed.child.emit('exit', 1, null);
  const crash = await crashed.stopped.catch((value) => value);
  assert.equal(crash.code, undefined);
  assert.match(crash.message, /code=1/);

  // 孙进程占着 stderr 不关：最多等 1 秒就按已读到的内容判断，不会一直挂着。
  const held = watchBackend();
  held.child.emit('exit', 78, null);
  assert.equal(held.timers.length, 1);
  held.timers[0]();
  const guarded = await held.stopped.catch((value) => value);
  assert.equal(guarded.code, 'DATABASE_UPGRADE_REQUIRED');
  assert.equal(guarded.databaseUpgrade, null);
});

/** 运行 main.js 里真实的 showDatabaseUpgradeGuard，按 choices 依次点按钮。 */
function guard({ enabled = true, checkResult = { phase: 'ready' }, choices = [] } = {}) {
  const calls = [];
  const boxes = [];
  const context = {
    closeSplash: () => calls.push(['close-splash']),
    getUserDataPath: () => '/Users/demo/nowen-data',
    buildReleaseDownloadUrl: () => 'https://download.nowen.cn/latest',
    hotUpdate: {
      reportEnvironmentFailure: (reason) => calls.push(['environment-failure', reason]),
      getStatus: () => ({ enabled }),
      check: async (options) => {
        calls.push(['check', { ...options }]);
        return checkResult;
      },
      apply: () => {
        calls.push(['apply']);
        return true;
      },
    },
    dialog: {
      showMessageBox: async (options) => {
        boxes.push(options);
        const choice = options.buttons.includes(choices[0]) ? choices.shift() : options.buttons[options.cancelId ?? 0];
        return { response: options.buttons.indexOf(choice) };
      },
    },
    shell: { openExternal: async (url) => calls.push(['open', url]) },
    app: { quit: () => calls.push(['quit']) },
  };
  vm.createContext(context);
  vm.runInContext(between('async function showDatabaseUpgradeGuard(err)', '\n}\n') + '\n}\n', context);
  return { context, calls, boxes };
}

const upgradeError = { code: 'DATABASE_UPGRADE_REQUIRED', databaseUpgrade: { databaseVersion: 99999, supportedVersion: 147 } };

test('DCC-013: the desktop guard only offers safe exits and may re-fetch a blocked newer bundle', async () => {
  const { context, calls, boxes } = guard({ choices: ['获取最新版本'] });
  await context.showDatabaseUpgradeGuard(upgradeError);
  assert.deepEqual([...boxes[0].buttons], ['获取最新版本', '下载最新安装包', '退出']);
  assert.equal(boxes[0].cancelId, 2);
  assert.match(boxes[0].detail, /数据版本 99999，当前版本最高支持 147/);
  assert.match(boxes[0].detail, /\/Users\/demo\/nowen-data/);
  assert.deepEqual(calls, [
    ['close-splash'],
    ['environment-failure', 'database-upgrade-required'],
    ['check', { manual: true, retryBlocked: true }],
    ['apply'],
  ]);
});

test('DCC-013: without a newer bundle the desktop guard keeps the data untouched until the user downloads or quits', async () => {
  const { context, calls, boxes } = guard({ checkResult: { phase: 'up-to-date', message: '当前已是最新版本' }, choices: ['获取最新版本', '下载最新安装包', '退出'] });
  await context.showDatabaseUpgradeGuard(upgradeError);
  assert.equal(boxes[1].message, '当前已是最新版本');
  assert.deepEqual(calls.map(([name]) => name), ['close-splash', 'environment-failure', 'check', 'open', 'quit']);
  assert.equal(calls.find(([name]) => name === 'open')[1], 'https://download.nowen.cn/latest');

  const disabled = guard({ enabled: false });
  await disabled.context.showDatabaseUpgradeGuard({ code: 'DATABASE_UPGRADE_REQUIRED', databaseUpgrade: null });
  assert.deepEqual([...disabled.boxes[0].buttons], ['下载最新安装包', '退出'], '热更新不可用时不出现「获取最新版本」');
  assert.deepEqual(disabled.calls.map(([name]) => name), ['close-splash', 'environment-failure', 'quit']);
});
