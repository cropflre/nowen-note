const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateLocalWindowsPublishPolicy,
} = require("../lib/local-windows-publish-policy.cjs");

function policy(overrides = {}) {
  return evaluateLocalWindowsPublishPolicy({
    targets: "docker",
    pcPlatforms: "",
    host: "Linux",
    githubRelease: true,
    ...overrides,
  });
}

test("GitHub Release disabled allows every local target", () => {
  assert.equal(policy({ targets: "all", host: "MINGW64_NT", githubRelease: false }).allowed, true);
});

test("explicit Windows PC GitHub Release is rejected", () => {
  const result = policy({ targets: "pc", pcPlatforms: "win" });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Git tag or use workflow dispatch/);
  assert.match(result.reason, /--no-github-release/);
});

test("Linux PC default infers win,linux and is rejected", () => {
  assert.equal(policy({ targets: "pc", pcPlatforms: "", host: "Linux" }).allowed, false);
});

test("macOS PC default infers mac,linux and is allowed", () => {
  assert.equal(policy({ targets: "pc", pcPlatforms: "", host: "Darwin" }).allowed, true);
});

test("linux-app and explicit Linux PC remain locally publishable", () => {
  assert.equal(policy({ targets: "linux-app", pcPlatforms: "", host: "Linux" }).allowed, true);
  assert.equal(policy({ targets: "pc", pcPlatforms: "linux", host: "Linux" }).allowed, true);
});

test("Lite is rejected on Windows host but allowed on Linux and macOS", () => {
  assert.equal(policy({ targets: "lite", host: "MINGW64_NT-10.0" }).allowed, false);
  assert.equal(policy({ targets: "lite", host: "Linux" }).allowed, true);
  assert.equal(policy({ targets: "lite", host: "Darwin" }).allowed, true);
});

test("all is rejected whenever its inferred PC or Lite target includes Windows", () => {
  assert.equal(policy({ targets: "all", host: "Linux", pcPlatforms: "" }).allowed, false);
  assert.equal(policy({ targets: "all", host: "MINGW64_NT", pcPlatforms: "" }).allowed, false);
  assert.equal(policy({ targets: "all", host: "Darwin", pcPlatforms: "" }).allowed, true);
});
