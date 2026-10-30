// Runner-only build helpers. Local entrypoints dispatch workflows; they never call this file.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, lstat, copyFile, chmod, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CLOUD_REPO, normalizeBuild, normalizePublish, expectedArtifacts, assertBuildRun } from './lib/release-cloud-contract.mjs';

const e = process.env;
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
const json = async path => JSON.parse(await readFile(path, 'utf8'));
export async function fileDigest(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw Error('产物必须是非空常规文件');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest('hex') };
}
function requireRunner() {
  if (e.GITHUB_ACTIONS !== 'true' || e.GITHUB_REPOSITORY !== CLOUD_REPO) throw Error('仅允许在本仓库 Actions 中执行');
}
function request() {
  return normalizeBuild({ version: e.RC_VERSION, commit_sha: e.RC_SHA, request_id: e.RC_REQUEST_ID, targets: e.RC_TARGETS, notes: e.RC_NOTES });
}
async function prepare() {
  const input = e.NOWEN_OFFICIAL_REGISTRY_TRUST_ROOTS_JSON;
  if (!input) throw Error('需要仓库变量 NOWEN_OFFICIAL_REGISTRY_TRUST_ROOTS_JSON');
  // Use the existing CLI so validation and generated format stay authoritative.
  const path = join(e.RUNNER_TEMP, 'release-trust-roots.json');
  await writeFile(path, input, { mode: 0o600 });
  run('node', ['scripts/generate-official-registry-trust-roots.mjs', '--input', path]);
}
async function plan() {
  const input = request();
  if (input.commit_sha !== e.GITHUB_SHA || run('git', ['rev-parse', 'HEAD']) !== input.commit_sha ||
      !/^refs\/heads\/(main|release\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(e.GITHUB_REF || '')) throw Error('请选择 main/release 分支的准确 HEAD；不接受未提交源码或 Tag');
  if (e.GITHUB_RUN_ATTEMPT !== '1') throw Error('请用新请求 UUID 发起构建，避免混用不同 attempt 的产物');
  for (const path of ['package.json', 'package-lock.json', 'backend/package.json', 'backend/package-lock.json']) {
    const data = await json(path);
    if (data.version !== input.version || (path.endsWith('lock.json') && data.packages?.['']?.version !== input.version)) throw Error(`版本未提交或不一致：${path}`);
  }
  const gradle = await readFile('frontend/android/app/build.gradle', 'utf8');
  if (gradle.match(/versionName\s+["']([^"']+)/)?.[1] !== input.version) throw Error('Android 版本不一致');
  if (input.targets.includes('android') && e.RC_ANDROID_SIGNING_READY !== 'true') throw Error('Android 签名 Secrets 不完整');
  if (input.targets.includes('android') && !/^[a-f0-9]{64}$/.test((e.NOWEN_ANDROID_CERT_SHA256 || '').replace(/:/g, '').toLowerCase())) {
    throw Error('Android 正式构建需要仓库变量 NOWEN_ANDROID_CERT_SHA256（原签名证书 SHA-256）');
  }
  if (input.targets.includes('ios') && e.RC_IOS_SIGNING_READY !== 'true') throw Error('iOS 签名 Secrets 不完整');
  if (input.targets.includes('macos') && e.RC_MAC_SIGNING_ENABLED === 'true' && e.RC_MAC_SIGNING_READY !== 'true') throw Error('macOS 签名/公证 Secrets 不完整');
  if (input.targets.includes('fpk') && (!/^https:\/\//.test(e.FNPACK_URL || '') || !/^[a-f0-9]{64}$/.test(e.FNPACK_SHA256 || ''))) throw Error('FPK 构建需要 FNPACK_URL 与 FNPACK_SHA256 仓库变量');
  await prepare();
  await appendFile(e.GITHUB_OUTPUT, `targets=${JSON.stringify(input.targets)}\nplatforms=${JSON.stringify(input.targets.filter(t => ['windows', 'macos', 'linux'].includes(t)))}\n`);
}
async function stageFiles(source, output, pattern) {
  await mkdir(output, { recursive: true });
  const names = (await readdir(source)).filter(name => pattern.test(name));
  if (!names.length) throw Error(`没有找到产物：${source}`);
  for (const name of names) { await fileDigest(join(source, name)); await copyFile(join(source, name), join(output, name)); }
}
export function escapeJavaProperty(value) {
  return String(value).split("").map(char => /[A-Za-z0-9_./-]/.test(char)
    ? char
    : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
}

async function androidSigning() {
  const password = e.NOWEN_ANDROID_KEYSTORE_PASSWORD, keyPassword = e.NOWEN_ANDROID_KEY_PASSWORD || password;
  if (!e.NOWEN_ANDROID_KEYSTORE_B64 || !password || !keyPassword || !e.NOWEN_ANDROID_KEY_ALIAS) throw Error('缺少 Android 发布签名 Secrets');
  await writeFile('frontend/android/app/cloud-release.keystore', Buffer.from(e.NOWEN_ANDROID_KEYSTORE_B64, 'base64'), { mode: 0o600 });
  await writeFile('frontend/android/keystore.properties', `storeFile=app/cloud-release.keystore\nstorePassword=${escapeJavaProperty(password)}\nkeyAlias=${escapeJavaProperty(e.NOWEN_ANDROID_KEY_ALIAS)}\nkeyPassword=${escapeJavaProperty(keyPassword)}\n`, { mode: 0o600 });
}
async function androidStage() {
  const tools = (await readdir(join(e.ANDROID_HOME, 'build-tools'))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const dir = join(e.ANDROID_HOME, 'build-tools', tools);
  const apk = 'frontend/android/app/build/outputs/apk/release/app-release.apk';
  run(join(dir, 'apksigner'), ['verify', '--verbose', apk]);
  const certificateOutput = run(join(dir, 'apksigner'), ['verify', '--print-certs', apk]);
  const certificate = certificateOutput.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9:]+)/i)?.[1]?.replace(/:/g, '').toLowerCase();
  const expectedCertificate = (e.NOWEN_ANDROID_CERT_SHA256 || '').replace(/:/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedCertificate) || certificate !== expectedCertificate) {
    throw Error('Android APK signing certificate fingerprint does not match NOWEN_ANDROID_CERT_SHA256');
  }
  const badging = run(join(dir, 'aapt'), ['dump', 'badging', apk]);
  const gradle = await readFile('frontend/android/app/build.gradle', 'utf8');
  const expectedCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
  if (!Number.isSafeInteger(expectedCode) || !badging.includes("name='com.nowen.note'") ||
      !badging.includes(`versionName='${e.RC_VERSION}'`) || !badging.includes(`versionCode='${expectedCode}'`)) {
    throw Error('Android APK application ID / versionName / versionCode 不匹配');
  }
  await mkdir('release-android', { recursive: true });
  await copyFile(apk, `release-android/Nowen-Note-${e.RC_VERSION}.apk`);
  const aab = 'frontend/android/app/build/outputs/bundle/release/app-release.aab';
  if (!run('jarsigner', ['-verify', aab], { env: { ...e, LC_ALL: 'C' } }).includes('jar verified.')) throw Error('AAB 签名验证失败');
  await copyFile(aab, `release-android/Nowen-Note-${e.RC_VERSION}.aab`);
}
async function dockerStage() {
  if (!['amd64', 'arm64'].includes(e.RC_ARCH)) throw Error('无效 Docker 架构');
  const ref = `${CLOUD_REPO}:v${e.RC_VERSION}-${e.RC_ARCH}`;
  const image = JSON.parse(run('docker', ['image', 'inspect', ref]))[0];
  if (image.Architecture !== e.RC_ARCH || image.Os !== 'linux' || image.Config.Labels['org.opencontainers.image.revision'] !== e.GITHUB_SHA || image.Config.Labels['org.opencontainers.image.version'] !== e.RC_VERSION) throw Error('Docker 镜像来源不一致');
  await mkdir('release-docker', { recursive: true });
  run('docker', ['run', '--rm', '--entrypoint', 'node', ref, '-e', "const Database=require('./backend/node_modules/better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close(); require('./backend/node_modules/sharp')({create:{width:1,height:1,channels:4,background:'#fff'}}).png().toBuffer().catch(()=>process.exit(1));"]);
  run('docker', ['save', '-o', 'release-docker/image.tar', ref]);
  await writeFile('release-docker/image.json', JSON.stringify({ ref, id: image.Id, arch: image.Architecture, sha: e.GITHUB_SHA, version: e.RC_VERSION }));
}
async function loadImage(directory, version, sha, arch) {
  const image = await json(join(directory, 'image.json'));
  if (image.arch !== arch || image.sha !== sha || image.version !== version || image.ref !== `${CLOUD_REPO}:v${version}-${arch}` || !/^sha256:[a-f0-9]{64}$/.test(image.id)) throw Error('Docker 镜像记录不匹配');
  run('docker', ['load', '-i', join(directory, 'image.tar')]);
  const loaded = JSON.parse(run('docker', ['image', 'inspect', image.ref]))[0];
  if (loaded.Id !== image.id || loaded.Architecture !== arch) throw Error('加载后的 Docker 镜像不匹配');
  return image;
}
async function nas() {
  const targets = JSON.parse(e.RC_TARGETS);
  for (const arch of ['amd64', 'arm64']) await loadImage(`cloud-artifacts/release-docker-${arch}`, e.RC_VERSION, e.GITHUB_SHA, arch);
  if (targets.includes('fpk')) {
    const url = new URL(e.FNPACK_URL);
    if (url.protocol !== 'https:' || url.username || url.password) throw Error('无效 fnpack 下载地址');
    const result = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!result.ok) throw Error('fnpack 下载失败');
    const bytes = Buffer.from(await result.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== e.FNPACK_SHA256) throw Error('fnpack SHA256 不匹配');
    const binary = join(e.RUNNER_TEMP, 'fnpack');
    await writeFile(binary, bytes, { mode: 0o700 });
    run('node', ['scripts/fpk/build-fpk.mjs'], { env: { ...e, DOCKERHUB_REPO: CLOUD_REPO, FPK_IMAGE_TAG: `v${e.RC_VERSION}`, FNPACK_BIN: binary } });
    await stageFiles('dist-fpk', 'release-fpk', /\.fpk$/);
  }
  if (targets.includes('upk')) {
    await chmod('ugcli', 0o700);
    run('node', ['scripts/upk/build-upk.mjs', '--version', e.RC_VERSION, '--arch', 'all', '--image', `${CLOUD_REPO}:v${e.RC_VERSION}`], { env: { ...e, DOCKERHUB_REPO: CLOUD_REPO } });
    await stageFiles('dist-upk', 'release-upk', /\.upk$/);
  }
}
async function artifactInventory(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const name of entries.sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) throw Error('无效产物文件名');
    files.push({ name, ...await fileDigest(join(directory, name)) });
  }
  if (!files.length) throw Error('空产物');
  return files;
}
export async function makeManifest(input, directory, source) {
  const names = expectedArtifacts(input);
  const actual = (await readdir(directory)).filter(n => n.startsWith('release-') && n !== 'release-manifest').sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) throw Error('产物目标缺失或多出未选择目标');
  const artifacts = [];
  for (const name of names) {
    const dir = join(directory, name);
    const entry = await lstat(dir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('产物目录不是常规目录');
    if (['release-windows', 'release-macos', 'release-linux'].includes(name)) {
      const { verifyFormalDirectory } = await import('./release-center-formal-assets.mjs');
      await verifyFormalDirectory(dir, { platform: name.slice(8), version: input.version });
    }
    artifacts.push({ name, files: await artifactInventory(dir) });
  }
  return { schema: 1, repository: CLOUD_REPO, ...input, ...source, artifacts };
}
async function macProof() {
  const signed = e.RC_MAC_SIGNING === 'true';
  if (signed) {
    for (const folder of ['mac', 'mac-arm64']) {
      const directory = join('dist-electron', folder);
      const apps = (await readdir(directory)).filter(name => name.endsWith('.app'));
      if (apps.length !== 1) throw Error('macOS 应用集合不完整');
      const app = join(directory, apps[0]);
      run('codesign', ['--verify', '--deep', '--strict', app]);
      const identity = spawnSync('codesign', ['-d', '--verbose=4', app], { encoding: 'utf8' });
      if (identity.status !== 0 || !identity.stderr.includes('Authority=Developer ID Application:')) throw Error('缺少 Developer ID Application 签名');
      run('xcrun', ['stapler', 'validate', app]);
    }
  }
  const proof = { sha: e.RC_SHA, version: e.RC_VERSION, request_id: e.RC_REQUEST_ID, run_id: Number(e.GITHUB_RUN_ID), run_attempt: Number(e.GITHUB_RUN_ATTEMPT), signed, notarized: signed, files: await artifactInventory('rc-candidate/macos/assets') };
  await mkdir('mac-proof', { recursive: true });
  await writeFile('mac-proof/signature.json', JSON.stringify(proof));
}
export async function verifyMacProof(manifest, directory) {
  if (!manifest.targets.includes('macos')) return;
  const proof = await json(join(directory, 'release-macos-proof/signature.json'));
  if (proof.signed !== true || proof.notarized !== true || proof.sha !== manifest.commit_sha || proof.version !== manifest.version || proof.request_id !== manifest.request_id || proof.run_id !== manifest.run_id || proof.run_attempt !== manifest.run_attempt || JSON.stringify(proof.files) !== JSON.stringify(manifest.artifacts.find(a => a.name === 'release-macos').files)) throw Error('macOS 正式分发需要与本次产物绑定的签名与公证证据；未签名候选不能晋升');
}
async function manifest() {
  if (e.GITHUB_RUN_ATTEMPT !== '1') throw Error('请使用新请求 UUID 完整重建；不混用旧 attempt 的产物');
  const data = await makeManifest(request(), 'cloud-artifacts', { run_id: Number(e.GITHUB_RUN_ID), run_attempt: Number(e.GITHUB_RUN_ATTEMPT) });
  await writeFile('release-manifest.json', JSON.stringify(data, null, 2));
  await appendFile(e.GITHUB_STEP_SUMMARY, `## 构建完成，等待发布确认\n版本：${data.version}\n源码：${data.commit_sha}\n目标：${data.targets.join(', ')}\n产物保留 7 天；构建没有上传任何发布渠道。\n`);
}
export async function verifyManifest(manifest, directory, sourceRun, input) {
  assertBuildRun(sourceRun, input.source_run_id, input.source_attempt);
  if (manifest.schema !== 1 || manifest.repository !== CLOUD_REPO || manifest.run_id !== sourceRun.id || manifest.run_attempt !== sourceRun.run_attempt || manifest.commit_sha !== sourceRun.head_sha || manifest.version !== input.version || sourceRun.display_title !== `Release build ${manifest.request_id}`) throw Error('产物清单来源不匹配');
  const request = normalizeBuild(manifest);
  const rebuilt = await makeManifest(request, directory, { run_id: manifest.run_id, run_attempt: manifest.run_attempt });
  if (JSON.stringify(rebuilt) !== JSON.stringify(manifest)) throw Error('产物大小、摘要或清单被改变');
  if (input.channels.includes('github')) await verifyMacProof(manifest, directory);
  if (input.channels.includes('docker') && !request.targets.includes('docker')) throw Error('本次构建没有 Docker 镜像');
  if (input.channels.includes('testflight') && !request.targets.includes('ios')) throw Error('本次构建没有 IPA');
  if (input.channels.includes('github') && request.targets.some(t => ['fpk', 'upk'].includes(t)) && !input.channels.includes('docker')) throw Error('发布 NAS 包必须同时发布本次构建的 Docker 镜像');
  return manifest;
}
const api = path => JSON.parse(run('gh', ['api', `repos/${CLOUD_REPO}/${path}`]));
async function verify() {
  const input = normalizePublish({ version: e.RC_VERSION, request_id: e.RC_REQUEST_ID, source_run_id: e.RC_SOURCE_RUN, source_attempt: e.RC_SOURCE_ATTEMPT, channels: e.RC_CHANNELS, confirmation: e.RC_CONFIRMATION });
  const source = api(`actions/runs/${input.source_run_id}`);
  const manifest = await json('cloud-artifacts/release-manifest/release-manifest.json');
  // The manifest itself must come from the same, successful build; no local files are trusted.
  await verifyManifest(manifest, 'cloud-artifacts', source, input);
  await writeFile('verified-release.json', JSON.stringify(manifest));
  return manifest;
}
async function main(command) {
  requireRunner();
  const commands = { plan, prepare, 'android-signing': androidSigning, 'android-stage': androidStage, 'docker-stage': dockerStage, nas, manifest, verify, 'mac-proof': macProof };
  if (!commands[command]) throw Error('未知 Actions 操作');
  await commands[command]();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
