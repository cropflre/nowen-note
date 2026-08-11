'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  compareVersions,
  extractVersionRequirements,
  inspectLinuxNativeBinary,
} = require('../lib/linux-native-compat.cjs');

function fakeElf(...symbols) {
  const header = Buffer.alloc(20);
  header[0] = 0x7f;
  header[1] = 0x45;
  header[2] = 0x4c;
  header[3] = 0x46;
  header[5] = 1;
  header.writeUInt16LE(0x3e, 18);
  return Buffer.concat([header, Buffer.from(`\0${symbols.join('\0')}\0`, 'latin1')]);
}

test('compares dotted ABI versions numerically', () => {
  assert.equal(compareVersions('2.31', '2.31'), 0);
  assert.equal(compareVersions('2.34', '2.31'), 1);
  assert.equal(compareVersions('3.4.9', '3.4.28'), -1);
});

test('extracts and sorts unique version requirements', () => {
  const versions = extractVersionRequirements(
    Buffer.from('GLIBC_2.17\0GLIBC_2.31\0GLIBC_2.17\0', 'latin1'),
    'GLIBC',
  );
  assert.deepEqual(versions, ['2.17', '2.31']);
});

test('accepts an Ubuntu 20.04 compatible x64 native module', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-native-ok-'));
  const file = path.join(dir, 'better_sqlite3.node');
  fs.writeFileSync(file, fakeElf('GLIBC_2.31', 'GLIBCXX_3.4.28', 'CXXABI_1.3.12'));
  const report = inspectLinuxNativeBinary(file, { expectedArch: 'x64', skipLdd: true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test('rejects native modules built against newer Linux runtimes', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-native-bad-'));
  const file = path.join(dir, 'better_sqlite3.node');
  fs.writeFileSync(file, fakeElf('GLIBC_2.34', 'GLIBCXX_3.4.29', 'CXXABI_1.3.13'));
  const report = inspectLinuxNativeBinary(file, { expectedArch: 'x64', skipLdd: true });
  assert.equal(report.ok, false);
  assert.match(report.violations.join('\n'), /GLIBC_2\.34/);
  assert.match(report.violations.join('\n'), /GLIBCXX_3\.4\.29/);
  assert.match(report.violations.join('\n'), /CXXABI_1\.3\.13/);
});
