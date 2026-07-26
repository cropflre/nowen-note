const test = require("node:test");
const assert = require("node:assert/strict");

const { decodeTextBuffer } = require("../textEncoding");

test("decodes UTF-8 markdown without changing Chinese content", () => {
  const result = decodeTextBuffer(Buffer.from("# 中文\n保存后不乱码", "utf8"));
  assert.deepEqual(result, {
    content: "# 中文\n保存后不乱码",
    encoding: "utf-8",
    hadBom: false,
  });
});

test("strips UTF-8 BOM", () => {
  const result = decodeTextBuffer(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("# 标题", "utf8"),
  ]));
  assert.equal(result.content, "# 标题");
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.hadBom, true);
});

test("decodes UTF-16LE markdown with BOM", () => {
  const result = decodeTextBuffer(Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("# 中文", "utf16le"),
  ]));
  assert.equal(result.content, "# 中文");
  assert.equal(result.encoding, "utf-16le");
  assert.equal(result.hadBom, true);
});

test("decodes UTF-16BE markdown with BOM", () => {
  const littleEndian = Buffer.from("# 中文", "utf16le");
  const bigEndian = Buffer.from(littleEndian);
  bigEndian.swap16();
  const result = decodeTextBuffer(Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    bigEndian,
  ]));
  assert.equal(result.content, "# 中文");
  assert.equal(result.encoding, "utf-16be");
  assert.equal(result.hadBom, true);
});

test("detects UTF-16LE markdown without BOM when null-byte pattern is clear", () => {
  const result = decodeTextBuffer(Buffer.from("# title\r\nbody", "utf16le"));
  assert.equal(result.content, "# title\r\nbody");
  assert.equal(result.encoding, "utf-16le");
  assert.equal(result.hadBom, false);
});

test("decodes Windows GBK/GB18030 markdown instead of replacement characters", () => {
  const gbk = Buffer.from([
    0x23, 0x20,
    0xd6, 0xd0,
    0xce, 0xc4,
    0x20,
    0x4d, 0x61, 0x72, 0x6b, 0x64, 0x6f, 0x77, 0x6e,
  ]);
  const result = decodeTextBuffer(gbk);
  assert.equal(result.content, "# 中文 Markdown");
  assert.equal(result.encoding, "gb18030");
  assert.equal(result.hadBom, false);
  assert.equal(result.content.includes("�"), false);
});

test("falls back to Windows-1252 for Western ANSI text", () => {
  const result = decodeTextBuffer(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.equal(result.content, "café");
  assert.equal(result.encoding, "windows-1252");
  assert.equal(result.hadBom, false);
});
