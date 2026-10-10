'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
test('Android WebView audio capture has both required manifest permissions', () => {
  const manifest = read('frontend/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android.permission.RECORD_AUDIO/);
  assert.match(manifest, /android.permission.MODIFY_AUDIO_SETTINGS/);
});
test('iOS and both macOS builds declare microphone use', () => {
  assert.match(read('frontend/ios/App/App/Info.plist'), /NSMicrophoneUsageDescription/);
  assert.match(read('electron/builder.base.config.js'), /NSMicrophoneUsageDescription/);
  assert.match(read('electron/builder.lite.base.config.js'), /NSMicrophoneUsageDescription/);
  assert.match(read('build/entitlements.mac.plist'), /com.apple.security.device.audio-input/);
});
