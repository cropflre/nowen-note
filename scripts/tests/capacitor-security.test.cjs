const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
// GHSA-rvm3-566m-v7fv: use the maintained 8.4 patch line for all native entry points.
const fixedVersion = '8.4.3';
for (const directory of ['', 'frontend']) {
  test(`Capacitor security release is pinned and locked consistently in ${directory || 'root'}`, () => {
    const base = path.join(root, directory);
    const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8'));
    for (const name of ['@capacitor/core', '@capacitor/cli', '@capacitor/android', ...(directory ? ['@capacitor/ios'] : [])]) {
      assert.equal(pkg.devDependencies[name], fixedVersion, `${name} must use the reviewed security patch`);
      assert.equal(lock.packages[''].devDependencies[name], fixedVersion);
      assert.equal(lock.packages[`node_modules/${name}`].version, fixedVersion);
    }
  });
}

test('installed Android and iOS runtimes contain both proxy navigation and serving guards', () => {
  const native = path.join(root, 'frontend/node_modules/@capacitor');
  const read = (name) => fs.readFileSync(path.join(native, name), 'utf8');
  const android = read('android/capacitor/src/main/java/com/getcapacitor/WebViewLocalServer.java');
  assert.match(android, /if\s*\(!httpEnabled\s*\|\|\s*isDocumentRequest\(request\)\)/);
  assert.match(read('android/capacitor/src/main/java/com/getcapacitor/Bridge.java'), /path\.startsWith\(CAPACITOR_HTTP_INTERCEPTOR_START\)/);
  const ios = read('ios/Capacitor/Capacitor/WebViewDelegationHandler.swift');
  assert.match(ios, /navURL\.path\.starts\(with: CapacitorBridge\.httpInterceptorStartIdentifier\)/);
  assert.match(ios, /decisionHandler\(\.cancel\)/);
  assert.match(read('ios/Capacitor/Capacitor/WebViewAssetHandler.swift'), /getPluginConfig\("CapacitorHttp"\)\.getBoolean\("enabled", false\) == true/);
});

test('native projects resolve the reviewed runtime without changing the application origin', () => {
  const read = (name) => fs.readFileSync(path.join(root, 'frontend', name), 'utf8');
  assert.match(read('ios/App/Podfile.lock'), /Capacitor \(8\.4\.3\)/);
  assert.match(read('ios/App/Podfile.lock'), /CapacitorCordova \(8\.4\.3\)/);
  assert.match(read('android/capacitor.settings.gradle'), /node_modules\/@capacitor\/android\/capacitor/);
  assert.match(read('capacitor.config.ts'), /appId: "com\.nowen\.note"/);
  assert.doesNotMatch(read('android/app/src/main/assets/capacitor.config.json'), /"url"\s*:/);
});
