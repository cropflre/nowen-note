const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REQUIRED_SIGNPATH_CONFIG,
  missingSignPathConfig,
  validateSignPathReleaseConfig,
} = require("../lib/signpath-release-config.cjs");

const complete = Object.fromEntries(REQUIRED_SIGNPATH_CONFIG.map((name) => [name, `${name}-value`]));

test("SignPath release config reports only missing names, never values", () => {
  const env = {
    ...complete,
    SIGNPATH_API_TOKEN: " ",
    SIGNPATH_PROJECT_SLUG: "",
  };
  assert.deepEqual(missingSignPathConfig(env), ["SIGNPATH_API_TOKEN", "SIGNPATH_PROJECT_SLUG"]);
  const result = validateSignPathReleaseConfig(env);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["SIGNPATH_API_TOKEN", "SIGNPATH_PROJECT_SLUG"]);
  assert.ok(!JSON.stringify(result).includes(complete.SIGNPATH_ORGANIZATION_ID));
});

test("SignPath release config accepts all required non-blank values", () => {
  const result = validateSignPathReleaseConfig(complete);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.configured, REQUIRED_SIGNPATH_CONFIG);
});
