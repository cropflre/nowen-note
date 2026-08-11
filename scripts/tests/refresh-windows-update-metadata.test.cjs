const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const {
  refreshWindowsUpdateMetadata,
  rewriteIntegrityFields,
} = require("../lib/refresh-windows-update-metadata.cjs");
const {
  parseUpdateMetadata,
  sha512File,
  validateLocalMetadataFiles,
} = require("../lib/update-metadata-validator.cjs");

const VERSION = "1.4.4";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowen-windows-update-"));
}

function setupName(channel, version = VERSION) {
  return channel === "lite"
    ? `Nowen-Note-Lite-${version}-setup.exe`
    : `Nowen-Note-${version}-setup.exe`;
}

function metadataName(channel) {
  return channel === "lite" ? "latest-lite.yml" : "latest.yml";
}

function createFixture(channel = "full", options = {}) {
  const dir = makeTempDir();
  const version = options.version || VERSION;
  const exeName = options.exeName || setupName(channel, version);
  const exePath = path.join(dir, exeName);
  fs.writeFileSync(exePath, Buffer.from("MZ-nowen-before-signing-fixture"));
  const oldSha512 = sha512File(exePath);
  const oldSize = fs.statSync(exePath).size;
  const metadataPath = path.join(dir, metadataName(channel));
  const releaseDate = "2026-07-30T08:09:10.000Z";
  const source = [
    `version: ${version}`,
    "files:",
    `  - url: ${options.fileUrl || exeName}`,
    `    sha512: ${oldSha512}`,
    `    size: ${oldSize}`,
    `path: ${options.topPath || exeName}`,
    `sha512: ${oldSha512}`,
    `releaseDate: '${releaseDate}'`,
    "customField: keep-me",
    "",
  ].join("\n");
  fs.writeFileSync(metadataPath, source, "utf8");
  fs.writeFileSync(`${exePath}.blockmap`, "old-blockmap", "utf8");
  return { dir, exeName, exePath, metadataPath, oldSha512, oldSize, source, releaseDate };
}

for (const channel of ["full", "lite"]) {
  test(`${channel} metadata refresh follows signed executable bytes`, () => {
    const fixture = createFixture(channel);
    try {
      validateLocalMetadataFiles({
        metadataPaths: [fixture.metadataPath],
        assetDir: fixture.dir,
        expectedVersion: VERSION,
      });

      fs.appendFileSync(fixture.exePath, Buffer.from("-authenticode-signature-bytes"));
      assert.throws(
        () => validateLocalMetadataFiles({
          metadataPaths: [fixture.metadataPath],
          assetDir: fixture.dir,
          expectedVersion: VERSION,
        }),
        /(?:size mismatch|sha512 mismatch)/,
      );

      const result = refreshWindowsUpdateMetadata({
        metadataPath: fixture.metadataPath,
        assetDir: fixture.dir,
        channel,
        expectedVersion: VERSION,
      });
      const updatedSource = fs.readFileSync(fixture.metadataPath, "utf8");
      const updated = parseUpdateMetadata(updatedSource, metadataName(channel));
      const expectedSha = sha512File(fixture.exePath);
      const expectedSize = fs.statSync(fixture.exePath).size;

      assert.equal(updated.sha512, expectedSha);
      assert.equal(updated.files[0].sha512, expectedSha);
      assert.equal(updated.files[0].size, expectedSize);
      assert.equal(result.sha512, expectedSha);
      assert.equal(result.size, expectedSize);
      assert.match(updatedSource, new RegExp(`releaseDate: '${fixture.releaseDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
      assert.match(updatedSource, /customField: keep-me/);

      const blockmap = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${fixture.exePath}.blockmap`)).toString("utf8"));
      assert.ok(Array.isArray(blockmap.files));
      assert.ok(blockmap.files.length > 0);

      validateLocalMetadataFiles({
        metadataPaths: [fixture.metadataPath],
        assetDir: fixture.dir,
        expectedVersion: VERSION,
      });
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
}

test("full and lite channels reject cross-channel updater names", () => {
  const full = createFixture("full", { exeName: setupName("lite") });
  const lite = createFixture("lite", { exeName: setupName("full") });
  try {
    assert.throws(
      () => refreshWindowsUpdateMetadata({
        metadataPath: full.metadataPath,
        assetDir: full.dir,
        channel: "full",
        expectedVersion: VERSION,
      }),
      /must reference exactly Nowen-Note-1\.4\.4-setup\.exe/,
    );
    assert.throws(
      () => refreshWindowsUpdateMetadata({
        metadataPath: lite.metadataPath,
        assetDir: lite.dir,
        channel: "lite",
        expectedVersion: VERSION,
      }),
      /must reference exactly Nowen-Note-Lite-1\.4\.4-setup\.exe/,
    );
  } finally {
    fs.rmSync(full.dir, { recursive: true, force: true });
    fs.rmSync(lite.dir, { recursive: true, force: true });
  }
});

test("metadata refresh rejects missing, multiple, and wrong-version setup candidates", () => {
  const missing = createFixture("full");
  const multiple = createFixture("full");
  const wrongVersion = createFixture("full");
  try {
    fs.unlinkSync(missing.exePath);
    assert.throws(
      () => refreshWindowsUpdateMetadata({
        metadataPath: missing.metadataPath,
        assetDir: missing.dir,
        channel: "full",
        expectedVersion: VERSION,
      }),
      /requires exactly one setup candidate/,
    );

    fs.writeFileSync(path.join(multiple.dir, "Nowen-Note-9.9.9-setup.exe"), "MZ-extra");
    assert.throws(
      () => refreshWindowsUpdateMetadata({
        metadataPath: multiple.metadataPath,
        assetDir: multiple.dir,
        channel: "full",
        expectedVersion: VERSION,
      }),
      /requires exactly one setup candidate/,
    );

    assert.throws(
      () => refreshWindowsUpdateMetadata({
        metadataPath: wrongVersion.metadataPath,
        assetDir: wrongVersion.dir,
        channel: "full",
        expectedVersion: "1.4.5",
      }),
      /does not match 1\.4\.5/,
    );
  } finally {
    fs.rmSync(missing.dir, { recursive: true, force: true });
    fs.rmSync(multiple.dir, { recursive: true, force: true });
    fs.rmSync(wrongVersion.dir, { recursive: true, force: true });
  }
});

test("rewriteIntegrityFields fails closed on ambiguous YAML fields", () => {
  const sha = "old-sha";
  assert.throws(
    () => rewriteIntegrityFields(
      `sha512: ${sha}\nfiles:\n  - url: app.exe\n    sha512: ${sha}\n    sha512: ${sha}\n    size: 10\n`,
      { oldSha512: sha, newSha512: "new-sha", oldSize: 10, newSize: 11 },
    ),
    /exactly 2 sha512 fields/,
  );
  assert.throws(
    () => rewriteIntegrityFields(
      `sha512: ${sha}\nfiles:\n  - url: app.exe\n    sha512: ${sha}\n    size: 10\n    size: 10\n`,
      { oldSha512: sha, newSha512: "new-sha", oldSize: 10, newSize: 11 },
    ),
    /exactly 1 indented size field/,
  );
});
