import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const file = new URL("../../.github/workflows/sync-r2-release.yml", import.meta.url);
const publishFile = new URL("../../.github/workflows/release-publish.yml", import.meta.url);

test("R2 release workflow uses explicit stable and verified publication triggers", () => {
  const workflow = yaml.load(fs.readFileSync(file, "utf8"));
  assert.deepEqual(workflow.on.release.types, ["published"]);
  assert.equal(workflow.on.workflow_call.inputs.tag.required, true);
  assert.ok(workflow.on.workflow_dispatch.inputs.tag);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.paths, [".github/workflows/sync-r2-release.yml"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.match(workflow.concurrency.group, /r2-release-/);
  const jobs = Object.values(workflow.jobs);
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 60);
  assert.match(job.if, /draft == false/);
  assert.ok(job.steps.some((step) => step.name === "Validate Cloudflare credentials"));
});

test("R2 mirrors exactly user-facing platform installers and extension ZIPs", () => {
  const workflow = yaml.load(fs.readFileSync(file, "utf8"));
  const steps = Object.values(workflow.jobs)[0].steps;
  const select = steps.find((step) => step.name === "Download exact whitelist from GitHub Release").run;
  const upload = steps.find((step) => step.name === "Upload and verify R2 objects").run;
  assert.match(select, /Nowen-Note-\$version-setup\.exe/);
  assert.match(select, /Nowen-Note-\$version-arm64\.dmg/);
  assert.match(select, /Nowen-Note-\$version-x64\.dmg/);
  assert.match(select, /Nowen-Note-\$version-x86_64\.AppImage/);
  assert.match(select, /Nowen-Note-\$version-amd64\.deb/);
  assert.match(select, /Nowen-Note-\$version\.apk/);
  assert.match(select, /nowen-note-\$version-fpk-r1\.fpk/);
  assert.match(select, /nowen-clipper-/);
  assert.match(select, /edge/);
  assert.match(select, /firefox/);
  assert.match(select, /ten unique files/);
  assert.doesNotMatch(select, /PLACEHOLDER|unused/);
  assert.match(select, /\$\{#matched\[@\]\}/);
  assert.doesNotMatch(select, /--pattern '\*'/);
  assert.doesNotMatch(select, /Nowen-Note-Lite-\$version/);
  assert.doesNotMatch(select, /Nowen-Note-\$version\.aab/);
  assert.doesNotMatch(select, /io\.nowen\.note/);
  assert.match(select, /300000000/);
  assert.match(select, /SHA256SUMS/);
  assert.match(select, /sha256sum/);
  assert.match(upload, /nowen-releases/);
  assert.match(upload, /data-binary/);
  assert.match(upload, /md5sum/);
  assert.match(upload, /R2 remote size\/ETag mismatch/);
  assert.match(upload, /download\.nowen\.cn/);
});

test("R2 workflow is invoked from formal release publisher without blocking GitHub assets", () => {
  const publication = yaml.load(fs.readFileSync(publishFile, "utf8"));
  assert.deepEqual(publication.jobs["r2-downloads"].needs, ["verify", "github"]);
  assert.equal(publication.jobs["r2-downloads"].uses, "./.github/workflows/sync-r2-release.yml");
  assert.ok(publication.jobs["r2-downloads"].with.tag.includes("inputs.version"));
  assert.equal(publication.jobs["r2-downloads"].secrets, "inherit");
  assert.equal(publication.jobs.github.environment, "release-github");
});
