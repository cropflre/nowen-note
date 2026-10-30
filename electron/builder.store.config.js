"use strict";

// Verified public Partner Center package identity (no private credential).
const base = require("./builder.config.js");
const { getVerifiedStoreIdentity } = require("./storeIdentity");

function createStoreConfig(identity) {
  return {
    ...base,
    directories: { ...base.directories, output: "dist-electron-store" },
    // Store artifacts must never enter the existing NSIS/SignPath/GitHub release stream.
    publish: null,
    win: {
      ...base.win,
      target: [{ target: "appx", arch: ["x64"] }],
      artifactName: "Nowen-Note-Store-\x24{version}-\x24{arch}.\x24{ext}",
    },
    appx: {
      ...identity,
      displayName: "Nowen Note",
      languages: ["zh-CN", "en-US"],
      // electron-builder 25.1.8 does not accept appx.capabilities in its schema.
      // Its AppX generator declares the mandatory runFullTrust capability by default.
      // Validate the generated manifest in CI, rather than passing an unsupported key.
      minVersion: "10.0.19041.0",
    },
  };
}

// A Store submission cannot be accidentally built with guessed Microsoft identity values.
module.exports = createStoreConfig(getVerifiedStoreIdentity());
