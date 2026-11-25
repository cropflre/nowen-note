// 热更新包使用的确定性 ZIP 读写。
//
// 不依赖第三方库：发版机、测试和以后的客户端校验看到的是同一套字节规则。
// - 写入：按路径排序、固定 DOS 时间戳、不写额外字段和目录条目，同一输入两次打包字节完全相同；
// - 读取：只接受本模块写出的结构（无加密、无数据描述符、条目连续），逐条校验 CRC 和长度。
import zlib from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
// 1980-01-01 00:00:00 是 DOS 时间的起点；固定它才能让重复打包得到相同字节。
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const MAX_ENTRIES = 0xffff;
const MAX_UINT32 = 0xffffffff;

function crc32(data) {
  if (typeof zlib.crc32 !== "function") throw new Error("需要 Node.js 22.2 或更高版本（缺少 zlib.crc32）");
  return zlib.crc32(data) >>> 0;
}

export function assertSafeEntryPath(entryPath) {
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

/** @param {{ path: string, data: Buffer }[]} entries */
export function createZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length > MAX_ENTRIES) throw new Error("zip 条目过多（不支持 ZIP64）");
  const parts = [];
  const central = [];
  let offset = 0;
  let previous = null;
  for (const { path: entryPath, data } of sorted) {
    assertSafeEntryPath(entryPath);
    if (entryPath === previous) throw new Error(`zip 条目重复：${entryPath}`);
    previous = entryPath;
    if (!Buffer.isBuffer(data)) throw new Error(`zip 条目内容必须是 Buffer：${entryPath}`);
    const name = Buffer.from(entryPath, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    if (data.length > MAX_UINT32 || offset + 30 + name.length + body.length > MAX_UINT32) {
      throw new Error("zip 体积超过 4 GiB（不支持 ZIP64）");
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + body.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  if (offset + centralSize > MAX_UINT32) throw new Error("zip 体积超过 4 GiB（不支持 ZIP64）");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= lowest; index--) {
    if (buffer.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) return index;
  }
  throw new Error("不是有效的 zip：找不到中央目录结尾");
}

/** @returns {{ path: string, data: Buffer }[]} */
export function readZip(buffer) {
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
    // maxOutputLength 防止解压炸弹：声明的长度就是上限。
    const data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, size) }) : Buffer.from(body);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip 条目内容校验失败：${entryPath}`);
    entries.push({ path: entryPath, data });
    expectedLocal = dataEnd;
    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (cursor !== end || expectedLocal !== centralOffset) throw new Error("zip 结构不完整或带有多余数据");
  return entries;
}
