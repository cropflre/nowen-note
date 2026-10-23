"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const text = p => fs.readFileSync(path.join(root, p), "utf8");
const full = require(path.join(root, "electron", "builder.config.js"));
const lite = require(path.join(root, "electron", "builder.lite.config.js"));

test("Direct Windows Full/Lite builds keep NSIS and portable targets", () => {
  for (const conf of [full, lite]) {
    assert.ok(conf.win.target.some(x => x.target === "nsis"));
    assert.ok(conf.win.target.some(x => x.target === "portable"));
    assert.equal(conf.win.publisherName, undefined);
  }
  assert.equal(full.nsis.artifactName, "Nowen-Note-${version}-setup.${ext}");
  assert.equal(lite.nsis.artifactName, "Nowen-Note-Lite-${version}-setup.${ext}");
  assert.equal(lite.directories.output, "dist-electron-lite");
  assert.equal(full.directories.output, "dist-electron");
});

test("Release CI does not require a third-party signing service", () => {
  const yml = text(".github/workflows/release.yml");
  const guard = text("scripts/release.sh");
  assert.doesNotMatch(yml, /signpath|SIGNPATH|NOWEN_WINDOWS_PUBLISHER_NAME/i);
  assert.doesNotMatch(guard, /signpath|SIGNPATH|NOWEN_WINDOWS_PUBLISHER_NAME/i);
  assert.match(yml, /nowen-note-win-direct/);
  assert.match(yml, /Nowen-Note-Lite-\$version-setup\.exe\.blockmap/);
  assert.match(yml, /latest-lite\.yml/);
  assert.match(yml, /--publish never/g);
  assert.match(guard, /-f mode=release-assets/);
  assert.match(guard, /gh release edit "\$TAG".*--draft=true/);
  assert.match(guard, /node "\$CI_ASSETS_SCRIPT" check/);
});

test("Deprecated signer support files are removed rather than left active", () => {
  for (const p of [
    ".signpath/artifact-configurations/windows-full.xml",
    ".signpath/artifact-configurations/windows-lite.xml",
    "scripts/check-signpath-release-config.mjs",
    "scripts/verify-windows-signatures.mjs",
    "scripts/export-windows-signatures.ps1",
  ]) assert.equal(fs.existsSync(path.join(root, p)), false, p);
  const readme = text("docs/CODE_SIGNING.md");
  assert.match(readme, /unsigned/i);
  assert.match(readme, /Microsoft Store/);
  assert.match(readme, /SmartScreen/);
});
