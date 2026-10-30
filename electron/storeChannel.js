"use strict";

const STORE_UPDATES_URI = "ms-windows-store://downloadsandupdates";

function isMicrosoftStorePackage(options = {}) {
  const platform = options.platform === undefined ? process.platform : options.platform;
  const packaged = options.packaged === undefined ? true : options.packaged;
  const windowsStore = options.windowsStore === undefined ? process.windowsStore : options.windowsStore;
  return platform === "win32" && packaged === true && windowsStore === true;
}

function storeManagedSnapshot(currentVersion, arch) {
  return {
    status: "store-managed",
    phase: "store-managed",
    currentVersion: String(currentVersion || ""),
    platform: "win32",
    arch: String(arch || ""),
    manualDownload: false,
    installOnQuit: false,
    message: "此版本通过 Microsoft Store 更新，请在微软商店的“库”中管理更新。",
  };
}

module.exports = { STORE_UPDATES_URI, isMicrosoftStorePackage, storeManagedSnapshot };
