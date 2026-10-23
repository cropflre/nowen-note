import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const { build } = require('esbuild');
const studio = process.env.DEVECO_STUDIO_HOME || '/Applications/DevEco-Studio.app/Contents';
const hdc = path.join(studio, 'sdk/default/openharmony/toolchains/hdc');
const target = process.env.HDC_TARGET || '127.0.0.1:5555';
const shell = (...args) => execFileSync(hdc, ['-t', target, 'shell', ...args], { encoding: 'utf8' });
const web = path.join(root, 'nowen-harmony/entry/src/main/resources/rawfile/web');
const page = path.join(root, 'nowen-harmony/entry/src/main/ets/pages/WebViewPage.ets');
const original = readFileSync(page, 'utf8');
const instrumented = original.replace("Web({ src: 'https://localhost/'", "Web({ src: 'https://localhost/harmony-smoke.html'");
if (!existsSync(path.join(web, 'index.html'))) throw new Error('Run npm run build:harmony:web first');
if (original === instrumented) throw new Error('Cannot identify the local Web entry');
function assembleAndInstall() {
  execFileSync(path.join(studio, 'tools/hvigor/bin/hvigorw'), ['--mode', 'module', '-p', 'product=default', '-p',
    'module=entry@default', '-p', 'buildMode=debug', 'assembleHap', '--no-daemon'], {
    cwd: path.join(root, 'nowen-harmony'), stdio: 'inherit', env: { ...process.env,
      NODE_HOME: path.join(studio, 'tools/node'), JAVA_HOME: path.join(studio, 'jbr/Contents/Home'),
      DEVECO_SDK_HOME: path.join(studio, 'sdk') },
  });
  shell('aa', 'force-stop', 'com.nowen.note');
  execFileSync(hdc, ['-t', target, 'install', path.join(root,
    'nowen-harmony/entry/build/default/outputs/default/entry-default-unsigned.hap')], { stdio: 'inherit' });
}
async function phase(marker) {
  shell('aa', 'force-stop', 'com.nowen.note');
  shell('aa', 'start', '-a', 'EntryAbility', '-b', 'com.nowen.note');
  for (let count = 0; count < 60; count++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const pid = shell('pidof', 'com.nowen.note').trim();
    if (!pid) continue;
    const logs = shell('hilog', '-x', '-P', pid);
    const failure = logs.split('\n').find(line => line.includes('HARMONY_SMOKE_FAIL'));
    if (failure) throw new Error(failure);
    if (logs.includes(marker)) { console.log(marker); return; }
  }
  throw new Error('Timed out waiting for ' + marker);
}
let patched = false;
try {
  await build({ entryPoints: [path.join(root, 'scripts/harmony-native-smoke.ts')], bundle: true,
    outfile: path.join(web, 'harmony-smoke.js'), format: 'iife', platform: 'browser',
    define: { __HARMONY_TEST_ACCOUNT__: JSON.stringify('harmony-emulator-regression-' + Date.now()) },
    tsconfig: path.join(root, 'frontend/tsconfig.app.json') });
  writeFileSync(path.join(web, 'harmony-smoke.html'),
    '<!doctype html><html><head><script src="/harmony-runtime.js"></script></head><body><script src="/harmony-smoke.js"></script></body></html>');
  writeFileSync(page, instrumented);
  patched = true;
  assembleAndInstall();
  await phase('HARMONY_SMOKE_RESTART_READY');
  await phase('HARMONY_SMOKE_PASS');
} finally {
  // Never leave a test page or test entry in the distributable, even on failure.
  for (const name of ['harmony-smoke.html', 'harmony-smoke.js']) rmSync(path.join(web, name), { force: true });
  if (patched) {
    if (readFileSync(page, 'utf8') !== instrumented) throw new Error('Web entry changed during test; restore it manually');
    writeFileSync(page, original);
    assembleAndInstall();
    shell('aa', 'start', '-a', 'EntryAbility', '-b', 'com.nowen.note');
  }
}
