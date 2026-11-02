const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const full = require(path.join(repoRoot, "electron", "builder.config.js"));
const lite = require(path.join(repoRoot, "electron", "builder.lite.config.js"));

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
});

test("lite updater stays on an isolated latest-lite channel", () => {
  assert.ok(Array.isArray(lite.publish));
  assert.ok(lite.publish.every((provider) => provider.channel === "latest-lite"));
  assert.equal(lite.nsis?.artifactName, "Nowen-Note-Lite-${version}-setup.${ext}");
  assert.equal(lite.portable?.artifactName, "Nowen-Note-Lite-${version}-portable.${ext}");
  assert.equal(lite.afterAllArtifactBuild, undefined);
  assert.match(
    fs.readFileSync(path.join(repoRoot, "scripts", "safe-build-legacy.mjs"), "utf8"),
    /verifyUpdateArtifactsCli\.js/,
  );
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
    for (const config of [full, lite]) {
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
