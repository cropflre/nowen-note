'use strict';

const childProcess = require('node:child_process');
const electron = require('electron');

const recentBackendOutput = [];
const outputLimit = 160;
const nativeFailurePattern = /ERR_DLOPEN_FAILED|GLIBC(?:XX)?_[0-9.]+|CXXABI_[0-9.]+|better_sqlite3\.node|NODE_MODULE_VERSION|wrong ELF|invalid ELF|not found|Module did not self-register/i;

function remember(source, value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => `[${source}] ${line}`);
  recentBackendOutput.push(...lines);
  if (recentBackendOutput.length > outputLimit) {
    recentBackendOutput.splice(0, recentBackendOutput.length - outputLimit);
  }
}

function isBackendSpawn(args) {
  return Array.isArray(args) && args.some((value) => /backend[\\/]dist[\\/]index\.js$/i.test(String(value)));
}

const originalSpawn = childProcess.spawn.bind(childProcess);
childProcess.spawn = function patchedSpawn(command, args, options) {
  const child = originalSpawn(command, args, options);
  if (!isBackendSpawn(args)) return child;

  recentBackendOutput.length = 0;
  child.stdout?.on('data', (chunk) => remember('stdout', chunk));
  child.stderr?.on('data', (chunk) => remember('stderr', chunk));
  child.on('error', (error) => remember('spawn', error?.stack || error));
  child.on('exit', (code, signal) => remember('exit', `code=${code} signal=${signal || ''}`));
  return child;
};

const originalShowErrorBox = electron.dialog.showErrorBox.bind(electron.dialog);
electron.dialog.showErrorBox = function patchedShowErrorBox(title, content) {
  if (!/Nowen Note 启动失败/.test(String(title)) || recentBackendOutput.length === 0) {
    return originalShowErrorBox(title, content);
  }

  const priority = recentBackendOutput.filter((line) => nativeFailurePattern.test(line));
  const excerpt = (priority.length > 0 ? priority : recentBackendOutput).slice(-28);
  if (excerpt.length === 0 || String(content).includes('后端原始错误')) {
    return originalShowErrorBox(title, content);
  }

  const nativeFailure = excerpt.some((line) => nativeFailurePattern.test(line));
  const diagnosis = nativeFailure
    ? '检测到 SQLite 原生模块加载失败。安装包中的 better_sqlite3.node 与当前 Linux 运行环境不兼容。\n\n'
    : '';
  const enhanced = `${content}\n\n— 后端原始错误 —\n${diagnosis}${excerpt.join('\n')}`;
  return originalShowErrorBox(title, enhanced);
};

require('./main.js');
