// Unsigned acceptance artifact; production resources, guards and application code.
const path = require('node:path');
const base = require('../electron/builder.config.js');
module.exports = {
  ...base,
  directories: { ...base.directories, output: 'frontend/node_modules/.cache/nas-offline-packaged' },
  extraMetadata: { main: 'scripts/nas-offline-app-fixture.cjs' },
  files: [...base.files, 'scripts/nas-offline-app-fixture.cjs'],
  extraResources: [...base.extraResources, { from: 'scripts/nas-offline-backend-fixture.cjs', to: 'nas-offline-backend-fixture.cjs' }],
  electronDist: path.resolve(__dirname, '../node_modules/electron/dist'),
  mac: { ...base.mac, identity: null },
  afterSign: null,
};
