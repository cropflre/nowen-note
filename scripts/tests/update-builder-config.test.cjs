const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const full = require(path.join(repoRoot, "electron", "builder.config.js"));

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
