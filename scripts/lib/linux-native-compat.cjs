'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_LIMITS = Object.freeze({
  glibc: process.env.NOWEN_LINUX_MAX_GLIBC || '2.31',
  glibcxx: process.env.NOWEN_LINUX_MAX_GLIBCXX || '3.4.28',
  cxxabi: process.env.NOWEN_LINUX_MAX_CXXABI || '1.3.12',
});

function compareVersions(left, right) {
  const a = String(left || '').split('.').map((part) => Number(part) || 0);
  const b = String(right || '').split('.').map((part) => Number(part) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function maxVersion(versions) {
  return versions.reduce(
    (current, candidate) => (!current || compareVersions(candidate, current) > 0 ? candidate : current),
    null,
  );
}

function extractVersionRequirements(contents, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}_(\\d+(?:\\.\\d+)+)`, 'g');
  const text = Buffer.isBuffer(contents) ? contents.toString('latin1') : String(contents || '');
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))]
    .sort(compareVersions);
}

function detectElfArchitecture(contents) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents || '');
  if (
    buffer.length < 20 ||
    buffer[0] !== 0x7f ||
    buffer[1] !== 0x45 ||
    buffer[2] !== 0x4c ||
    buffer[3] !== 0x46
  ) {
    return 'not-elf';
  }
  const littleEndian = buffer[5] === 1;
  const machine = littleEndian ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  if (machine === 0x3e) return 'x64';
  if (machine === 0xb7) return 'arm64';
  return `unknown-${machine}`;
}

function inspectDynamicLinks(filePath) {
  if (process.platform !== 'linux') return { missing: [], output: '' };
  const result = spawnSync('ldd', [filePath], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const missing = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bnot found\b/i.test(line));
  return { missing, output, status: result.status };
}

function inspectLinuxNativeBinary(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`原生模块不存在：${resolved}`);
  }

  const contents = fs.readFileSync(resolved);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const versions = {
    glibc: extractVersionRequirements(contents, 'GLIBC'),
    glibcxx: extractVersionRequirements(contents, 'GLIBCXX'),
    cxxabi: extractVersionRequirements(contents, 'CXXABI'),
  };
  const maximums = {
    glibc: maxVersion(versions.glibc),
    glibcxx: maxVersion(versions.glibcxx),
    cxxabi: maxVersion(versions.cxxabi),
  };
  const dynamicLinks = options.skipLdd ? { missing: [], output: '', status: null } : inspectDynamicLinks(resolved);
  const violations = [];

  for (const key of ['glibc', 'glibcxx', 'cxxabi']) {
    const actual = maximums[key];
    const limit = limits[key];
    if (actual && limit && compareVersions(actual, limit) > 0) {
      violations.push(`${key.toUpperCase()}_${actual} 超过兼容上限 ${key.toUpperCase()}_${limit}`);
    }
  }
  for (const line of dynamicLinks.missing) {
    violations.push(`缺少动态库：${line}`);
  }

  const architecture = detectElfArchitecture(contents);
  if (options.expectedArch && architecture !== options.expectedArch) {
    violations.push(`ELF 架构不匹配：期望 ${options.expectedArch}，实际 ${architecture}`);
  }

  return {
    filePath: resolved,
    size: contents.length,
    architecture,
    limits,
    versions,
    maximums,
    dynamicLinks,
    violations,
    ok: violations.length === 0,
  };
}

function formatCompatibilityReport(report) {
  const version = (name, actual, limit) => `${name}: ${actual || '未声明'}（上限 ${limit}）`;
  const lines = [
    `[linux-native] file: ${report.filePath}`,
    `[linux-native] arch: ${report.architecture}`,
    `[linux-native] size: ${(report.size / 1024 / 1024).toFixed(2)} MiB`,
    `[linux-native] ${version('GLIBC', report.maximums.glibc, report.limits.glibc)}`,
    `[linux-native] ${version('GLIBCXX', report.maximums.glibcxx, report.limits.glibcxx)}`,
    `[linux-native] ${version('CXXABI', report.maximums.cxxabi, report.limits.cxxabi)}`,
  ];
  if (report.violations.length > 0) {
    lines.push('[linux-native] compatibility violations:');
    for (const violation of report.violations) lines.push(`  - ${violation}`);
  } else {
    lines.push('[linux-native] compatibility check passed');
  }
  return lines.join('\n');
}

function assertLinuxNativeBinaryCompatible(filePath, options = {}) {
  const report = inspectLinuxNativeBinary(filePath, options);
  if (!report.ok) {
    const error = new Error(formatCompatibilityReport(report));
    error.code = 'NOWEN_LINUX_NATIVE_INCOMPATIBLE';
    error.report = report;
    throw error;
  }
  return report;
}

module.exports = {
  DEFAULT_LIMITS,
  compareVersions,
  maxVersion,
  extractVersionRequirements,
  detectElfArchitecture,
  inspectLinuxNativeBinary,
  formatCompatibilityReport,
  assertLinuxNativeBinaryCompatible,
};
