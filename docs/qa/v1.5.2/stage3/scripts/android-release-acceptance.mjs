import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Reuse the existing production-bridge acceptance harness with an isolated
// package/port and evidence path. No changes to installed production data.
const [checkoutArg, evidenceArg, serial] = process.argv.slice(2);
const checkout = path.resolve(checkoutArg), evidence = path.resolve(evidenceArg);
const electron = path.join(checkout, 'node_modules/electron/dist/electron.exe');
const loader = path.join(checkout, 'backend/node_modules/tsx/dist/loader.mjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-qa152-android-'));
fs.mkdirSync(evidence, { recursive: true });
const serverFile = path.join(checkout, 'backend/tests/.qa152-device-server.ts');
const driverFile = path.join(checkout, 'scripts/.qa152-device-driver.mjs');
const reportPath = path.join(evidence, 'android-native.json');
const serverSource = fs.readFileSync(path.join(checkout, 'backend/tests/sync-v2-android-server.ts'), 'utf8');
const driverSource = fs.readFileSync(path.join(checkout, 'scripts/android-sync-acceptance.mjs'), 'utf8');
assert.ok(driverSource.includes('com.nowen.note.syncacceptance'));
assert.ok(driverSource.includes('sync-v2-native-folder-trash-2026-10-11.json'));
fs.writeFileSync(serverFile, serverSource.replaceAll('47831', '47832')
  .replaceAll('isolated-android-sync-user', 'qa152-device-' + Date.now()));
fs.writeFileSync(driverFile, driverSource.replaceAll('com.nowen.note.syncacceptance', 'com.nowen.note.qa152')
  .replaceAll('47831', '47832')
  .replace('const ids = await native("createOffline");', `const ids = await native("createOffline");
  const retained = await native("status");
  const queued = await native("pendingMutations");
  assert.equal((await native("tryPermanentDelete", ids[0])).code, "NOTE_NOT_TRASHED");
  assert.deepEqual(await native("status"), retained);
  assert.deepEqual(await native("pendingMutations"), queued);`)
  .replace('offlineImmediateRead: true,', 'activePermanentDeletionRefusedWithRetainedBodyAndOutbox: true, offlineImmediateRead: true,')
  .replace('new URL("../docs/test-results/sync-v2-native-folder-trash-2026-10-11.json", import.meta.url)', JSON.stringify(reportPath)));
let log = '';
const server = spawn(process.execPath, [path.join(checkout, 'docs/qa/v1.5.2/scripts/launch-electron.mjs'), electron, '--import', loader, serverFile], {
  cwd: checkout, env: { ...process.env, SYNC_ACCEPTANCE_DIRECTORY: directory }, windowsHide: true });
server.stdout.on('data', (chunk) => { log += chunk; }); server.stderr.on('data', (chunk) => { log += chunk; });
try {
  for (let i = 0; i < 100 && !fs.existsSync(path.join(directory, 'ready')); i++) {
    assert.equal(server.exitCode, null, 'device fixture server exited');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(fs.existsSync(path.join(directory, 'ready')));
  const driver = spawn(process.execPath, [driverFile, serial], { cwd: checkout, windowsHide: true });
  let driverLog = ''; driver.stdout.on('data', (chunk) => { driverLog += chunk; }); driver.stderr.on('data', (chunk) => { driverLog += chunk; });
  const code = await new Promise((resolve) => driver.once('close', resolve));
  fs.writeFileSync(path.join(evidence, 'android-driver.log'), driverLog);
  fs.writeFileSync(path.join(evidence, 'android-driver.exit'), String(code));
  process.exitCode = code ?? 1;
} finally {
  // Kill the Electron child tree of this test-only launcher on Windows.
  if (server.exitCode === null) {
    const killer = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true });
    await new Promise((resolve) => killer.once('close', resolve));
  }
  fs.writeFileSync(path.join(evidence, 'android-server.log'), log);
  fs.unlinkSync(serverFile); fs.unlinkSync(driverFile);
}
console.log(JSON.stringify({ package: 'com.nowen.note.qa152', evidence, fixture: directory, exitCode: process.exitCode || 0 }));
