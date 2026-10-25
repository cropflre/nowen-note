import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeBuild, normalizePublish, expectedArtifacts, assertBuildRun } from "../lib/release-cloud-contract.mjs";

const sha = "a".repeat(40);
const id = "21ca8625-56db-467f-a27b-e2b2e5addcd9";
test("cloud requests expand aliases and include Docker for NAS, without adding upload permission", () => {
  const request = normalizeBuild({ version: "1.5.3", commit_sha: sha, request_id: id, targets: "pc,upk" });
  assert.deepEqual(request.targets, ["windows", "macos", "linux", "docker", "upk"]);
  assert.ok(expectedArtifacts(request).includes("release-docker-arm64"));
  assert.equal(request.publish, undefined);
});
test("malformed and unsupported inputs fail before dispatch", () => {
  for (const extra of [{targets:"pc; curl evil"}, {targets:""}, {commit_sha:"main"}, {version:"1.5.3\nBAD=1"}, {request_id:"bad"}])
    assert.throws(() => normalizeBuild({version:"1.5.3",commit_sha:sha,request_id:id,targets:"pc",...extra}));
});
test("publishing requires explicit version confirmation and source attempt", () => {
  const input = {version:"1.5.3", request_id:id, source_run_id:101, source_attempt:1, channels:"github"};
  assert.throws(() => normalizePublish(input));
  assert.throws(() => normalizePublish({...input,confirmation:"1.5.3",channels:"store"}));
  assert.equal(normalizePublish({...input,confirmation:"1.5.3"}).source_run_id, 101);
});
test("only completed successful unified builds from this repo and exact attempt can be published", () => {
  const run = {id:101,run_attempt:1,event:"workflow_dispatch",path:".github/workflows/release-build.yml",status:"completed",conclusion:"success",head_sha:sha,display_title:`Release build ${id}`,repository:{full_name:"cropflre/nowen-note"}};
  assert.doesNotThrow(() => assertBuildRun(run,101,1));
  for (const extra of [{conclusion:"failure"},{path:".github/workflows/release-center-candidate.yml"},{run_attempt:2},{event:"pull_request"},{repository:{full_name:"attacker/fork"}}])
    assert.throws(() => assertBuildRun({...run,...extra},101,1));
});

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeManifest, verifyManifest } from '../release-cloud-ci.mjs';
import { parseArgs } from '../release-cloud.mjs';
test('artifact verification rejects changed bytes, missing targets and foreign source attempts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nowen-cloud-inventory-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  await mkdir(join(directory,'release-clipper'));
  await writeFile(join(directory,'release-clipper','clipper.zip'),'fixture package');
  const input = normalizeBuild({version:'1.5.3',request_id:id,commit_sha:sha,targets:'clipper'});
  const source = {id:101,run_attempt:1,event:'workflow_dispatch',path:'.github/workflows/release-build.yml',status:'completed',conclusion:'success',head_sha:sha,display_title:`Release build ${id}`,repository:{full_name:'cropflre/nowen-note'}};
  const publish = normalizePublish({version:'1.5.3',request_id:id,source_run_id:101,source_attempt:1,channels:'github',confirmation:'1.5.3'});
  const manifest = await makeManifest(input,directory,{run_id:101,run_attempt:1});
  await mkdir(join(directory,'release-manifest'));
  await writeFile(join(directory,'release-manifest','release-manifest.json'),JSON.stringify(manifest));
  await verifyManifest(manifest,directory,source,publish);
  await assert.rejects(verifyManifest(manifest,directory,{...source,run_attempt:2},publish));
  await assert.rejects(verifyManifest(manifest,directory,source,{...publish,channels:['testflight']}));
  await writeFile(join(directory,'release-clipper','clipper.zip'),'tampered package');
  await assert.rejects(verifyManifest(manifest,directory,source,publish));
  await rm(join(directory,'release-clipper'),{recursive:true});
  await assert.rejects(makeManifest(input,directory,{run_id:101,run_attempt:1}));
});
test('remote CLI cannot accept local build flags or injected extra arguments', () => {
  assert.equal(parseArgs(['--target','pc,android','--wait']).wait,true);
  for (const args of [['--desktop-build','local'],['--push'],['--target'],['--version','--wait']]) assert.throws(() => parseArgs(args));
});

import { publishGitHub } from '../release-cloud-publish.mjs';
test('publisher reconciles a lost upload response, refuses tampering, and never overwrites foreign releases', async t => {
  const directory = await mkdtemp(join(tmpdir(),'nowen-cloud-publisher-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = join(directory,'summary');
  t.after(() => { if(previous === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY=previous; });
  const file = {name:'clipper.zip',size:10,sha256:'c'.repeat(64)};
  const manifest = {version:'1.5.3',run_id:101,run_attempt:1,commit_sha:sha,artifacts:[{name:'release-clipper',files:[file]}]};
  let tag=null, release=null, assets=[], uploads=0, publishes=0, drafts=0, loseUpload=true;
  const api = async (path, method='GET', body) => {
    if (path.startsWith('git/ref/tags/')) return tag;
    if (path==='git/refs') { tag={object:{type:'commit',sha:body.sha}}; return tag; }
    if (path.startsWith('releases/tags/')) return release;
    if (path==='releases' && method==='POST') { drafts++; release={...body,id:1}; return release; }
    if (path.includes('/assets?')) return assets;
    if (path==='releases/1' && method==='PATCH') { publishes++; release.draft=false; return release; }
    throw Error(`unexpected API ${method} ${path}`);
  };
  const execute = () => { uploads++; assets=[{name:file.name,size:10,digest:`sha256:${file.sha256}`}]; if(loseUpload) throw Error('response lost'); };
  await assert.rejects(publishGitHub(manifest,api,execute),/response lost/);
  assert.equal(publishes,0); assert.equal(release.draft,true);
  loseUpload=false;
  await publishGitHub(manifest,api,execute);
  assert.equal(uploads,1); assert.equal(drafts,1); assert.equal(publishes,1);
  await publishGitHub(manifest,api,execute); assert.equal(publishes,1);
  assets[0].digest=`sha256:${'d'.repeat(64)}`;
  await assert.rejects(publishGitHub(manifest,api,execute),/摘要不匹配/);
  release.body='foreign release'; tag=null;
  await assert.rejects(publishGitHub(manifest,api,execute),/禁止接管/);
  assert.equal(tag,null);
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('CLI persists an uncertain dispatch, then finds it once even after the branch moves', {skip:process.platform==='win32'}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'nowen-cloud-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(join(directory,'bin'));
  const calls=join(directory,'calls'), accepted=join(directory,'accepted');
  await writeFile(join(directory,'bin','gh'),`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.CLOUD_CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='api') console.log('a'.repeat(40));
else if(args[0]==='run'&&args[1]==='list') console.log(fs.existsSync(process.env.CLOUD_ACCEPTED)?JSON.stringify([{databaseId:101,displayTitle:'Release build ${id}',headSha:'a'.repeat(40),url:'https://github.com/cropflre/nowen-note/actions/runs/101'}]):'[]');
else if(args[0]==='workflow'){fs.writeFileSync(process.env.CLOUD_ACCEPTED,'accepted');process.exit(1);}
else process.exit(2);
`,{mode:0o755});
  const args=[fileURLToPath(new URL('../release-cloud.mjs',import.meta.url)),'--branch','release/v1.5.4','--version','1.5.3','--target','clipper','--request-id',id.toUpperCase()];
  const env={...process.env,PATH:`${join(directory,'bin')}:${process.env.PATH}`,NOWEN_RELEASE_DATA:join(directory,'data'),CLOUD_CALLS:calls,CLOUD_ACCEPTED:accepted};
  const first=spawnSync(process.execPath,args,{encoding:'utf8',env});assert.equal(first.status,1);assert.match(first.stderr,/触发结果待核实/);
  const second=spawnSync(process.execPath,args,{encoding:'utf8',env});assert.equal(second.status,0,second.stderr);assert.match(second.stdout,/actions\/runs\/101/);
  const records=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(args=>args[0]==='workflow').length,1);
  assert.equal(records.filter(args=>args[0]==='api').length,1);
  const conflict=spawnSync(process.execPath,[...args,'--target','android'],{encoding:'utf8',env});assert.equal(conflict.status,1);assert.match(conflict.stderr,/其他参数/);
});

import { verifyMacProof } from '../release-cloud-ci.mjs';
test('an unsigned Mac candidate cannot acquire release eligibility from a renamed artifact', async t => {
 const directory=await mkdtemp(join(tmpdir(),'nowen-cloud-mac-proof-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await mkdir(join(directory,'release-macos-proof'));
 const manifest={targets:['macos'],version:'1.5.3',request_id:id,run_id:101,run_attempt:1,commit_sha:sha,artifacts:[{name:'release-macos',files:[{name:'mac.zip',size:1,sha256:'b'.repeat(64)}]}]};
 const proof={sha,version:manifest.version,request_id:id,run_id:101,run_attempt:1,signed:false,notarized:false,files:manifest.artifacts[0].files};
 const file=join(directory,'release-macos-proof','signature.json');
 await writeFile(file,JSON.stringify(proof));await assert.rejects(verifyMacProof(manifest,directory),/签名与公证/);
 await writeFile(file,JSON.stringify({...proof,signed:true,notarized:true}));await verifyMacProof(manifest,directory);
 await writeFile(file,JSON.stringify({...proof,signed:true,notarized:true,run_attempt:2}));await assert.rejects(verifyMacProof(manifest,directory));
});

import { compareVersions } from '../lib/release-cloud-contract.mjs';
test('Docker latest cannot regress when an older build finishes later', () => {
 assert.equal(compareVersions('1.5.4','1.5.3'),1);
 assert.equal(compareVersions('1.10.0','1.9.99'),1);
 assert.equal(compareVersions('1.5.3','1.5.3'),0);
 assert.throws(()=>compareVersions(undefined,'1.5.3'));
});

import { publishDocker } from '../release-cloud-publish.mjs';
test('Docker recovers a lost architecture push and rejects a conflicting version without overwriting it', async t => {
 const directory=await mkdtemp(join(tmpdir(),'nowen-cloud-docker-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const previousSummary=process.env.GITHUB_STEP_SUMMARY,previousFetch=global.fetch;
 process.env.GITHUB_STEP_SUMMARY=join(directory,'summary');
 t.after(()=>{global.fetch=previousFetch;if(previousSummary===undefined)delete process.env.GITHUB_STEP_SUMMARY;else process.env.GITHUB_STEP_SUMMARY=previousSummary;});
 const images=['amd64','arm64'].map((arch,i)=>({ref:`cropflre/nowen-note:v1.5.3-${arch}`,id:`sha256:${String(i+1).repeat(64)}`,arch,sha,version:'1.5.3'}));
 for(const image of images){await mkdir(join(directory,`release-docker-${image.arch}`));await writeFile(join(directory,`release-docker-${image.arch}`,'image.json'),JSON.stringify(image));}
 const remote=new Map(),local=new Map(),calls=[];let lose=true;
 global.fetch=async url=>({status:remote.has(String(url).split('/').at(-1))?200:404,ok:true});
 const execute=(command,args)=>{
  calls.push(args);
  if(args[0]==='load'){const image=images.find(image=>args.at(-1).includes(image.arch));local.set(image.ref,image);return '';}
  if(args[0]==='push'){const image=local.get(args[1]);remote.set(args[1].split(':').at(-1),[image]);if(lose){lose=false;throw Error('push response lost');}return '';}
  if(args[0]==='pull'){const arch=args[2].split('/').at(-1);local.set(args[3],remote.get(args[3].split(':').at(-1)).find(image=>image.arch===arch));return '';}
  if(args[0]==='image'){const image=local.get(args.at(-1));return JSON.stringify([{Id:image.id,Architecture:image.arch,Config:{Labels:{'org.opencontainers.image.version':image.version}}}]);}
  if(args.includes('inspect'))return JSON.stringify({digest:`sha256:${'e'.repeat(64)}`});
  if(args.includes('create')){const tag=args[args.indexOf('-t')+1].split(':').at(-1);remote.set(tag,images);return '';}
  throw Error(`unexpected ${command} ${args}`);
 };
 const manifest={version:'1.5.3',commit_sha:sha};
 await assert.rejects(publishDocker(manifest,execute,directory),/push response lost/);
 await publishDocker(manifest,execute,directory);
 assert.equal(calls.filter(args=>args[0]==='push').length,2);
 const writes=calls.filter(args=>args.includes('create')||args[0]==='push').length;
 await publishDocker(manifest,execute,directory);
 assert.equal(calls.filter(args=>args.includes('create')||args[0]==='push').length,writes);
 remote.set('v1.5.3',[{...images[0],id:`sha256:${'f'.repeat(64)}`},images[1]]);
 await assert.rejects(publishDocker(manifest,execute,directory),/禁止覆盖/);
 assert.equal(calls.filter(args=>args.includes('create')||args[0]==='push').length,writes);
});

test('calling the new shell entry without arguments only displays usage on system Bash', () => {
 const entry=fileURLToPath(new URL('../release.sh',import.meta.url));
 const result=spawnSync('bash',[entry],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/GitHub Actions 发版入口/);
});
