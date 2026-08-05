#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  assertLinuxNativeBinaryCompatible,
  formatCompatibilityReport,
} = require('./lib/linux-native-compat.cjs');

const defaultFile = path.resolve(
  __dirname,
  '..',
  'backend',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
const filePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultFile;
const expectedArch = process.env.TARGET_ARCH || process.env.npm_config_target_arch || process.arch;

try {
  const report = assertLinuxNativeBinaryCompatible(filePath, { expectedArch });
  console.log(formatCompatibilityReport(report));
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
