// 热更新包的 zip 读取（壳代码，永不热更新）。
//
// 与发版流水线 scripts/hot-update/lib/zip.mjs 的写法一一对应，只接受那份写法产出的结构：
// 无加密、无数据描述符、条目连续，逐条校验 CRC 和长度，拒绝不安全路径。
"use strict";

const zlib = require("node:zlib");

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;

function crc32(data) {
  if (typeof zlib.crc32 !== "function") throw new Error("需要 Node.js 22.2 或更高版本（缺少 zlib.crc32）");
  return zlib.crc32(data) >>> 0;
}

function assertSafeEntryPath(entryPath) {
  if (typeof entryPath !== "string" || entryPath.length === 0 || entryPath.length > 512) {
    throw new Error(`zip 条目路径无效：${String(entryPath)}`);
  }
  if (entryPath.startsWith("/") || entryPath.includes("\\") || entryPath.includes(":") || /[\u0000-\u001f\u007f]/.test(entryPath)) {
    throw new Error(`zip 条目路径不安全：${entryPath}`);
  }
  if (entryPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`zip 条目路径不安全：${entryPath}`);
  }
}

function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= lowest; index--) {
    if (buffer.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) return index;
  }
  throw new Error("不是有效的 zip：找不到中央目录结尾");
}

/** @returns {{ path: string, data: Buffer }[]} */
function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error("不是有效的 zip");
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const commentLength = buffer.readUInt16LE(end + 20);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 || buffer.readUInt16LE(end + 8) !== count) {
    throw new Error("不支持分卷 zip");
  }
  if (end + 22 + commentLength !== buffer.length || centralOffset + centralSize !== end) {
    throw new Error("zip 结构不完整或带有多余数据");
  }
  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let expectedLocal = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) throw new Error("zip 中央目录损坏");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if ((flags & ~UTF8_FLAG) !== 0) throw new Error("zip 含加密或数据描述符条目，拒绝读取");
    if (method !== 0 && method !== 8) throw new Error(`zip 压缩方式不受支持：${method}`);
    const entryPath = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    assertSafeEntryPath(entryPath);
    if (names.has(entryPath)) throw new Error(`zip 条目重复：${entryPath}`);
    names.add(entryPath);
    if (localOffset !== expectedLocal || localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new Error(`zip 条目位置异常：${entryPath}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    if (
      buffer.readUInt16LE(localOffset + 6) !== flags ||
      buffer.readUInt16LE(localOffset + 8) !== method ||
      buffer.readUInt32LE(localOffset + 14) !== crc ||
      buffer.readUInt32LE(localOffset + 18) !== compressedSize ||
      buffer.readUInt32LE(localOffset + 22) !== size ||
      buffer.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength) !== entryPath
    ) {
      throw new Error(`zip 本地头与中央目录不一致：${entryPath}`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw new Error(`zip 条目越界：${entryPath}`);
    const body = buffer.subarray(dataStart, dataEnd);
    const data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, size) }) : Buffer.from(body);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip 条目内容校验失败：${entryPath}`);
    entries.push({ path: entryPath, data });
    expectedLocal = dataEnd;
    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (cursor !== end || expectedLocal !== centralOffset) throw new Error("zip 结构不完整或带有多余数据");
  return entries;
}

module.exports = { assertSafeEntryPath, readZip };
