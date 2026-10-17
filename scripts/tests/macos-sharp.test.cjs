const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { verifyMacSharp, prepareMacSharp } = require("../lib/macos-sharp.cjs");

function fixture(t, arch = "x64") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sharp-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modules = path.join(root, "node_modules");
  function json(name, value) {
    const file = path.join(modules, name, "package.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }
  const addon = `@img/sharp-darwin-${arch}`;
  const vips = `@img/sharp-libvips-darwin-${arch}`;
  json("sharp", { optionalDependencies: { [addon]: "0.33.5", [vips]: "1.0.4" } });
  json(addon, { version: "0.33.5" });
  json(vips, { version: "1.0.4" });
  const binaries = [path.join(modules, addon, `lib/sharp-darwin-${arch}.node`),
    path.join(modules, vips, "lib/libvips-cpp.42.dylib")];
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf);
  header.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  for (const file of binaries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, header);
  }
  return { root, modules, binaries, addon, vips };
}

for (const arch of ["x64", "arm64"]) {
  test(`accepts complete ${arch} runtime and rejects missing/mislabeled binaries`, t => {
    const f = fixture(t, arch);
    verifyMacSharp(f.modules, arch);
    const bytes = fs.readFileSync(f.binaries[0]);
    bytes.writeUInt32LE(arch === "x64" ? 0x0100000c : 0x01000007, 4);
    fs.writeFileSync(f.binaries[0], bytes);
    assert.throws(() => verifyMacSharp(f.modules, arch), /架构/);
    bytes.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
    fs.writeFileSync(f.binaries[0], bytes);
    fs.rmSync(f.binaries[1]);
    assert.throws(() => verifyMacSharp(f.modules, arch), /libvips-cpp/);
  });
}

test("rejects dependencies from a different sharp release", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.modules, f.addon, "package.json"), JSON.stringify({ version: "0.34.5" }));
  assert.throws(() => verifyMacSharp(f.modules, "x64"), /版本不匹配/);
});

test("arm64-only installation cannot pass the Intel packaging gate", t => {
  const f = fixture(t, "arm64");
  assert.throws(() => verifyMacSharp(f.modules, "x64"), /sharp.*darwin-x64/);
});

test("preparation installs pinned target packages in isolation and preserves other modules", t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.modules, f.addon), { recursive: true });
  const sentinel = path.join(f.modules, "better_sqlite3.node");
  fs.writeFileSync(sentinel, "existing Electron binary");
  let calls = 0;
  prepareMacSharp(f.root, "x64", (command, args, options) => {
    calls++;
    assert.ok(args.includes(`${f.addon}@0.33.5`));
    assert.ok(args.includes(`${f.vips}@1.0.4`));
    assert.ok(args.includes("--cpu=x64"));
    assert.ok(args.includes("--force"));
    assert.ok(args.includes("--ignore-scripts"));
    assert.notEqual(options.cwd, f.root);
    const installed = fixture(t);
    fs.cpSync(installed.modules, path.join(options.cwd, "node_modules"), { recursive: true });
    return { status: 0 };
  });
  assert.equal(calls, 1);
  verifyMacSharp(f.modules, "x64");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "existing Electron binary");
  prepareMacSharp(f.root, "x64", () => assert.fail("should reuse complete runtime"));
});

test("failed downloads stop preparation without overwriting existing dependencies", t => {
  const f = fixture(t);
  fs.rmSync(f.binaries[0]);
  const original = fs.readFileSync(f.binaries[1]);
  assert.throws(() => prepareMacSharp(f.root, "x64", () => ({ status: 1 })), /安装.*失败/);
  assert.deepEqual(fs.readFileSync(f.binaries[1]), original);
});

test("afterPack checks the actual app resources for both macOS architectures", t => {
  const config = require("../../electron/builder.config.js");
  const { Arch } = require("../../node_modules/builder-util");
  for (const arch of ["x64", "arm64"]) {
    const f = fixture(t, arch);
    const resources = path.join(f.root, "Nowen Note.app/Contents/Resources/backend/node_modules");
    fs.mkdirSync(path.dirname(resources), { recursive: true });
    fs.cpSync(f.modules, resources, { recursive: true });
    const context = { appOutDir: f.root, electronPlatformName: "darwin", arch: Arch[arch],
      packager: { appInfo: { productFilename: "Nowen Note" } } };
    config.afterPack(context);
    fs.rmSync(path.join(resources, f.vips), { recursive: true });
    assert.throws(() => config.afterPack(context), /sharp-libvips/);
  }
  assert.doesNotThrow(() => config.afterPack({ electronPlatformName: "win32" }));
});

test("share banner module loads without sharp; valid image processing still reports failure", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.modules, "sharp/index.js"), 'throw new Error("sharp unavailable");');
  const esbuild = require("../../backend/node_modules/esbuild");
  const entry = path.join(f.root, "banner.cjs");
  esbuild.buildSync({ entryPoints: [path.join(__dirname, "../../backend/src/lib/share-banner.ts")],
    outfile: entry, bundle: true, platform: "node", format: "cjs", external: ["sharp"] });
  execFileSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { normalizeShareBannerImage: normalize } = require(${JSON.stringify(entry)});
    (async () => {
      assert.equal(await normalize(''), '');
      await assert.rejects(normalize('https://example.com/a.png'), /横幅/);
      await assert.rejects(normalize('data:image/png;base64,iVBORw0KGgo='), /sharp unavailable/);
    })().catch(error => { console.error(error); process.exit(1); });
  `], { stdio: "pipe" });
});
