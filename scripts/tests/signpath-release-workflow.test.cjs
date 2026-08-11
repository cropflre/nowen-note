const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "release.yml");
const source = fs.readFileSync(workflowPath, "utf8");

function builderCommandLines() {
  return source.split(/\r?\n/).filter((line) => line.includes("electron-builder"));
}

test("release workflow never lets electron-builder publish directly", () => {
  const lines = builderCommandLines();
  assert.ok(lines.length >= 4);
  for (const line of lines) assert.match(line, /--publish never/);
  assert.doesNotMatch(source, /--publish always/);
});

test("Windows builds Full and Lite into isolated updater channels", () => {
  assert.match(source, /--config electron\/builder\.config\.js --win --publish never/);
  assert.match(source, /--config electron\/builder\.lite\.config\.js --win --publish never/);
  assert.match(source, /dist-electron\/\*\.exe/);
  assert.match(source, /dist-electron-lite\/\*\.exe/);
  assert.match(source, /NOWEN_WINDOWS_PUBLISHER_NAME: \$\{\{ vars\.NOWEN_WINDOWS_PUBLISHER_NAME \}\}/);
});

test("SignPath receives GitHub artifact IDs and explicit release configuration", () => {
  assert.match(source, /id: upload_full_unsigned[\s\S]*uses: actions\/upload-artifact@v4/);
  assert.match(source, /id: upload_lite_unsigned[\s\S]*uses: actions\/upload-artifact@v4/);
  assert.match(source, /uses: signpath\/github-action-submit-signing-request@v2/g);
  assert.match(source, /github-artifact-id: \$\{\{ steps\.upload_full_unsigned\.outputs\.artifact-id \}\}/);
  assert.match(source, /github-artifact-id: \$\{\{ steps\.upload_lite_unsigned\.outputs\.artifact-id \}\}/);
  for (const name of [
    "api-token",
    "organization-id",
    "project-slug",
    "signing-policy-slug",
    "artifact-configuration-slug",
  ]) {
    assert.match(source, new RegExp(`${name}:`));
  }
  assert.match(source, /wait-for-completion: true/);
  assert.equal((source.match(/wait-for-completion-timeout-in-seconds: 10800/g) || []).length, 2);
  assert.match(source, /output-artifact-directory: signed-windows\/full/);
  assert.match(source, /output-artifact-directory: signed-windows\/lite/);
});

test("Full and Lite use separate restricted Artifact Configurations with the package version", () => {
  assert.match(source, /id: package_version/);
  assert.match(source, /SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG: \$\{\{ vars\.SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG \}\}/);
  assert.match(source, /SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG: \$\{\{ vars\.SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG \}\}/);
  assert.match(source, /artifact-configuration-slug: \$\{\{ vars\.SIGNPATH_FULL_ARTIFACT_CONFIGURATION_SLUG \}\}/);
  assert.match(source, /artifact-configuration-slug: \$\{\{ vars\.SIGNPATH_LITE_ARTIFACT_CONFIGURATION_SLUG \}\}/);
  assert.equal(
    (source.match(/version: \$\{\{ toJSON\(steps\.package_version\.outputs\.version\) \}\}/g) || []).length,
    2,
  );
  assert.doesNotMatch(source, /vars\.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG/);
});

test("signed Windows assets are verified and metadata is rebuilt before formal upload", () => {
  const verifyIndex = source.indexOf("verify-windows-signatures.mjs");
  const refreshIndex = source.indexOf("refresh-windows-update-metadata.mjs");
  const localVerifyIndex = source.indexOf("verify-release-update-assets.mjs local");
  const signedUploadIndex = source.indexOf("name: nowen-note-win-signed");
  assert.ok(verifyIndex >= 0);
  assert.ok(refreshIndex > verifyIndex);
  assert.ok(localVerifyIndex > refreshIndex);
  assert.ok(signedUploadIndex > localVerifyIndex);
});

test("publish job exposes the Code signing policy before uploading formal assets", () => {
  const publishStart = source.indexOf("\n  publish:");
  assert.ok(publishStart >= 0);
  const publishSource = source.slice(publishStart);
  const policyIndex = publishSource.indexOf("Ensure Release code signing policy");
  const uploadIndex = publishSource.indexOf("Upload allowlisted Release assets");
  assert.ok(policyIndex >= 0);
  assert.ok(uploadIndex > policyIndex);
  assert.match(publishSource, /## Code signing policy/);
  assert.match(publishSource, /Free code signing provided by SignPath\.io, certificate by SignPath Foundation\./);
  assert.match(publishSource, /docs\/CODE_SIGNING\.md/);
  assert.match(publishSource, /docs\/PRIVACY\.md/);
});

test("publish job downloads only formal artifacts and publishes after remote verification", () => {
  assert.match(source, /^  publish:\n[\s\S]*?needs: build/m);
  assert.match(source, /name: nowen-note-win-signed/);
  assert.match(source, /name: nowen-note-mac/);
  assert.match(source, /name: nowen-note-linux/);

  const publishStart = source.indexOf("\n  publish:");
  assert.ok(publishStart >= 0);
  const publishSource = source.slice(publishStart);
  assert.doesNotMatch(publishSource, /download-artifact@[\s\S]{0,200}name: [^\n]*unsigned/);
  assert.match(source, /nowen-note-win-unsigned/);

  const remoteIndex = publishSource.indexOf("verify-release-update-assets.mjs remote");
  const publicIndex = publishSource.indexOf('gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false');
  assert.ok(remoteIndex >= 0);
  assert.ok(publicIndex > remoteIndex);
});
