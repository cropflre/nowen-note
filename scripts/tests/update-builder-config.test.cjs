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
