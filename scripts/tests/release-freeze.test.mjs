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
  const codes = [...project.matchAll(/CURRENT_PROJECT_VERSION = ([0-9]+);/g)].map(match => Number(match[1]));
  assert.equal(codes.length, versions.length);
  assert.ok(codes.every(value => value >= 10510));
  const workflow = await read('.github/workflows/ios-release.yml');
  assert.match(workflow, /CURRENT_PROJECT_VERSION/);
  assert.equal(workflow.includes('BUILD_NUMBER="${GITHUB_RUN_NUMBER}"'), false);
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
  assert.match(legacyBuild, /workflow_dispatch:/);
  assert.match(legacyBuild, /NOWEN_LEGACY_RELEASE_ASSETS_ENABLED == '1'/);
  assert.doesNotMatch(legacyBuild, /push:\s*\n\s*tags:/);
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

test('formal Android release pins the original certificate fingerprint and safely encodes Java properties', async () => {
  const workflow = await read('.github/workflows/release-build.yml');
  const release = await read('scripts/release-cloud-ci.mjs');
  assert.ok(workflow.includes('NOWEN_ANDROID_CERT_SHA256: ${{ vars.NOWEN_ANDROID_CERT_SHA256 }}'));
  assert.ok(release.includes('NOWEN_ANDROID_CERT_SHA256（原签名证书 SHA-256）'));
  assert.ok(release.includes('Signer #1 certificate SHA-256 digest:'));
  assert.ok(release.includes('escapeJavaProperty(password)'));
  assert.ok(release.includes('escapeJavaProperty(e.NOWEN_ANDROID_KEY_ALIAS)'));
});

test('Docker freeze gate builds and upgrades the real v1.5.3 production image on the same volume', async () => {
  const workflow = await read('.github/workflows/studio-production-docker-rc.yml');
  const runner = await read('scripts/studio-rc-docker-run.sh');
  assert.match(workflow, /ref: v1\.5\.3/);
  assert.match(workflow, /APP_VERSION=1\.5\.4/);
  assert.match(workflow, /RC_OLD_IMAGE:/);
  assert.match(workflow, /RC_IMAGE:/);
  assert.match(runner, /start "\$root\/data" "\$RC_OLD_IMAGE"/);
  assert.match(runner, /start "\$root\/data" "\$RC_IMAGE"/);
  assert.match(runner, /start "\$root\/restore" "\$RC_IMAGE"/);
  assert.match(runner, /STUDIO_PRODUCTION_DOCKER_RC_PASS/);
  assert.match(runner, /WAL backup, independent recovery/);
});

test('NAS transfer validates immutable image tar digest and OCI source labels', async () => {
  const cli = await read('scripts/release-cloud-ci.mjs');
  assert.match(cli, /archiveSha256:\s*archive\.sha256/);
  assert.match(cli, /archive\.sha256 !== image\.archiveSha256/);
  assert.match(cli, /loaded\.Architecture !== arch/);
  assert.match(cli, /loaded\.Os !== 'linux'/);
  assert.match(cli, /labels\['org\.opencontainers\.image\.revision'\] !== sha/);
  assert.match(cli, /labels\['org\.opencontainers\.image\.version'\] !== version/);
});

test('v1.5.4 production upgrade checks published note APIs and WAL snapshot, not deferred Studio routes', async () => {
  const smoke = await read('scripts/studio-rc-runtime-smoke.mjs');
  const runner = await read('scripts/studio-rc-docker-run.sh');
  assert.match(smoke, /candidate update note/);
  assert.match(smoke, /stale note write rejected/);
  assert.match(smoke, /cross-user note read denied/);
  assert.match(smoke, /candidate notes CRUD, optimistic concurrency and ownership/);
  assert.doesNotMatch(smoke, /request\("\"?\/api\/plugins\/personal-apps/);
  assert.match(runner, /SELECT COUNT\(\*\) AS n FROM notes/);
  assert.match(runner, /STUDIO_WAL_BACKUP_PASS/);
  assert.match(runner, /STUDIO_PRODUCTION_DOCKER_RC_PASS/);
});

test('independently versioned frontend workspace remains unchanged', async () => {
  const frontend = await json('frontend/package.json');
  assert.equal(frontend.version, '0.0.0');
});
