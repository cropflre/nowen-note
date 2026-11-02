import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

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
  const script = workflow.match(/BUILD_NUMBER="\$\(node - <<'NODE'\r?\n([\s\S]*?)\r?\n\s*NODE\r?\n\s*\)"/)?.[1];
  assert.ok(script, 'iOS workflow must resolve the committed build number');
  const result = spawnSync(process.execPath, ['-'], {
    cwd: root, encoding: 'utf8', input: script,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, String(codes[0]));
});

test('Node 24 is used by the canonical GitHub-hosted build and publishing workflows', async () => {
  assert.equal((await read('.nvmrc')).trim(), '24.22.1');
  for (const path of ['.github/workflows/release-build.yml', '.github/workflows/release-publish.yml']) {
    const workflow = await read(path);
    assert.match(workflow, /node-version:\s*['"]24\.22\.1['"]/);
    assert.match(workflow, /workflow_dispatch:/);
  }
});

test('macOS build steps omit signing credentials for unsigned candidates and retain them for signed builds', {skip:process.platform==='win32'}, async t => {
  const workflow = createRequire(import.meta.url)('js-yaml').load(await read('.github/workflows/release-center-candidate.yml'));
  const steps = workflow.jobs.build.steps.filter(step => ['Build macOS Intel', 'Build macOS Apple Silicon'].includes(step.name));
  assert.equal(steps.length, 2);
  const directory = await mkdtemp(resolve(tmpdir(), 'nowen-mac-signing-env-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const bin = resolve(directory, 'bin');
  await mkdir(bin);
  const keys = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  await writeFile(resolve(bin, 'npm'), `#!${process.execPath}\n`, {mode:0o755});
  await writeFile(resolve(bin, 'npx'), `#!${process.execPath}\nconst keys=${JSON.stringify(keys)};const values=Object.fromEntries(keys.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));console.log(JSON.stringify(values));if(Object.values(values).some(value=>value===''))process.exit(1);\n`, {mode:0o755});
  for (const step of steps) for (const signing of [false, true]) {
    const credentials = Object.fromEntries(keys.map(key => [key, signing ? 'fixture' : '']));
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
      cwd:root, encoding:'utf8', env:{...process.env,...credentials,CSC_IDENTITY_AUTO_DISCOVERY:String(signing),PATH:`${bin}:${process.env.PATH}`},
    });
    assert.equal(result.status, 0, `${step.name}: ${result.stderr} ${result.stdout}`);
    assert.deepEqual(JSON.parse(result.stdout), signing ? credentials : {});
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

test('formal Clipper packaging excludes historical ZIPs from the upload directory', {skip:process.platform==='win32'}, async t => {
  const workflow = createRequire(import.meta.url)('js-yaml').load(await read('.github/workflows/release-build.yml'));
  const step = workflow.jobs.clipper.steps.find(step => step.run?.includes('pack:all'));
  const directory = await mkdtemp(resolve(tmpdir(), 'nowen-clipper-release-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  await mkdir(resolve(directory, 'releases'));
  await mkdir(resolve(directory, 'bin'));
  await writeFile(resolve(directory, 'releases/nowen-clipper-0.2.0.zip'), 'historical');
  await writeFile(resolve(directory, 'releases/README.md'), 'keep');
  const version = (await json('packages/nowen-clipper/package.json')).version;
  const names = ['', '-edge', '-firefox'].map(suffix => `nowen-clipper-${version}${suffix}.zip`);
  await writeFile(resolve(directory, 'bin/npm'), `#!${process.execPath}\nif(process.argv.includes('pack:all')){const fs=require('node:fs');for(const name of ${JSON.stringify(names)})fs.writeFileSync('releases/'+name,'current');}\n`, {mode:0o755});
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {cwd:directory,encoding:'utf8',env:{...process.env,PATH:`${resolve(directory,'bin')}:${process.env.PATH}`}});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(resolve(directory, 'releases'))).sort(), [...names, 'README.md'].sort());
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
