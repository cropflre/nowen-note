const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseUpdateMetadata,
  sha512File,
  verifyLocalDirectory,
} = require("../lib/update-metadata-validator.cjs");

function createFixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-update-metadata-"));
  const version = options.version || "1.4.2";
  const assetName = options.assetName || "Nowen-Note-1.4.2-setup.exe";
  const metadataName = options.metadataName || "latest.yml";
  const assetPath = path.join(directory, assetName);
  fs.writeFileSync(assetPath, Buffer.from(options.assetContent || "installer-binary"));
  if (options.blockmap !== false) fs.writeFileSync(`${assetPath}.blockmap`, "blockmap");
  const size = options.size ?? fs.statSync(assetPath).size;
  const sha512 = options.sha512 ?? sha512File(assetPath);
  const metadata = [
    `version: ${version}`,
    "files:",
    `  - url: ${assetName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${assetName}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-07-19T00:00:00.000Z'",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(directory, metadataName), metadata);
  return { directory, assetName, metadataName };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

test("parses electron-builder files[] metadata", () => {
  const parsed = parseUpdateMetadata([
    "version: 1.4.2",
    "files:",
    "  - url: Nowen-Note-1.4.2-setup.exe",
    "    sha512: abc",
    "    size: 123",
    "path: Nowen-Note-1.4.2-setup.exe",
    "sha512: abc",
  ].join("\n"));
  assert.equal(parsed.version, "1.4.2");
  assert.deepEqual(parsed.files, [{ url: "Nowen-Note-1.4.2-setup.exe", sha512: "abc", size: 123 }]);
});

test("accepts a valid stable Windows updater asset", () => {
  const fixture = createFixture();
  try {
    const report = verifyLocalDirectory({ directory: fixture.directory, expectedVersion: "1.4.2" });
    assert.deepEqual(report.metadataFiles, ["latest.yml"]);
    assert.equal(report.assets[0].name, fixture.assetName);
  } finally {
    cleanup(fixture.directory);
  }
});

test("rejects metadata that references a missing installer", () => {
  const fixture = createFixture();
  try {
    fs.renameSync(path.join(fixture.directory, fixture.assetName), path.join(fixture.directory, "Nowen-Note-1.4.2-renamed.exe"));
    assert.throws(
      () => verifyLocalDirectory({ directory: fixture.directory, expectedVersion: "1.4.2" }),
      /referenced asset does not exist/,
    );
  } finally {
    cleanup(fixture.directory);
  }
});

test("rejects unsafe names that GitHub may normalize", () => {
  const fixture = createFixture({ assetName: "Nowen Note Setup 1.4.2.exe" });
  try {
    assert.throws(
      () => verifyLocalDirectory({ directory: fixture.directory, expectedVersion: "1.4.2" }),
      /unsafe release asset name/,
    );
  } finally {
    cleanup(fixture.directory);
  }
});

test("rejects a missing blockmap", () => {
  const fixture = createFixture({ blockmap: false });
  try {
    assert.throws(
      () => verifyLocalDirectory({ directory: fixture.directory, expectedVersion: "1.4.2" }),
      /required blockmap does not exist/,
    );
  } finally {
    cleanup(fixture.directory);
  }
});

test("rejects size and sha512 mismatches", () => {
  const fixture = createFixture({ size: 1, sha512: "invalid" });
  try {
    assert.throws(
      () => verifyLocalDirectory({ directory: fixture.directory, expectedVersion: "1.4.2" }),
      /size mismatch[\s\S]*sha512 mismatch/,
    );
  } finally {
    cleanup(fixture.directory);
  }
});

test("keeps full and lite update channels isolated", () => {
  const fixture = createFixture({ metadataName: "latest-lite.yml", assetName: "Nowen-Note-1.4.2-setup.exe" });
  try {
    assert.throws(
      () => verifyLocalDirectory({ directory: fixture.directory, expectedVersion: "1.4.2" }),
      /lite metadata references full asset/,
    );
  } finally {
    cleanup(fixture.directory);
  }
});
