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

test("packaged backend retains fast-deep-equal for bonjour-service and scales startup timeout for large DBs", () => {
  const baseConfig = source("electron/builder.base.config.js");
  assert.match(baseConfig, /"bonjour-service"/);
  assert.match(baseConfig, /"fast-deep-equal"/);

  const mainSource = source("electron/main.js").replace(/\r\n/g, "\n");
  const start = mainSource.indexOf("function resolveBackendStartupTimeoutMs(dbPath)");
  const end = mainSource.indexOf("\nfunction waitForBackendReady(", start);
  assert.ok(start >= 0 && end > start, "main.js should define resolveBackendStartupTimeoutMs");

  const vm = require("node:vm");
  const runWithSize = (sizeBytes) => {
    const ctx = {
      fs: {
        existsSync: () => sizeBytes !== null,
        statSync: () => ({ size: sizeBytes }),
      },
    };
    vm.createContext(ctx);
    return vm.runInContext(`${mainSource.slice(start, end)}\nresolveBackendStartupTimeoutMs("/tmp/nowen.db")`, ctx);
  };
  assert.equal(runWithSize(null), 90000);
  assert.equal(runWithSize(10 * 1024 * 1024), 90000);
  assert.equal(runWithSize(150 * 1024 * 1024), 120000);
  assert.equal(runWithSize(1180 * 1024 * 1024), 180000);
});
