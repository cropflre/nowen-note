/**
 * Stable release wrapper around the Lite desktop builder configuration.
 *
 * Lite uses an explicit latest-lite channel so release.sh can collect the
 * metadata without mixing it with the full latest channel.
 */
const base = require("./builder.lite.base.config.js");

const { artifactName: _legacyWindowsArtifactName, ...win } = base.win || {};

module.exports = {
  ...base,
  publish: (base.publish || []).map((provider) => ({
    ...provider,
    channel: "latest-lite",
  })),
  files: [
    ...(Array.isArray(base.files) ? base.files : []),
    "!electron/builder.base.config.js",
    "!electron/builder.lite.base.config.js",
  ],
  win,
  nsis: {
    ...(base.nsis || {}),
    artifactName: "Nowen-Note-Lite-${version}-setup.${ext}",
  },
  portable: {
    ...(base.portable || {}),
    artifactName: "Nowen-Note-Lite-${version}-portable.${ext}",
  },
  mac: {
    ...(base.mac || {}),
    artifactName: "Nowen-Note-Lite-${version}-${arch}.${ext}",
  },
  dmg: {
    ...(base.dmg || {}),
    artifactName: "Nowen-Note-Lite-${version}-${arch}.${ext}",
  },
  linux: {
    ...(base.linux || {}),
    artifactName: "Nowen-Note-Lite-${version}-${arch}.${ext}",
  },
  appImage: {
    ...(base.appImage || {}),
    artifactName: "Nowen-Note-Lite-${version}-${arch}.${ext}",
  },
};
