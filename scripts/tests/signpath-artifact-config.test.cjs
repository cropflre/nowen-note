const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const configDir = path.join(repoRoot, ".signpath", "artifact-configurations");
const full = fs.readFileSync(path.join(configDir, "windows-full.xml"), "utf8");
const lite = fs.readFileSync(path.join(configDir, "windows-lite.xml"), "utf8");

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

function assertCommonContract(source) {
  assert.match(source, /<artifact-configuration xmlns="http:\/\/signpath\.io\/artifact-configuration\/v1">/);
  assert.match(source, /<parameter name="version" required="true" \/>/);
  assert.match(source, /<zip-file>/);
  assert.equal(count(source, /<pe-file\b/g), 2);
  assert.equal(count(source, /<authenticode-sign\b/g), 2);
  assert.equal(count(source, /hash-algorithm="sha256"/g), 2);
  assert.equal(count(source, /product-version="\$\{version\}"/g), 2);
  assert.doesNotMatch(source, /path="[^\"]*\*/);
  // SignPath OSS subscriptions enforce their own Authenticode watermark/description.
  // Custom description fields are rejected by the service, so keep them absent.
  assert.doesNotMatch(source, /authenticode-sign[^>]*\bdescription=/);
  assert.doesNotMatch(source, /authenticode-sign[^>]*\bdescription-url=/);
}

test("Full Artifact Configuration only signs stable setup/portable executables", () => {
  assertCommonContract(full);
  assert.match(full, /path="Nowen-Note-\$\{version\}-setup\.exe"/);
  assert.match(full, /path="Nowen-Note-\$\{version\}-portable\.exe"/);
  assert.equal(count(full, /product-name="Nowen Note"/g), 2);
});

test("Lite Artifact Configuration only signs stable Lite setup/portable executables", () => {
  assertCommonContract(lite);
  assert.match(lite, /path="Nowen-Note-Lite-\$\{version\}-setup\.exe"/);
  assert.match(lite, /path="Nowen-Note-Lite-\$\{version\}-portable\.exe"/);
  assert.equal(count(lite, /product-name="Nowen Note Lite"/g), 2);
});
