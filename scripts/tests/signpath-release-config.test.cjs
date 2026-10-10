const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REQUIRED_SIGNPATH_CONFIG,
  missingSignPathConfig,
  validateSignPathReleaseConfig,
} = require("../lib/signpath-release-config.cjs");

const complete = Object.fromEntries(REQUIRED_SIGNPATH_CONFIG.map((name) => [name, `${name}-value`]));

test("SignPath release config requires isolated Full and Lite Artifact Configurations", () => {
  assert.ok(REQUIRED_SIGNPATH_CONFIG.includes("SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG"));
  assert.ok(REQUIRED_SIGNPATH_CONFIG.includes("SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG"));
  assert.ok(!REQUIRED_SIGNPATH_CONFIG.includes("SIGNPATH_ARTIFACT_CONFIGURATION_SLUG"));
});

test("SignPath release config reports only missing names, never values", () => {
  const env = { ...complete, SIGNPATH_API_TOKEN: " ", SIGNPATH_PROJECT_SLUG: "" };
  assert.deepEqual(missingSignPathConfig(env), ["SIGNPATH_API_TOKEN", "SIGNPATH_PROJECT_SLUG"]);
  const result = validateSignPathReleaseConfig(env);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["SIGNPATH_API_TOKEN", "SIGNPATH_PROJECT_SLUG"]);
});

test("SignPath release config accepts all required non-blank values", () => {
  const result = validateSignPathReleaseConfig(complete);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("first production signing request does not require a guessed publisher", () => {
  assert.ok(!REQUIRED_SIGNPATH_CONFIG.includes("NOWEN_WINDOWS_PUBLISHER_NAME"));
  const result = validateSignPathReleaseConfig(complete);
  assert.equal(result.ok, true);
  assert.equal(result.publisherBootstrapRequired, true);
  assert.equal(validateSignPathReleaseConfig({ ...complete, NOWEN_WINDOWS_PUBLISHER_NAME: "Confirmed CN" }).publisherBootstrapRequired, false);
  assert.equal(validateSignPathReleaseConfig({ NOWEN_WINDOWS_PUBLISHER_NAME: "Confirmed CN" }).ok, false);
});
