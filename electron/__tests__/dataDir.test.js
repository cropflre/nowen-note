const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FIRST_RUN_DATA_MARKERS,
  getDefaultDataPath,
  getDataDirPointerPath,
  getUserDataPathFromRoot,
  shouldPromptDataDirOnFirstRun,
  writeCustomDataDir,
  validateMigrationTarget,
} = require("../dataDir");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowen-data-dir-"));
}

test("uses the default nowen-data directory when no pointer exists", () => {
  const root = tempRoot();

  assert.equal(getUserDataPathFromRoot(root), path.join(root, "nowen-data"));
});

test("reads a valid custom data directory from the bootstrap pointer", () => {
  const root = tempRoot();
  const custom = path.join(root, "custom data");
  fs.mkdirSync(custom, { recursive: true });

  writeCustomDataDir(root, custom);

  assert.equal(getDataDirPointerPath(root), path.join(root, "nowen-data-location.json"));
  assert.equal(getUserDataPathFromRoot(root), custom);
});

test("ignores a custom data directory under Program Files", () => {
  const root = tempRoot();
  const programFiles = path.join(root, "Program Files");
  const custom = path.join(programFiles, "Nowen Note");
  fs.mkdirSync(custom, { recursive: true });
  writeCustomDataDir(root, custom);

  const originalProgramFiles = process.env.ProgramFiles;
  process.env.ProgramFiles = programFiles;
  try {
    assert.equal(getUserDataPathFromRoot(root), getDefaultDataPath(root));
  } finally {
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = originalProgramFiles;
  }
});

test("rejects unsafe migration targets", () => {
  const root = tempRoot();
  const currentDir = getDefaultDataPath(root);
  const childDir = path.join(currentDir, "nested");
  const nonEmptyDir = path.join(root, "non-empty");
  const rootDir = path.parse(root).root;
  fs.mkdirSync(nonEmptyDir, { recursive: true });
  fs.writeFileSync(path.join(nonEmptyDir, "other.txt"), "x", "utf8");

  assert.equal(validateMigrationTarget("relative-dir", { currentDir }).ok, false);
  assert.equal(validateMigrationTarget(childDir, { currentDir }).ok, false);
  assert.equal(validateMigrationTarget(rootDir, { currentDir }).ok, false);
  assert.equal(validateMigrationTarget(nonEmptyDir, { currentDir }).ok, false);

  const originalProgramFiles = process.env.ProgramFiles;
  process.env.ProgramFiles = path.join(root, "Program Files");
  try {
    const programFilesTarget = path.join(process.env.ProgramFiles, "Nowen Note");
    assert.equal(validateMigrationTarget(programFilesTarget, { currentDir }).ok, false);
  } finally {
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = originalProgramFiles;
  }
});

test("prompts for data directory on full first run without existing data", () => {
  const root = tempRoot();

  assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "full", liteOnly: false }), true);
});

test("does not prompt when a custom pointer already exists", () => {
  const root = tempRoot();
  const custom = path.join(root, "custom data");
  fs.mkdirSync(custom, { recursive: true });
  writeCustomDataDir(root, custom);

  assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "full", liteOnly: false }), false);
});

test("does not prompt when default data directory contains existing user data", () => {
  for (const marker of FIRST_RUN_DATA_MARKERS) {
    const root = tempRoot();
    const defaultDir = getDefaultDataPath(root);
    fs.mkdirSync(defaultDir, { recursive: true });
    const markerPath = path.join(defaultDir, marker);
    if (marker === "attachments") {
      fs.mkdirSync(markerPath, { recursive: true });
    } else {
      fs.writeFileSync(markerPath, "x", "utf8");
    }

    assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "full", liteOnly: false }), false);
  }
});

test("does not prompt in lite mode or lite-only builds", () => {
  const root = tempRoot();

  assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "lite", liteOnly: false }), false);
  assert.equal(shouldPromptDataDirOnFirstRun(root, { mode: "full", liteOnly: true }), false);
});
