const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const os = require("node:os");
const { prepareMacFfmpeg, verifyMacFfmpeg } = require("../lib/macos-ffmpeg.cjs");

function ffmpegFixture(t, arch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ffmpeg-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "node_modules/ffmpeg-static/ffmpeg");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf);
  header.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  fs.writeFileSync(binary, header);
  return { root, binary, header };
}

for (const arch of ["x64", "arm64"]) {
  test(`prepares ${arch} FFmpeg in isolation and reuses only matching binaries`, t => {
    const target = ffmpegFixture(t, arch);
    const source = ffmpegFixture(t, arch === "x64" ? "arm64" : "x64");
    assert.throws(() => verifyMacFfmpeg(source.binary, arch), /架构/);
    prepareMacFfmpeg(source.root, arch, (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.equal(args[0], path.join(path.dirname(source.binary), "install.js"));
      assert.equal(options.env.npm_config_platform, "darwin");
      assert.equal(options.env.npm_config_arch, arch);
      assert.notEqual(options.env.FFMPEG_BIN, source.binary);
      assert.deepEqual(fs.readFileSync(source.binary), source.header);
      fs.writeFileSync(options.env.FFMPEG_BIN, target.header);
      fs.writeFileSync(options.env.FFMPEG_BIN + ".LICENSE", "target license");
      return { status: 0 };
    });
    verifyMacFfmpeg(source.binary, arch);
    assert.equal(fs.readFileSync(source.binary + ".LICENSE", "utf8"), "target license");
    assert.ok(fs.statSync(source.binary).mode & 0o111);
    prepareMacFfmpeg(source.root, arch, () => assert.fail("must reuse matching binary"));
  });
}

test("failed or mismatched FFmpeg downloads preserve the installed binary", t => {
  const source = ffmpegFixture(t, "arm64");
  for (const status of [1, 0]) {
    let temporary;
    assert.throws(() => prepareMacFfmpeg(source.root, "x64", (_command, _args, options) => {
      temporary = path.dirname(options.env.FFMPEG_BIN);
      fs.writeFileSync(options.env.FFMPEG_BIN, source.header);
      return { status };
    }), /失败|架构/);
    assert.deepEqual(fs.readFileSync(source.binary), source.header);
    assert.equal(fs.existsSync(temporary), false);
  }
});

test("does not reuse a native module whose ABI differs from the Electron target", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "rebuild-native.mjs"), "utf8");

  assert.match(source, /function detectNodeAbiVersions\(/);
  assert.match(source, /existingNodeAbi\.includes\(expectedNodeAbi\)/);
});

test("removes the build-root native module that shadows the verified Release binary", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "rebuild-native.mjs"), "utf8");
  const declarationIndex = source.indexOf(
    'const shadowingNodeFile = path.join(bsBuildDir, "better_sqlite3.node");',
  );
  const cleanupIndex = source.indexOf("rimrafSync(shadowingNodeFile);");
  const reuseCheckIndex = source.indexOf("const canReuseExisting =");

  assert.notEqual(declarationIndex, -1);
  assert.notEqual(cleanupIndex, -1);
  assert.ok(cleanupIndex > declarationIndex);
  assert.ok(cleanupIndex < reuseCheckIndex);
});
