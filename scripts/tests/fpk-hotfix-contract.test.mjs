import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));

test("FPK manifest derives its version and release notes without stale literals", () => {
  const m = read("scripts/fpk/template/manifest");
  const builder = read("scripts/fpk/build-fpk.mjs");
  assert.match(m, /version\s+= {{VERSION}}/);
  assert.match(m, /Nowen Note.*v{{VERSION}}/);
  assert.match(m, /{{UPDATE_NOTES}}/);
  assert.doesNotMatch(m, /Nowen Note v1\.5\.4/);
  assert.match(builder, /UPDATE_NOTES: RELEASE_NOTES/);
  assert.match(builder, /FPK_IMAGE_TAG/);
  assert.match(read("scripts/fpk/template/app/docker/docker-compose.yaml"), /image:\s+{{DOCKERHUB_REPO}}:{{IMAGE_TAG}}/);
  assert.match(read("scripts/fpk/template/app/docker/docker-compose.yaml"), /\/app\/data/);
});

test("Docker build packages the curated in-app changelog, not old embedded git commits", () => {
  const docker = read("Dockerfile");
  const ignore = read(".dockerignore");
  assert.match(docker, /COPY scripts\/generate-changelog\.mjs scripts\/verify-in-app-changelog\.mjs \/app\/scripts\//);
  assert.match(docker, /COPY docs\/releases\/in-app-changelog\.json \/app\/docs\/releases\/in-app-changelog\.json/);
  assert.match(docker, /COPY CHANGELOG\.md \/app\/CHANGELOG\.md/);
  assert.match(ignore, /!docs\/releases\/in-app-changelog\.json/);
  assert.match(ignore, /!CHANGELOG\.md/);
  const data = JSON.parse(read("frontend/public/changelog.json"));
  if (pkg.version === "1.5.5") {
    assert.deepEqual(data.entries.slice(0,3).map(e=>e.version), ["1.5.5", "1.5.4", "1.5.3"]);
    assert.ok(data.entries[0].body.includes("双向同步"));
  } else assert.equal(data.entries[0].version, pkg.version);
});
