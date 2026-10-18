const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");

test("settings banner module can load and clear an image when sharp is unavailable", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'sharp' || /[\\\\/]sharp[\\\\/]lib[\\\\/]index.js$/.test(id)) throw new Error('sharp unavailable');
      return original.call(this, id, ...args);
    };
    (async () => {
      const { normalizeShareBannerImage } = require('./src/lib/share-banner.ts');
      assert.equal(await normalizeShareBannerImage(''), '');
      await assert.rejects(normalizeShareBannerImage(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
      ), /sharp unavailable/);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.join(root, "backend"), encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test("desktop validation rejects Linux-only sharp dependencies for a Windows target", () => {
  const { verifySharpRuntime } = require("../lib/sharp-runtime.cjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sharp-runtime-"));
  try {
    const modules = path.join(directory, "node_modules");
    fs.mkdirSync(path.join(modules, "sharp"), { recursive: true });
    fs.writeFileSync(path.join(modules, "sharp/package.json"), JSON.stringify({
      name: "sharp", version: "0.33.5", main: "index.js",
      optionalDependencies: { "@img/sharp-win32-x64": "0.33.5" },
    }));
    fs.mkdirSync(path.join(modules, "@img/sharp-linux-x64"), { recursive: true });
    assert.throws(() => verifySharpRuntime(directory, { platform: "win32", arch: "x64" }),
      /sharp-win32-x64/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source and copied desktop resources both validate and process an image", async () => {
  const config = require("../../electron/builder.config.js");
  assert.equal(typeof config.beforePack, "function");
  assert.equal(typeof config.afterPack, "function");
  const arch = require("builder-util").Arch[process.arch];
  await config.beforePack({ electronPlatformName: process.platform, arch });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sharp-package-"));
  try {
    const resources = process.platform === "darwin"
      ? path.join(directory, "Nowen Note.app/Contents/Resources")
      : path.join(directory, "resources");
    // A filtered package that omits @img must fail before an installer is produced.
    const missingApp = path.join(directory, "missing");
    const missingResources = process.platform === "darwin"
      ? path.join(missingApp, "Nowen Note.app/Contents/Resources")
      : path.join(missingApp, "resources");
    fs.mkdirSync(path.join(missingResources, "backend/node_modules"), { recursive: true });
    fs.cpSync(path.join(root, "backend/node_modules/sharp"),
      path.join(missingResources, "backend/node_modules/sharp"), { recursive: true });
    const context = {
      electronPlatformName: process.platform, arch, appOutDir: directory,
      packager: { appInfo: { productFilename: "Nowen Note" } },
    };
    await assert.rejects(config.afterPack({ ...context, appOutDir: missingApp }), /@img\/sharp/);
    const filter = config.extraResources.find(entry => entry.to === "backend/node_modules").filter;
    const { minimatch } = require("minimatch");
    for (const entry of ["sharp", "@img", "color", "color-string", "color-name", "color-convert", "simple-swizzle", "is-arrayish", "detect-libc", "semver"]) {
      if (!filter.includes(`${entry}/**/*`)) continue;
      fs.cpSync(path.join(root, "backend/node_modules", entry),
        path.join(resources, "backend/node_modules", entry), {
          recursive: true,
          filter: file => {
            const relative = path.relative(path.toNamespacedPath(path.join(root, "backend/node_modules")),
              path.toNamespacedPath(file)).replaceAll("\\", "/");
            if (fs.statSync(file).isDirectory()) return true;
            return filter.reduce((keep, rule) => rule.startsWith("!")
              ? keep && !minimatch(relative, rule.slice(1), { dot: true })
              : keep || minimatch(relative, rule, { dot: true }), false);
          },
        });
    }
    await config.afterPack(context);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
