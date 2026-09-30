'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const security = require('../../electron/security');
const { allowVoicePermissionRequest, allowVoicePermissionCheck } = require('../../electron/voice-permissions');
const wc = { id: 77, getURL: () => 'file:///C:/Nowen/frontend/dist/index.html' };
test.beforeEach(() => security.setTrustedMainWindowId(77));
test('microphone is allowed only for the registered main document', () => {
  const details = { requestingUrl: wc.getURL(), isMainFrame: true, mediaTypes: ['audio'] };
  assert.equal(allowVoicePermissionRequest(wc, details), true);
  assert.equal(allowVoicePermissionCheck(wc, { ...details, mediaType: 'audio' }), true);
  assert.equal(allowVoicePermissionRequest({ ...wc, id: 88 }, details), false);
  assert.equal(allowVoicePermissionRequest(wc, { ...details, isMainFrame: false }), false);
  assert.equal(allowVoicePermissionRequest(wc, { ...details, requestingUrl: 'https://evil.example/' }), false);
  assert.equal(allowVoicePermissionRequest(wc, { ...details, requestingUrl: 'file:///C:/other.html' }), false);
});
test('video, mixed media and unknown media remain denied by the audio policy', () => {
  const details = { requestingUrl: wc.getURL(), isMainFrame: true };
  assert.equal(allowVoicePermissionRequest(wc, { ...details, mediaTypes: ['video'] }), false);
  assert.equal(allowVoicePermissionRequest(wc, { ...details, mediaTypes: ['audio', 'video'] }), false);
  assert.equal(allowVoicePermissionRequest(wc, details), false);
  assert.equal(allowVoicePermissionCheck(wc, { ...details, mediaType: 'unknown' }), false);
});
