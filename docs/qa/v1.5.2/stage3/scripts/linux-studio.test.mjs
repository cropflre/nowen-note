import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PluginStudioProjectPaths } from "../evidence/linux/projectPaths.mjs";

test("Linux actual filesystem rejects traversal, symlinks, hardlinks and check/open swaps", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-qa152-studio-"));
  try {
    const paths = new PluginStudioProjectPaths(path.join(root, "projects"));
    const id = randomUUID();
    const project = paths.createProjectDirectory(id);
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, '{"fixtureSecret":"outside"}');
    fs.writeFileSync(path.join(project, "safe.json"), "{}");
    assert.equal(paths.readFileBuffer(id, "safe.json").toString(), "{}");
    assert.equal(fs.statSync(project).mode & 0o777, 0o700);
    assert.throws(() => paths.resolveFile(id, "../outside.json"), (e) => e.code === "PLUGIN_STUDIO_PATH_TRAVERSAL");
    assert.throws(() => paths.resolveFile(id, ".env", true), (e) => e.code === "PLUGIN_STUDIO_FILE_TYPE_NOT_ALLOWED");
    fs.symlinkSync(outside, path.join(project, "symlink.json"));
    assert.throws(() => paths.readFileBuffer(id, "symlink.json"), (e) => e.code === "PLUGIN_STUDIO_SYMLINK_REJECTED");
    fs.linkSync(outside, path.join(project, "hard.json"));
    assert.throws(() => paths.readFileBuffer(id, "hard.json"), (e) => e.code === "PLUGIN_STUDIO_HARDLINK_REJECTED");
    const outsideDir = path.join(root, "outside-dir");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "secret.json"), "outside");
    fs.symlinkSync(outsideDir, path.join(project, "directory"), "dir");
    assert.throws(() => paths.readFileBuffer(id, "directory/secret.json"), (e) => e.code === "PLUGIN_STUDIO_SYMLINK_REJECTED");
    const race = path.join(project, "race.json");
    fs.writeFileSync(race, "{}");
    const open = fs.openSync;
    let swapped = false;
    context.mock.method(fs, "openSync", (file, ...args) => {
      if (file === race && !swapped) {
        swapped = true;
        fs.unlinkSync(race);
        fs.symlinkSync(outside, race);
      }
      return open(file, ...args);
    });
    assert.throws(() => paths.readFileBuffer(id, "race.json"),
      (e) => ["PLUGIN_STUDIO_FILE_CHANGED", "PLUGIN_STUDIO_SYMLINK_REJECTED"].includes(e.code));
    assert.equal(swapped, true);
  } finally {
    context.mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
