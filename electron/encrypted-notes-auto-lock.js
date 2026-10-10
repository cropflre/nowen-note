// Native hide/minimize events are not guaranteed to become renderer DOM events.
function attachEncryptedAutoLock(window) {
  const lock = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("security:auto-lock");
  };
  const events = ["blur", "hide", "minimize"];
  for (const event of events) window.on(event, lock);
  window.once("closed", () => {
    for (const event of events) window.removeListener(event, lock);
  });
}
module.exports = { attachEncryptedAutoLock };
