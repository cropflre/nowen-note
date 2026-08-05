#!/usr/bin/env node
'use strict';

const path = require('node:path');

const moduleRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'backend', 'node_modules', 'better-sqlite3');

try {
  const Database = require(moduleRoot);
  const db = new Database(':memory:');
  const row = db.prepare('SELECT 46 AS value').get();
  db.close();
  if (row?.value !== 46) throw new Error(`unexpected sqlite result: ${JSON.stringify(row)}`);
  console.log(`[linux-native] better-sqlite3 smoke passed: ${moduleRoot}`);
} catch (error) {
  console.error(`[linux-native] better-sqlite3 smoke failed: ${moduleRoot}`);
  console.error(error?.stack || error);
  process.exit(1);
}
