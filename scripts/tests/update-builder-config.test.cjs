const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const test = require("node:test");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const full = require(path.join(repoRoot, "electron", "builder.config.js"));
const base = require(path.join(repoRoot, "electron", "builder.base.config.js"));

test("full desktop updater uses stable no-space artifact names", () => {
  assert.equal(full.nsis?.artifactName, "Nowen-Note-${version}-setup.${ext}");
  assert.equal(full.portable?.artifactName, "Nowen-Note-${version}-portable.${ext}");
  assert.equal(full.mac?.artifactName, "Nowen-Note-${version}-${arch}.${ext}");
  assert.equal(full.linux?.artifactName, "Nowen-Note-${version}-${arch}.${ext}");
  assert.equal(full.afterAllArtifactBuild, undefined);
  assert.match(
    require(path.join(repoRoot, "package.json")).scripts["electron:build"],
    /node build\/verifyUpdateArtifactsCli\.js/,
  );
  assert.match(
    fs.readFileSync(path.join(repoRoot, "scripts", "safe-build-legacy.mjs"), "utf8"),
    /verifyUpdateArtifactsCli\.js/,
  );
});

test("Lite installers are no longer packaged or published", () => {
  for (const file of ["electron/builder.lite.config.js", "electron/builder.lite.base.config.js",
    "scripts/build-lite.mjs", "scripts/build-lite-legacy.mjs"]) {
    assert.equal(fs.existsSync(path.join(repoRoot, file)), false, file);
  }
  const scripts = require(path.join(repoRoot, "package.json")).scripts;
  assert.equal(scripts["electron:build:lite"], undefined);
  assert.equal(scripts["electron:build:lite:safe"], undefined);
  assert.equal(full.publish.some((provider) => provider.channel), false, "full stays on the default latest channel");
  for (const file of [".github/workflows/release-center-candidate.yml", ".github/workflows/release.yml",
    "scripts/release-center-stage-candidate.mjs", "scripts/release-center-formal-assets.mjs",
    "scripts/release-ci-assets.mjs", "scripts/release-github.mjs", "scripts/release-legacy.sh"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, file), "utf8"), /builder\.lite|build-lite|Nowen-Note-Lite|latest-lite/, file);
  }
});

test("macOS 11 users are not offered an incompatible Electron upgrade", async () => {
  const os = require("node:os");
  const { AppUpdater } = require("electron-updater");
  const original = os.release;
  const updater = {
    currentVersion: require("semver").parse("1.5.3"),
    isStagingMatch: async () => true,
    _logger: { info() {}, warn() {} },
  };
  try {
    for (const config of [full]) {
      assert.equal(config.mac.minimumSystemVersion, "12.0.0");
      const event = { packager: { platform: { nodeName: "darwin" }, platformSpecificBuildOptions: {
        releaseInfo: { releaseNotes: "original notes" },
      } } };
      config.artifactBuildCompleted(event);
      const info = { version: "1.5.4", ...event.packager.platformSpecificBuildOptions.releaseInfo };
      assert.equal(info.releaseNotes, "original notes");
      os.release = () => "20.6.0";
      assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(updater, info), false);
      os.release = () => "21.0.0";
      assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(updater, info), true);
      const windows = { packager: { platform: { nodeName: "win32" }, platformSpecificBuildOptions: {} } };
      config.artifactBuildCompleted(windows);
      assert.equal(windows.packager.platformSpecificBuildOptions.releaseInfo, undefined);
    }
  } finally {
    os.release = original;
  }
});

function tempDir(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("desktop packages ship the better-sqlite3 binary without its compile intermediates", (t) => {
  const { FileMatcher } = require("app-builder-lib/out/fileMatcher");
  const { filter: patterns } = full.extraResources.find((item) => item.from === "backend/node_modules");
  const source = tempDir(t, "nowen-native-filter-");
  for (const file of ["better-sqlite3/package.json", "better-sqlite3/lib/index.js",
    "better-sqlite3/build/Release/better_sqlite3.node", "better-sqlite3/build/Release/test_extension.node",
    "better-sqlite3/build/Release/better_sqlite3.pdb", "better-sqlite3/build/Release/better_sqlite3.iobj",
    "better-sqlite3/build/Release/sqlite3.lib", "better-sqlite3/build/Release/obj/gen/sqlite3/sqlite3.c",
    "better-sqlite3/build/deps/sqlite3.vcxproj", "better-sqlite3/build/Release/.electron-abi.json"]) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), "x");
  }
  const filter = new FileMatcher(source, "/out", (value) => value, patterns).createFilter();
  const included = [];
  (function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      if (!filter(file, stat)) continue;
      if (stat.isDirectory()) walk(file);
      else included.push(path.relative(source, file).split(path.sep).join("/"));
    }
  })(source);
  assert.deepEqual(included.sort(), ["better-sqlite3/build/Release/better_sqlite3.node",
    "better-sqlite3/lib/index.js", "better-sqlite3/package.json"]);
});

test("each desktop package keeps only its own platform's sharp runtime", (t) => {
  const { Arch } = require("builder-util");
  for (const [platform, kept] of [
    ["linux", ["colour", "sharp-libvips-linux-x64", "sharp-linux-x64"]],
    ["win32", ["colour", "sharp-win32-x64"]],
  ]) {
    const appOutDir = tempDir(t, "nowen-sharp-prune-");
    const scope = path.join(appOutDir, "resources/backend/node_modules/@img");
    for (const name of ["colour", "sharp-darwin-arm64", "sharp-libvips-darwin-arm64", "sharp-linux-x64",
      "sharp-libvips-linux-x64", "sharp-linuxmusl-x64", "sharp-libvips-linuxmusl-x64", "sharp-win32-x64", "sharp-wasm32"]) {
      fs.mkdirSync(path.join(scope, name), { recursive: true });
    }
    base.afterPack({ electronPlatformName: platform, arch: Arch.x64, appOutDir,
      packager: { appInfo: { productFilename: "Nowen Note" } } });
    assert.deepEqual(fs.readdirSync(scope).sort(), kept, platform);
  }
});

test("desktop packages keep every package the backend loads at runtime", (t) => {
  const { FileMatcher } = require("app-builder-lib/out/fileMatcher");
  const { filter: patterns } = full.extraResources.find((item) => item.from === "backend/node_modules");
  const bundleSource = fs.readFileSync(path.join(repoRoot, "backend", "build.bundle.mjs"), "utf8");
  const externals = [...bundleSource.match(/const external = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  // 原样复制进 backend/dist 的子进程脚本，它们 import 的包同样要从安装目录解析。
  const copiedScripts = [...bundleSource.matchAll(/copyFileSync\(\s*join\(__dirname,\s*([^)]*)\)/g)]
    .map((match) => path.join(repoRoot, "backend", ...[...match[1].matchAll(/"([^"]+)"/g)].map((part) => part[1])));
  assert.ok(copiedScripts.length >= 2, "build.bundle.mjs copies the plugin runner scripts");
  const childImports = copiedScripts.flatMap((file) =>
    [...fs.readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\(\s*)["']([^"'./][^"']*)["']/g)]
      .map((match) => match[1])
      .filter((specifier) => !specifier.startsWith("node:"))
      .map((specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]));
  // unzipper 的 S3 辅助函数里有可选的 AWS SDK require，思源导入只读本地文件，桌面端有意不带。
  const notShipped = new Set(["@aws-sdk/client-s3"]);
  const required = [...new Set([...externals, ...childImports])].filter((name) => !notShipped.has(name)).sort();
  assert.ok(required.includes("unpdf") && required.includes("quickjs-emscripten"), required.join(", "));

  const source = tempDir(t, "nowen-runtime-filter-");
  const runtimeFiles = required.flatMap((name) => [`${name}/package.json`, `${name}/dist/index.mjs`, `${name}/dist/index.cjs`]);
  for (const file of runtimeFiles) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), "x");
  }
  const filter = new FileMatcher(source, "/out", (value) => value, patterns).createFilter();
  const included = new Set();
  (function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      if (!filter(file, stat)) continue;
      if (stat.isDirectory()) walk(file);
      else included.add(path.relative(source, file).split(path.sep).join("/"));
    }
  })(source);
  assert.deepEqual(runtimeFiles.filter((file) => !included.has(file)), [], "安装包里缺这些后端运行时文件");
});
