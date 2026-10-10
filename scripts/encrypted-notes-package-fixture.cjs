// Acceptance-only wrapper; keep the production Full resources and packaging guards.
const path = require("node:path");
const base = require("../electron/builder.config.js");
module.exports = {
  ...base,
  directories: { ...base.directories, output: "frontend/node_modules/.cache/encrypted-notes-packaged" },
  extraMetadata: { main: "scripts/encrypted-notes-app-fixture.cjs" },
  files: [...base.files, "scripts/encrypted-notes-app-fixture.cjs"],
  extraResources: [...base.extraResources, {
    from: "scripts/encrypted-notes-backend-fixture.cjs", to: "encrypted-notes-backend-fixture.cjs",
  }],
  electronDist: path.resolve(__dirname, "../node_modules/electron/dist"),
  mac: { ...base.mac, identity: null },
  afterSign: null,
};
