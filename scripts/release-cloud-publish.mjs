// Executes only on explicitly authorized publisher jobs, using previously verified artifacts.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOUD_REPO, normalizePublish, assertBuildRun, compareVersions } from './lib/release-cloud-contract.mjs';
const e = process.env;
const cmd = (name, args, options = {}) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
async function githubAPI(path, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${CLOUD_REPO}/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${e.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw Error(`GitHub ${method} ${path} 失败 (${response.status})；请先对账再重试`);
  return response.status === 204 ? null : response.json();
}
async function preflight() {
  if (e.RC_PUBLISH_ENABLED !== '1') throw Error('正式发布默认关闭；请配置 NOWEN_RELEASE_CLOUD_PUBLISH 仓库变量并审阅渠道环境');
  const input = normalizePublish({ version: e.RC_VERSION, request_id: e.RC_REQUEST_ID, source_run_id: e.RC_SOURCE_RUN, source_attempt: e.RC_SOURCE_ATTEMPT, channels: e.RC_CHANNELS, confirmation: e.RC_CONFIRMATION });
  const source = await githubAPI(`actions/runs/${input.source_run_id}`);
  assertBuildRun(source, input.source_run_id, input.source_attempt);
  if (!/^(main|release\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(source.head_branch || '')) throw Error('构建不来自发布分支');
  await appendFile(e.GITHUB_OUTPUT, `channels=${JSON.stringify(input.channels)}\n`);
}
export async function publishGitHub(manifest, api = githubAPI, execute = cmd) {
  const tag = `v${manifest.version}`;
  const marker = `<!-- nowen-cloud:${manifest.run_id}:${manifest.run_attempt}:${manifest.commit_sha} -->`;
  const artifacts = manifest.artifacts.filter(a => !['release-ios', 'release-store', 'release-macos-proof', 'release-docker-amd64', 'release-docker-arm64'].includes(a.name));
  if (!artifacts.length) throw Error('没有 GitHub 分发产物；Store/IPA 使用独立渠道');
  const files = artifacts.flatMap(a => a.files.map(f => ({ ...f, path: join('cloud-artifacts', a.name, f.name) })));
  if (new Set(files.map(f => f.name)).size !== files.length) throw Error('产物存在同名文件');
  const ref = await api(`git/ref/tags/${tag}`);
  if (ref && (ref.object?.type !== 'commit' || ref.object.sha !== manifest.commit_sha)) throw Error('同名 Tag 已指向其他来源；禁止覆盖');
  let release = await api(`releases/tags/${tag}`);
  if (release && !release.body?.includes(marker)) throw Error('已有 Release 不属于本次构建；禁止接管');
  if (!ref) await api('git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: manifest.commit_sha });
  const body = `${marker}\n${manifest.notes || ""}\n\n源码：${manifest.commit_sha}\n构建：https://github.com/${CLOUD_REPO}/actions/runs/${manifest.run_id}\n\nWindows 直接下载包未提供代码签名。Store、TestFlight 使用独立渠道。`;
  if (!release) release = await api('releases', 'POST', { tag_name: tag, target_commitish: manifest.commit_sha, name: tag, body, draft: true, prerelease: false });
  const listAssets = async () => {
    const assets = [];
    for (let page = 1; page <= 10; page++) {
      const items = await api(`releases/${release.id}/assets?per_page=100&page=${page}`);
      assets.push(...items);
      if (items.length < 100) return assets;
    }
    throw Error('资产超过分页上限');
  };
  let assets = await listAssets();
  if (assets.some(a => !files.some(f => f.name === a.name))) throw Error('远端有清单外产物，停止发布');
  for (const file of files) {
    const existing = assets.find(a => a.name === file.name);
    if (existing) {
      if (existing.size !== file.size || existing.digest !== `sha256:${file.sha256}`) throw Error(`远端产物摘要不匹配：${file.name}`);
    } else {
      if (!release.draft) throw Error('已发布 Release 缺少产物；禁止修改');
      // No --clobber. A lost upload response is reconciled by digest on the next explicit attempt.
      execute('gh', ['release', 'upload', tag, file.path, '--repo', CLOUD_REPO]);
    }
  }
  assets = await listAssets();
  if (assets.length !== files.length || files.some(f => !assets.some(a => a.name === f.name && a.size === f.size && a.digest === `sha256:${f.sha256}`))) throw Error('上传后远端资产清单/摘要不匹配；保留 Draft');
  if (release.draft) await api(`releases/${release.id}`, 'PATCH', { draft: false });
  await appendFile(e.GITHUB_STEP_SUMMARY, `GitHub Release 已发布：https://github.com/${CLOUD_REPO}/releases/tag/${tag}\n`);
}
export async function publishDocker(manifest, execute = cmd, directory = 'cloud-artifacts') {
  const versionTag = `v${manifest.version}`;
  const images = [];
  for (const arch of ['amd64', 'arm64']) {
    const dir = join(directory, `release-docker-${arch}`);
    const image = await readJSON(join(dir, 'image.json'));
    if (image.sha !== manifest.commit_sha || image.version !== manifest.version || image.arch !== arch || image.ref !== `${CLOUD_REPO}:${versionTag}-${arch}`) throw Error('Docker 来源不一致');
    images.push(image);
  }
  // Docker Hub GET distinguishes an absent tag from network/auth errors. Never overwrite a version.
  const exists = async tag => {
    const response = await fetch(`https://hub.docker.com/v2/repositories/${CLOUD_REPO}/tags/${tag}`, { signal: AbortSignal.timeout(30000) });
    if (response.status === 404) return false;
    if (!response.ok) throw Error(`无法核实已有 Docker Tag (${response.status})`);
    return true;
  };
  const checkRemote = (ref, image) => {
    execute('docker', ['pull', '--platform', `linux/${image.arch}`, ref]);
    const actual = JSON.parse(execute('docker', ['image', 'inspect', ref]))[0];
    if (actual.Id !== image.id || actual.Architecture !== image.arch) throw Error('Docker 已有版本内容不同；禁止覆盖');
  };
  if (await exists(versionTag)) {
    for (const image of images) checkRemote(`${CLOUD_REPO}:${versionTag}`, image);
  } else {
    for (const image of images) {
      const tag = `${versionTag}-${image.arch}`;
      if (await exists(tag)) { checkRemote(image.ref, image); continue; }
      execute('docker', ['load', '-i', join(directory, `release-docker-${image.arch}`, 'image.tar')]);
      const loaded = JSON.parse(execute('docker', ['image', 'inspect', image.ref]))[0];
      if (loaded.Id !== image.id || loaded.Architecture !== image.arch) throw Error('Docker 归档内容不匹配');
      execute('docker', ['push', image.ref]);
      checkRemote(image.ref, image);
    }
    // Reference immutable remote manifests, not mutable architecture tags.
    const references = images.map(image => {
      const info = JSON.parse(execute('docker', ['buildx', 'imagetools', 'inspect', image.ref, '--format', '{{json .Manifest}}']));
      if (!/^sha256:[a-f0-9]{64}$/.test(info.digest)) throw Error('无法固定架构镜像 digest');
      return `${CLOUD_REPO}@${info.digest}`;
    });
    execute('docker', ['buildx', 'imagetools', 'create', '-t', `${CLOUD_REPO}:${versionTag}`, ...references]);
    for (const image of images) checkRemote(`${CLOUD_REPO}:${versionTag}`, image);
  }
  await appendFile(e.GITHUB_STEP_SUMMARY, `版本镜像已核实：${CLOUD_REPO}:${versionTag}；接下来处理 latest。\n`);
  const versionRef = `${CLOUD_REPO}:${versionTag}`;
  const descriptor = JSON.parse(execute('docker', ['buildx', 'imagetools', 'inspect', versionRef, '--format', '{{json .Manifest}}']));
  if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) throw Error('无法固定版本镜像 digest');
  if (await exists('latest')) {
    const latestRef = `${CLOUD_REPO}:latest`;
    execute('docker', ['pull', '--platform', 'linux/amd64', latestRef]);
    const latest = JSON.parse(execute('docker', ['image', 'inspect', latestRef]))[0];
    const currentVersion = latest.Config.Labels?.['org.opencontainers.image.version']?.replace(/^v/, '');
    const comparison = compareVersions(currentVersion, manifest.version);
    if (comparison > 0) { await appendFile(e.GITHUB_STEP_SUMMARY, `已发布 ${versionTag}；latest 保留更新版本 ${currentVersion}。\n`); return; }
    if (comparison === 0) { for (const image of images) checkRemote(latestRef, image); return; }
  }
  execute('docker', ['buildx', 'imagetools', 'create', '-t', `${CLOUD_REPO}:latest`, `${CLOUD_REPO}@${descriptor.digest}`]);
  for (const image of images) checkRemote(`${CLOUD_REPO}:latest`, image);
  await appendFile(e.GITHUB_STEP_SUMMARY, `Docker 双架构镜像已发布：${CLOUD_REPO}:${versionTag}\n`);
}
async function testflight(manifest) {
  if (!e.APPSTORE_API_PRIVATE_KEY || !e.APPSTORE_API_KEY_ID || !e.APPSTORE_ISSUER_ID || !/^[A-Z0-9]+$/.test(e.APPSTORE_API_KEY_ID)) throw Error('缺少 App Store Connect Secrets');
  const ipa = manifest.artifacts.find(a => a.name === 'release-ios')?.files.filter(f => f.name.endsWith('.ipa'));
  if (ipa?.length !== 1) throw Error('必须有且只有一个已验证 IPA');
  const directory = join(e.HOME, '.appstoreconnect', 'private_keys');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = join(directory, `AuthKey_${e.APPSTORE_API_KEY_ID}.p8`);
  await writeFile(key, e.APPSTORE_API_PRIVATE_KEY, { mode: 0o600 });
  try {
    cmd('xcrun', ['altool', '--upload-app', '--type', 'ios', '--file', join('cloud-artifacts/release-ios', ipa[0].name), '--apiKey', e.APPSTORE_API_KEY_ID, '--apiIssuer', e.APPSTORE_ISSUER_ID]);
  } finally { await rm(key, { force: true }); }
  await appendFile(e.GITHUB_STEP_SUMMARY, 'IPA 上传请求完成；TestFlight 处理与审核状态请在 App Store Connect 核实。上传响应丢失时先核对版本/Build Number，勿盲目重发。\n');
}
async function main() {
  if (e.GITHUB_ACTIONS !== 'true' || e.GITHUB_REPOSITORY !== CLOUD_REPO) throw Error('仅允许本仓库 Actions 发布');
  const operation = process.argv[2];
  if (operation === 'preflight') return preflight();
  const manifest = await readJSON('verified-release.json');
  const operations = { github: publishGitHub, docker: publishDocker, testflight };
  if (!operations[operation]) throw Error('未知发布渠道');
  await operations[operation](manifest);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
