'use strict';

const WRAPPED_SESSION = Symbol.for('nowen.cameraPermissionPolicyWrapped');

function normalizeUrl(value) {
  try { return new URL(String(value || '')); } catch { return null; }
}

function isSameTrustedRendererOrigin(requestingUrl, topUrl) {
  if (!requestingUrl) return true;
  const requester = normalizeUrl(requestingUrl);
  const top = normalizeUrl(topUrl);
  if (!requester || !top) return false;

  if (top.protocol === 'file:') {
    if (requester.protocol !== 'file:') return false;
    // Some Electron permission callbacks expose only the generic file:// security origin,
    // while others expose the full requesting URL. Accept the generic origin but, when a
    // concrete local path is present, require the exact main document path.
    return !requester.pathname || requester.pathname === '/' || requester.pathname === top.pathname;
  }
  if (top.protocol === 'http:' || top.protocol === 'https:') {
    return requester.origin === top.origin;
  }
  return false;
}

function mediaTypesAreVideoOnly(details) {
  const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
  if (mediaTypes.length === 0) return true;
  return mediaTypes.includes('video') && mediaTypes.every((type) => type === 'video');
}

function permissionRequestUrl(details) {
  return details?.requestingUrl || details?.securityOrigin || details?.origin || '';
}

/**
 * Camera permission is intentionally narrower than generic `media` permission:
 * - only the trusted Nowen main renderer may request it;
 * - an external iframe/requesting origin is rejected;
 * - audio/microphone mediaTypes are rejected;
 * - missing mediaTypes remains compatible with Electron builds that do not expose it,
 *   while the frontend still requests `{ video, audio: false }`.
 */
function shouldAllowCameraPermission(webContents, permission, details, security) {
  if (permission !== 'media') return false;
  if (!security?.isTrustedMainWebContents?.(webContents)) return false;
  if (!mediaTypesAreVideoOnly(details)) return false;

  let topUrl = '';
  try { topUrl = webContents.getURL?.() || ''; } catch { return false; }
  return isSameTrustedRendererOrigin(permissionRequestUrl(details), topUrl);
}

function wrapRendererSession(rendererSession, security) {
  if (!rendererSession || rendererSession[WRAPPED_SESSION]) return rendererSession;
  Object.defineProperty(rendererSession, WRAPPED_SESSION, { value: true });

  const nativeSetRequest = rendererSession.setPermissionRequestHandler?.bind(rendererSession);
  if (nativeSetRequest) {
    rendererSession.setPermissionRequestHandler = (handler) => nativeSetRequest(
      (webContents, permission, callback, details = {}) => {
        if (shouldAllowCameraPermission(webContents, permission, details, security)) {
          callback(true);
          return;
        }
        if (typeof handler === 'function') {
          handler(webContents, permission, callback, details);
          return;
        }
        callback(false);
      },
    );
  }

  const nativeSetCheck = rendererSession.setPermissionCheckHandler?.bind(rendererSession);
  if (nativeSetCheck) {
    rendererSession.setPermissionCheckHandler = (handler) => nativeSetCheck(
      (webContents, permission, requestingOrigin, details = {}) => {
        const normalizedDetails = {
          ...details,
          requestingUrl: details?.requestingUrl || requestingOrigin || '',
        };
        if (shouldAllowCameraPermission(webContents, permission, normalizedDetails, security)) {
          return true;
        }
        return typeof handler === 'function'
          ? Boolean(handler(webContents, permission, requestingOrigin, details))
          : false;
      },
    );
  }

  return rendererSession;
}

function installCameraPermissionPolicyBootstrap(electron, security) {
  const { app, session } = electron || {};
  if (!app || !session) return;

  const wrap = (rendererSession) => wrapRendererSession(rendererSession, security);
  app.on?.('session-created', wrap);

  Promise.resolve(app.whenReady?.())
    .then(() => wrap(session.defaultSession))
    .catch(() => undefined);
}

module.exports = {
  installCameraPermissionPolicyBootstrap,
  isSameTrustedRendererOrigin,
  mediaTypesAreVideoOnly,
  shouldAllowCameraPermission,
  wrapRendererSession,
};
