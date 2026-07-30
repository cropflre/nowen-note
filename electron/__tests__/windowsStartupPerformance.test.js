const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..", "..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("portable build favors fast extraction and provides pre-Electron feedback", () => {
  const builder = source("electron/builder.config.js");
  const splashPath = path.join(repoRoot, "build", "portable-splash.bmp");

  assert.match(builder, /useZip:\s*true/);
  assert.match(builder, /splashImage:\s*["']build\/portable-splash\.bmp["']/);
  assert.equal(fs.existsSync(splashPath), true);
  assert.equal(fs.readFileSync(splashPath).subarray(0, 2).toString("ascii"), "BM");
});

test("production backend bundle removes syntax and whitespace startup overhead", () => {
  const bundle = source("backend/build.bundle.mjs");

  assert.match(bundle, /treeShaking:\s*true/);
  assert.match(bundle, /minifySyntax:\s*true/);
  assert.match(bundle, /minifyWhitespace:\s*true/);
  assert.match(bundle, /minifyIdentifiers:\s*false/);
});
