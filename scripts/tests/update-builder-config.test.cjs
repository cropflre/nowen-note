const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const fullConfigPath = path.join(repoRoot, "electron", "builder.config.js");
const liteConfigPath = path.join(repoRoot, "electron", "builder.lite.config.js");
const fullBasePath = path.join(repoRoot, "electron", "builder.base.config.js");
const liteBasePath = path.join(repoRoot, "electron", "builder.lite.base.config.js");

function loadConfig(configPath, basePath, env = {}) {
  const envName = "NOWEN_WINDOWS_PUBLISHER_NAME";
  const previous = process.env[envName];
  if (Object.prototype.hasOwnProperty.call(env, envName)) {
    process.env[envName] = env[envName];
  } else {
    delete process.env[envName];
  }

  delete require.cache[require.resolve(configPath)];
  delete require.cache[require.resolve(basePath)];
  try {
    return require(configPath);
  } finally {
    delete require.cache[require.resolve(configPath)];
    delete require.cache[require.resolve(basePath)];
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
}

function loadFull(env = {}) {
  return loadConfig(fullConfigPath, fullBasePath, env);
}

function loadLite(env = {}) {
  return loadConfig(liteConfigPath, liteBasePath, env);
}

const full = loadFull();
const lite = loadLite();

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

test("full updater publisher comes from the SignPath certificate environment", () => {
  assert.equal(
    loadFull({ NOWEN_WINDOWS_PUBLISHER_NAME: "SignPath Foundation" }).win.publisherName,
    "SignPath Foundation",
  );
  assert.equal(loadFull({ NOWEN_WINDOWS_PUBLISHER_NAME: "   " }).win.publisherName, undefined);
});

test("lite updater publisher comes from the SignPath certificate environment", () => {
  assert.equal(
    loadLite({ NOWEN_WINDOWS_PUBLISHER_NAME: "SignPath Foundation" }).win.publisherName,
    "SignPath Foundation",
  );
  assert.equal(loadLite({ NOWEN_WINDOWS_PUBLISHER_NAME: "   " }).win.publisherName, undefined);
});
