import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createZip, readZip } from "../hot-update/lib/zip.mjs";

const entries = [
  { path: "index.html", data: Buffer.from("<!doctype html><title>Nowen</title>") },
  { path: "assets/app-1a2b3c.js", data: Buffer.from("console.log('hot');\n".repeat(200)) },
  { path: "assets/empty.txt", data: Buffer.alloc(0) },
  { path: "assets/图标.svg", data: Buffer.from("<svg/>") },
];

test("同一输入不论顺序如何，打出来的 zip 字节完全相同", () => {
  const first = createZip(entries);
  const second = createZip([...entries].reverse());
  assert.ok(first.equals(second));
});

test("读回的条目与写入内容一致，且按路径排序", () => {
  const read = readZip(createZip(entries));
  const expected = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.deepEqual(read.map((entry) => entry.path), expected.map((entry) => entry.path));
  for (const [index, entry] of read.entries()) assert.ok(entry.data.equals(expected[index].data), entry.path);
});

test("系统 unzip 能完整校验并解出内容", (t) => {
  if (spawnSync("unzip", ["-v"], { stdio: "ignore" }).status !== 0) return t.skip("本机没有 unzip");
  const dir = mkdtempSync(path.join(os.tmpdir(), "nowen-hot-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "bundle.zip");
  writeFileSync(file, createZip(entries));
  const check = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /No errors detected/);
  const content = spawnSync("unzip", ["-p", file, "assets/app-1a2b3c.js"]);
  assert.ok(content.stdout.equals(entries[1].data));
});

test("内容被篡改、结尾有多余数据时拒绝读取", () => {
  const zip = createZip(entries);
  // 翻转第一个条目压缩数据里的一个字节（本地头 30 字节 + 文件名之后）。
  const tampered = Buffer.from(zip);
  tampered[30 + zip.readUInt16LE(26) + 5] ^= 0xff;
  assert.throws(() => readZip(tampered));
  const renamed = Buffer.from(zip);
  renamed[31] ^= 0x01;
  assert.throws(() => readZip(renamed), /不一致/);
  assert.throws(() => readZip(Buffer.concat([zip, Buffer.from("trailing")])));
  assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")));
});

test("拒绝不安全或重复的条目路径", () => {
  for (const bad of ["../escape.js", "/abs.js", "a\\b.js", "a//b.js", "./a.js", "C:evil.js", "dir/", "a\u0000b"]) {
    assert.throws(() => createZip([{ path: bad, data: Buffer.from("x") }]), bad);
  }
  assert.throws(() => createZip([{ path: "a.js", data: Buffer.from("1") }, { path: "a.js", data: Buffer.from("2") }]));
});
