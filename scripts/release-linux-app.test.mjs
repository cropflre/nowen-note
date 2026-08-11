import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const wrapperSource = readFileSync(new URL("./release.sh", import.meta.url), "utf8");
const legacySource = readFileSync(new URL("./release-legacy.sh", import.meta.url), "utf8");

test("release.sh exposes a linux-app target", () => {
  assert.match(legacySource, /linux-app/);
  assert.match(legacySource, /Linux 安装包/);
});

test("linux-app target reuses the PC Linux packaging pipeline", () => {
  assert.match(legacySource, /linux-app\)\s+HAS_PC=1;\s+HAS_LINUX_APP=1;\s+\[ -z "\$PC_PLATFORMS" \] && PC_PLATFORMS="linux"/);
});

test("one-shot full release includes linux-app instead of a separate menu option", () => {
  assert.match(legacySource, /TARGETS="docker,pc,linux-app,android,fpk,lite,clipper"/);
  assert.doesNotMatch(legacySource, /11\)\s+TARGETS="linux-app"/);
});

test("release.sh performs strict authentication and final remote checks", () => {
  assert.match(legacySource, /preflight_release_environment\(\)/);
  assert.match(legacySource, /verify_release_remote_baseline\(\)/);
  assert.match(legacySource, /git push --dry-run origin HEAD/);
  assert.match(legacySource, /gh auth status/);
  assert.match(wrapperSource, /LEGACY_ARGS\+=\("--draft"\)/);
  assert.match(wrapperSource, /verify-release-update-assets\.mjs/);
  assert.match(wrapperSource, /remote --repo/);
});

test("legacy Windows release guard skips dry-run and build-only flows", () => {
  assert.match(
    legacySource,
    /if \[ "\$DO_GITHUB_RELEASE" = "1" \] && \[ "\$DRY_RUN" != "1" \] && \[ "\$BUILD_ONLY" != "1" \]; then/,
  );
  assert.match(legacySource, /check-local-windows-publish-policy\.mjs/);
  assert.doesNotMatch(wrapperSource, /check-local-windows-publish-policy\.mjs/);
});
