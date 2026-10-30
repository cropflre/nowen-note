const path = require('path');
const checkout = path.resolve(__dirname, '../../../../..');
const base = require(path.join(checkout, 'electron/builder.config.js'));
module.exports = {
  ...base,
  appId: 'com.nowen.note.qa152',
  productName: 'Nowen Note QA152',
  extraMetadata: { version: '1.5.2-qa.98d1ddf5' },
  directories: { ...base.directories, output: path.join(checkout, '.qa152-windows-release') },
  npmRebuild: false,
  publish: null,
  win: { ...base.win, signAndEditExecutable: false },
};
