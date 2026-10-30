import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = path => readFile(resolve(root, path), 'utf8');
const json = async path => JSON.parse(await read(path));

test('v1.5.4 root and backend package/lock versions are identical', async () => {
  for (const prefix of ['', 'backend/']) {
    const pkg = await json(prefix + 'package.json');
    const lock = await json(prefix + 'package-lock.json');
    assert.equal(pkg.version, '1.5.4', prefix + 'package.json');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.deepEqual(lock.packages[''].engines, pkg.engines);
  }
});

test('Android identity and versionCode advance beyond released v1.5.3', async () => {
  const gradle = await read('frontend/android/app/build.gradle');
  assert.match(gradle, /applicationId\s+"com\.nowen\.note"/);
  assert.equal(gradle.match(/versionName\s+"([^"]+)"/)?.[1], '1.5.4');
  const code = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(code) && code > 10509, 'must exceed published v1.5.3 code 10509');
});

test('source Xcode build configurations carry v1.5.4 defaults', async () => {
  const project = await read('frontend/ios/App/App.xcodeproj/project.pbxproj');
  const versions = [...project.matchAll(/MARKETING_VERSION = ([0-9.]+);/g)].map(match => match[1]);
  assert.ok(versions.length >= 2);
  assert.ok(versions.every(value => value === '1.5.4'));
  const codes = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\\d+);/g)].map(match => Number(match[1]));
  assert.equal(codes.length, versions.length);
  assert.ok(codes.every(value => value >= 10510));
});

test('Node 24 is used by the canonical GitHub-hosted build and publishing workflows', async () => {
  assert.equal((await read('.nvmrc')).trim(), '24.22.1');
  for (const path of ['.github/workflows/release-build.yml', '.github/workflows/release-publish.yml']) {
    const workflow = await read(path);
    assert.match(workflow, /node-version:\s*['"]24\.22\.1['"]/);
    assert.match(workflow, /workflow_dispatch:/);
  }
});

test('only the unified workflow can publish; legacy routes are fail-closed', async () => {
  const publisher = await read('.github/workflows/publish.yml');
  assert.match(publisher, /Legacy Publish Disabled/);
  assert.match(publisher, /exit 1/);
  assert.doesNotMatch(publisher, /docker\/login-action|release-github\.mjs publish|contents:\s*write/);
  const legacyBuild = await read('.github/workflows/release.yml');
  assert.match(legacyBuild, /NOWEN_LEGACY_RELEASE_ASSETS_ENABLED == '1'/);
  assert.match(legacyBuild, /--publish never/);
  const cloudPublish = await read('.github/workflows/release-publish.yml');
  assert.match(cloudPublish, /release-cloud-ci\.mjs verify/);
  assert.match(cloudPublish, /environment: release-github/);
  assert.match(cloudPublish, /environment: release-docker/);
});

test('FPK manifest uses fnpack-compatible quoted HTML and release version placeholder', async () => {
  const manifest = await read('scripts/fpk/template/manifest');
  assert.match(manifest, /^version\s*=\s*\{\{VERSION\}\}$/m);
  const description = manifest.split(/\r?\n/).find(line => /^desc\s*=/.test(line));
  assert.ok(description, 'FPK description required');
  assert.match(description, /^desc\s*=\s*`.*`$/);
  assert.match(description, /v1\.5\.4/);
  assert.doesNotMatch(description, /v1\.5\.[23]/);
});

test('independently versioned frontend workspace remains unchanged', async () => {
  const frontend = await json('frontend/package.json');
  assert.equal(frontend.version, '0.0.0');
});
