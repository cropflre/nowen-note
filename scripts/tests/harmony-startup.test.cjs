const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('../../frontend/node_modules/typescript');

const root = path.resolve(__dirname, '../..');

test('HarmonyOS loads its registered entry page after preferences are ready', async () => {
  let ready;
  let initializedContext;
  const preferencesReady = new Promise(resolve => { ready = resolve; });
  const source = fs.readFileSync(path.join(root,
    'nowen-harmony/entry/src/main/ets/entryability/EntryAbility.ets'), 'utf8');
  const exports = {};
  const mocks = {
    '@kit.AbilityKit': { UIAbility: class {} },
    '@kit.ArkUI': {},
    '../services/PreferenceStore': {
      initPreferenceStore(context) {
        initializedContext = context;
        return preferencesReady;
      },
    },
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
    return mocks[name];
  }, console });
  const ability = new exports.default();
  ability.context = {};
  const loaded = [];
  const windowSetup = [];
  ability.onCreate({}, {});
  ability.onWindowStageCreate({
    getMainWindow(callback) {
      callback({ code: 0 }, {
        setWindowLayoutFullScreen(fullScreen) { windowSetup.push(fullScreen); },
        setWindowSystemBarProperties() { windowSetup.push('systemBars'); },
      });
    },
    loadContent(page, callback) {
      loaded.push(page);
      callback({ code: 0 });
    },
  });
  assert.deepEqual(windowSetup, [true, 'systemBars']);
  assert.equal(initializedContext, ability.context);
  assert.deepEqual(loaded, [], 'Do not read saved server configuration before initialization');
  ready();
  await preferencesReady;
  await Promise.resolve();
  assert.deepEqual(loaded, ['pages/Index']);
  const pages = JSON.parse(fs.readFileSync(path.join(root,
    'nowen-harmony/entry/src/main/resources/base/profile/main_pages.json'), 'utf8'));
  assert.ok(pages.src.includes(loaded[0]), 'Entry page must be registered');
});
