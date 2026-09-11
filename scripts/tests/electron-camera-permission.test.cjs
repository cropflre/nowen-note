'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const security = require('../../electron/security');
const {
  mediaTypesAreVideoOnly,
  shouldAllowCameraPermission,
  wrapRendererSession,
} = require('../../electron/camera-permission');

function trustedWebContents(id = 77, url = 'file:///C:/Nowen/frontend/dist/index.html') {
  return {
    id,
    getURL: () => url,
  };
}

test.beforeEach(() => {
  security.setTrustedMainWindowId(77);
});

test('camera policy only accepts trusted main renderer video permission', () => {
  const wc = trustedWebContents();
  assert.equal(shouldAllowCameraPermission(wc, 'media', {
    mediaTypes: ['video'],
    requestingUrl: wc.getURL(),
  }, security), true);

  assert.equal(shouldAllowCameraPermission(wc, 'media', {
    mediaTypes: ['audio'],
    requestingUrl: wc.getURL(),
  }, security), false);

  assert.equal(shouldAllowCameraPermission(wc, 'media', {
    mediaTypes: ['video', 'audio'],
    requestingUrl: wc.getURL(),
  }, security), false);

  assert.equal(shouldAllowCameraPermission(wc, 'notifications', {}, security), false);
});

test('camera policy rejects wrong BrowserWindow and external iframe origin', () => {
  const trusted = trustedWebContents();
  const wrongWindow = trustedWebContents(99);

  assert.equal(shouldAllowCameraPermission(wrongWindow, 'media', {
    mediaTypes: ['video'],
    requestingUrl: wrongWindow.getURL(),
  }, security), false);

  assert.equal(shouldAllowCameraPermission(trusted, 'media', {
    mediaTypes: ['video'],
    requestingUrl: 'https://evil.example/camera.html',
  }, security), false);
});

test('video-only helper rejects microphone requests but tolerates Electron without mediaTypes detail', () => {
  assert.equal(mediaTypesAreVideoOnly({ mediaTypes: ['video'] }), true);
  assert.equal(mediaTypesAreVideoOnly({ mediaTypes: ['audio'] }), false);
  assert.equal(mediaTypesAreVideoOnly({ mediaTypes: ['video', 'audio'] }), false);
  assert.equal(mediaTypesAreVideoOnly({}), true);
});

test('session wrapper composes with existing notifications/fullscreen policy', () => {
  let requestHandler = null;
  let checkHandler = null;
  const fakeSession = {
    setPermissionRequestHandler(handler) { requestHandler = handler; },
    setPermissionCheckHandler(handler) { checkHandler = handler; },
  };
  wrapRendererSession(fakeSession, security);

  fakeSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'notifications' || permission === 'fullscreen');
  });
  fakeSession.setPermissionCheckHandler((_wc, permission) => (
    permission === 'notifications' || permission === 'fullscreen'
  ));

  const wc = trustedWebContents();
  let cameraDecision = null;
  requestHandler(wc, 'media', (allowed) => { cameraDecision = allowed; }, {
    mediaTypes: ['video'],
    requestingUrl: wc.getURL(),
  });
  assert.equal(cameraDecision, true);

  let microphoneDecision = null;
  requestHandler(wc, 'media', (allowed) => { microphoneDecision = allowed; }, {
    mediaTypes: ['audio'],
    requestingUrl: wc.getURL(),
  });
  assert.equal(microphoneDecision, false);

  let notificationDecision = null;
  requestHandler(wc, 'notifications', (allowed) => { notificationDecision = allowed; }, {});
  assert.equal(notificationDecision, true);

  assert.equal(checkHandler(wc, 'media', wc.getURL(), { mediaTypes: ['video'] }), true);
  assert.equal(checkHandler(wc, 'media', wc.getURL(), { mediaTypes: ['audio'] }), false);
  assert.equal(checkHandler(wc, 'fullscreen', wc.getURL(), {}), true);
});
