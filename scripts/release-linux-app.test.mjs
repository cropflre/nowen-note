import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("./release.sh", import.meta.url), "utf8");

test("release.sh exposes a linux-app target", () => {
  assert.match(source, /linux-app/);
  assert.match(source, /Linux 安装包/);
});

test("linux-app target reuses the PC Linux packaging pipeline", () => {
  assert.match(source, /linux-app\)\s+HAS_PC=1;\s+HAS_LINUX_APP=1;\s+\[ -z "\$PC_PLATFORMS" \] && PC_PLATFORMS="linux"/);
});

test("one-shot full release includes linux-app instead of a separate menu option", () => {
  assert.match(source, /TARGETS="docker,pc,linux-app,android,fpk,lite,clipper"/);
  assert.doesNotMatch(source, /11\)\s+TARGETS="linux-app"/);
});

test("release.sh performs strict authentication and final remote checks", () => {
  assert.match(source, /preflight_release_environment\(\)/);
  assert.match(source, /verify_release_remote_baseline\(\)/);
  assert.match(source, /git push --dry-run origin HEAD/);
  assert.match(source, /gh auth status/);
});
