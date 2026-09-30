const { isTrustedMainWebContents } = require("./security");

function isTrustedVoiceRequest(webContents, details = {}) {
  if (!isTrustedMainWebContents(webContents) || details.isMainFrame !== true || !details.requestingUrl) return false;
  try {
    const page = new URL(webContents.getURL());
    const requester = new URL(details.requestingUrl);
    // 本地 file 页面不共享普通 origin，必须绑定到同一个页面路径。
    return page.protocol === "file:"
      ? requester.protocol === "file:" && requester.pathname === page.pathname
      : requester.origin === page.origin;
  } catch { return false; }
}

function allowVoicePermissionRequest(webContents, details) {
  return isTrustedVoiceRequest(webContents, details)
    && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === "audio";
}
function allowVoicePermissionCheck(webContents, details) {
  return isTrustedVoiceRequest(webContents, details) && details.mediaType === "audio";
}

module.exports = { allowVoicePermissionRequest, allowVoicePermissionCheck };
