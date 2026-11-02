// Builder 25's schema cannot express this field. Its artifact hook runs before
// updater manifest generation and can supply it through the platform release info.
// os.release() uses Darwin 21 for macOS 12.
module.exports = function setMacUpdateMinimum(event) {
  if (event.packager.platform.nodeName === "darwin") {
    const options = event.packager.platformSpecificBuildOptions;
    options.releaseInfo = { ...options.releaseInfo, minimumSystemVersion: "21.0.0" };
  }
};
