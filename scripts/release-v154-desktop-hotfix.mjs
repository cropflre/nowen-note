// One-off, fail-closed replacement for the Windows/macOS assets of v1.5.4.
// Never moves the existing tag, rebuilds other platforms, or touches Docker.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, lstat, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export const REPO = 'cropflre/nowen-note';
export const VERSION = '1.5.4';
export const TAG = `v${VERSION}`;
export const ORIGINAL_TAG_COMMIT = 'de3da1e0c6c99afc42a2af3f285df19900943b66';
export const HOTFIX_COMMIT = '0194596fc382262154f3afbc9d9c1de61eb48f58';
export const HOTFIX_TREE = '20143753d8a5b1f77e871ec648638ebbb6df1471';
export const VERIFIED_QA_RUN = 41461859254;
export const VERIFIED_QA_SHA = '85585a45b81db2031b0b12af745e5abf3e7a420d';
export const WINDOWS = [
  `Nowen-Note-${VERSION}-setup.exe`, `Nowen-Note-${VERSION}-setup.exe.blockmap`,
  `Nowen-Note-${VERSION}-portable.exe`, 'latest.yml',
  `Nowen-Note-Lite-${VERSION}-setup.exe`, `Nowen-Note-Lite-${VERSION}-setup.exe.blockmap`,
  `Nowen-Note-Lite-${VERSION}-portable.exe`, 'latest-lite.yml',
];
export const MACOS = [
  ...['x64', 'arm64'].flatMap(arch => [
    `Nowen-Note-${VERSION}-${arch}.dmg`, `Nowen-Note-${VERSION}-${arch}.dmg.blockmap`,
    `Nowen-Note-${VERSION}-${arch}.zip`, `Nowen-Note-${VERSION}-${arch}.zip.blockmap`,
  ]),
  'latest-mac.yml',
];
export const REPLACEMENTS = [...WINDOWS, ...MACOS];
const METADATA = new Set(['latest.yml', 'latest-lite.yml', 'latest-mac.yml']);
const noIO = new Set(['--help', '-h']);

function gh(args, {capture = true} = {}) {
  return execFileSync('gh', args, {
    encoding:'utf8',
    stdio: capture ? ['ignore','pipe','inherit'] : 'inherit',
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  })?.trim() || '';
}
const api = path => JSON.parse(gh(['api', `repos/${REPO}/${path}`]));
const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
};
function assert(value, message) { if (!value) throw Error(message); }
function remoteDigest(asset) {return typeof asset?.digest === 'string' ? asset.digest : null;}
function indexAssets(release) {
  assert(Array.isArray(release.assets), 'Release assets unavailable');
  const map = new Map();
  for (const asset of release.assets) {
    assert(!map.has(asset.name), `Duplicate remote Release asset ${asset.name}`);
    map.set(asset.name,asset);
  }
  return map;
}
export function assertRemoteBaseline(release, tagRef) {
  assert(tagRef?.object?.sha === ORIGINAL_TAG_COMMIT && tagRef.object.type === 'commit', 'Original v1.5.4 tag was moved: abort');
  assert(release.tag_name === TAG && release.draft === false && !release.prerelease, 'Expected published stable Release v1.5.4');
  const index = indexAssets(release);
  for (const name of REPLACEMENTS) {
    const item = index.get(name);
    assert(item && Number.isSafeInteger(item.size) && item.size > 0 && /^sha256:[a-f0-9]{64}$/.test(remoteDigest(item)||''), `Missing original asset or digest: ${name}`);
  }
  return index;
}
export function assertRemoteStable(before, after, changed = REPLACEMENTS) {
  const changedSet = new Set(changed);
  const previous = indexAssets(before), current = indexAssets(after);
  assert(previous.size === current.size, 'Release asset count changed');
  for (const [name, asset] of previous) {
    const next = current.get(name);
    assert(next, `Release asset disappeared: ${name}`);
    if (!changedSet.has(name)) {
      assert(next.size === asset.size && remoteDigest(next) === remoteDigest(asset), `Unrelated Release asset changed: ${name}`);
    }
  }
}
async function localManifest(dir, expectedNames) {
  const names = await readdir(dir);
  assert(names.length === expectedNames.length, `Unexpected staged file count in ${dir}`);
  assert(names.every(n=>expectedNames.includes(n)), `Unexpected staged file(s) in ${dir}`);
  const report=[];
  for (const name of expectedNames) {
    const path = join(dir,name);
    const info = await lstat(path);
    assert(info.isFile() && info.size > 0, `Invalid staged asset: ${name}`);
    report.push({name,size:info.size,digest:await sha256(path)});
  }
  return report;
}
function sourceProof() {
  const ref = api(`git/ref/tags/${TAG}`);
  const release = api(`releases/tags/${TAG}`);
  const index=assertRemoteBaseline(release,ref);
  const qa=api(`actions/runs/${VERIFIED_QA_RUN}`);
  assert(qa.repository?.full_name===REPO && qa.status==='completed' && qa.conclusion==='success'
    && qa.head_sha===VERIFIED_QA_SHA, 'Independent Release Freeze QA was not successful');
  const merged=api(`git/commits/${HOTFIX_COMMIT}`);
  const candidate=api(`git/commits/${VERIFIED_QA_SHA}`);
  assert(merged.tree?.sha===HOTFIX_TREE && candidate.tree?.sha===HOTFIX_TREE, 'Merged hotfix and validated QA source trees differ');
  return {release,index};
}
async function backup(dir) {
  const {release,index}=sourceProof();
  await mkdir(dir,{recursive:true});
  const original=[];
  for (const name of REPLACEMENTS) {
    gh(['release','download',TAG,'--repo',REPO,'--pattern',name,'--dir',dir,'--clobber'],{capture:false});
    const file=join(dir,name),info=await stat(file);
    const expected=index.get(name);
    assert(info.size===expected.size && (await sha256(file))===expected.digest, `Original download does not match GitHub digest: ${name}`);
    original.push({name,size:info.size,digest:expected.digest});
  }
  await writeFile(join(dir,'backup-manifest.json'),JSON.stringify({version:VERSION,tagSha:ORIGINAL_TAG_COMMIT,releaseId:release.id,files:original},null,2)+'\n',{flag:'wx'});
  console.log(`Backed up ${original.length} original desktop files; current release untouched.`);
}
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function waitForUploadedDigests(files,before) {
  for(let attempt=0;attempt<24;attempt++){
    const after=api(`releases/tags/${TAG}`);
    assertRemoteStable(before,after,REPLACEMENTS);
    const index=indexAssets(after);
    if(files.every(f=>index.get(f.name)?.size===f.size&&index.get(f.name)?.digest===f.digest))return after;
    if(attempt!==23)await sleep(5000);
  }
  throw Error('Published desktop asset digests did not settle within 120 seconds');
}
async function publish(root) {
  assert(process.env.GITHUB_ACTIONS==='true' && process.env.GITHUB_REPOSITORY===REPO, 'Only authorized repository Actions may publish');
  assert(process.env.GITHUB_REF==='refs/heads/release/v1.5.4', 'Hotfix only runs from release/v1.5.4');
  const win=resolve(root,'hotfix-windows'), mac=resolve(root,'hotfix-macos'), backupDir=resolve(root,'original-v154');
  const [winFiles,macFiles,backupInfo]=await Promise.all([
    localManifest(win,WINDOWS),localManifest(mac,MACOS),readFile(join(backupDir,'backup-manifest.json'),'utf8').then(JSON.parse),
  ]);
  const files=[...winFiles,...macFiles], newIndex=new Map(files.map(f=>[f.name,f]));
  const oldFiles=backupInfo.files;
  assert(backupInfo.version===VERSION && backupInfo.tagSha===ORIGINAL_TAG_COMMIT && oldFiles.length===REPLACEMENTS.length, 'Invalid original asset backup');
  const oldIndex=new Map(oldFiles.map(f=>[f.name,f]));
  assert(oldIndex.size===REPLACEMENTS.length, 'Duplicate backup assets');
  for(const name of REPLACEMENTS) {
    const old=oldIndex.get(name);
    assert(old && (await sha256(join(backupDir,name)))===old.digest, `Corrupt original asset backup: ${name}`);
  }
  const {release:before,index}=sourceProof();
  assert(before.id===backupInfo.releaseId, 'Release identity changed after backup');
  for(const name of REPLACEMENTS){
    const old=oldIndex.get(name),remote=index.get(name);
    assert(remote.size===old.size && remote.digest===old.digest, `Original Release asset changed since backup: ${name}`);
  }
  const ordered=[...REPLACEMENTS.filter(n=>!n.endsWith('.blockmap')&&!METADATA.has(n)),
    ...REPLACEMENTS.filter(n=>n.endsWith('.blockmap')),...REPLACEMENTS.filter(n=>METADATA.has(n))];
  const touched=[];
  try {
    for(const name of ordered){
      const local=join(WINDOWS.includes(name) ? win : mac,name);
      // Track a file before clobber: a failed upload may have deleted the original.
      touched.push(name);
      gh(['release','upload',TAG,local,'--repo',REPO,'--clobber'],{capture:false});
    }
    // Check immutable hashes of every replacement and every unrelated asset.
    const after=await waitForUploadedDigests(files,before);
    const marker=`<!-- nowen-v154-desktop-hotfix:${HOTFIX_COMMIT}:${HOTFIX_TREE} -->`;
    if(!after.body?.includes(marker)) {
      const note=`\n\n---\n\n${marker}\n### 桌面版热修复补包（2026-11-02）\n\n仅重新打包 Windows Full/Lite、macOS Intel/Apple Silicon 安装包及对应更新元数据；保留原 v1.5.4 标签、其他平台产物和 Docker 镜像。修复首次 NAS 下载进度、失败重试及继续在线使用入口。\n\n热修复源码：[${HOTFIX_COMMIT.slice(0,8)}](https://github.com/${REPO}/commit/${HOTFIX_COMMIT})；[回归及构建验收](https://github.com/${REPO}/actions/runs/${VERIFIED_QA_RUN})。\n\n**已安装 1.5.4 的用户需要重新下载安装包；相同版本号通常不会触发自动更新。**\n`;
      const full=`${after.body||''}${note}`;
      gh(['api',`repos/${REPO}/releases/${after.id}`,'--method','PATCH','-f',`body=${full}`]);
    }
    await writeFile(resolve(root,'hotfix-receipt.json'),JSON.stringify({version:VERSION,tagSha:ORIGINAL_TAG_COMMIT,hotfixCommit:HOTFIX_COMMIT,runId:process.env.GITHUB_RUN_ID,files},null,2)+'\n',{flag:'wx'});
    console.log(`Replaced and verified ${files.length} desktop files on ${TAG}`);
  } catch(e) {
    console.error('Hotfix publish failed; attempting to restore every touched original asset:',e.message);
    let failures=0;
    for(const name of [...touched].reverse()){
      try{gh(['release','upload',TAG,join(backupDir,name),'--repo',REPO,'--clobber'],{capture:false});}
      catch(err){failures++;console.error(`Restore failed for ${name}: ${err.message}`);}
    }
    if(failures)console.error(`${failures} files could not be restored; backup artifacts must be recovered manually.`);
    throw e;
  }
}
async function main() {
  const [mode,dirname]=process.argv.slice(2);
  if(noIO.has(mode)){console.log('Usage: node scripts/release-v154-desktop-hotfix.mjs backup DIR | publish DIR');return;}
  if(mode==='backup')return backup(resolve(dirname||'original-v154'));
  if(mode==='publish')return publish(resolve(dirname||'.'));
  throw Error('Unknown operation');
}
if (process.argv[1] && new URL(import.meta.url).pathname===resolve(process.argv[1])){
  main().catch(e=>{console.error(e);process.exitCode=1;});
}
