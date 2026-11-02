// Default small sample; --large writes and verifies a real 10 GiB dataset in temp storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),electron=createRequire(path.join(root,'package.json'))('electron');
const large=process.argv.includes('--large'),MiB=1024*1024;
const sizes=large?[512*MiB,...Array(76).fill(128*MiB)]:[16*MiB,8*MiB,8*MiB];
const total=sizes.reduce((a,b)=>a+b,0),directory=fs.mkdtempSync(path.join(os.tmpdir(),'nowen-nas-offline-'));
const stat=fs.statfsSync(directory);assert.ok(stat.bavail*stat.bsize>2*total+5*1024**3,'insufficient temporary disk space');
const output=path.join(root,'frontend/node_modules/.cache/nas-offline-results',large?'large-attachments':'small-attachments');fs.mkdirSync(output,{recursive:true});
const report={startedAt:new Date().toISOString(),large,bytes:total,passed:false};
let server,client,logs='',account;
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const base=`http://127.0.0.1:${port}`,env={...process.env,ELECTRON_RUN_AS_NODE:'1',NOWEN_NAS_OFFLINE_PROFILE:directory,PORT:String(port),JWT_SECRET:'isolated-large-acceptance-secret'};delete env.NODE_OPTIONS;
async function stop(child){if(child?.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
const wait=async(work)=>{const end=Date.now()+30_000;while(Date.now()<end){if(await work())return;await new Promise(r=>setTimeout(r,100));}throw new Error('capacity NAS startup timeout');};
async function api(endpoint,body){const r=await fetch(`${base}/api${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json',...(account?{Authorization:`Bearer ${account.token}`}:{})},body:JSON.stringify(body)});assert.ok(r.ok);return r.json();}
try{
  server=spawn(electron,['--import',pathToFileURL(path.join(root,'backend/node_modules/tsx/dist/loader.mjs')).href,path.join(root,'backend/tests/nas-offline-server.ts')],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']});
  for(const stream of [server.stdout,server.stderr])stream.on('data',data=>{logs=(logs+data).slice(-20_000);});
  await wait(()=>fetch(`${base}/api/health`).then(r=>r.ok).catch(()=>false));
  account=await api('/auth/register',{username:'capacity_offline',password:'isolated-capacity-password'});
  const book=await api('/notebooks',{name:'Capacity'}),note=await api('/notes',{notebookId:book.id,title:'Capacity',content:'capacity body',contentFormat:'markdown'});
  const files=[],chunk=Buffer.alloc(MiB,0xa5);
  for(const size of sizes){
    const id=randomUUID(),relative=`capacity/${id}.bin`,target=path.join(directory,'nas/attachments',relative),hash=createHash('sha256');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    await pipeline((async function*(){for(let remaining=size;remaining>0;remaining-=chunk.length){const part=chunk.subarray(0,Math.min(remaining,chunk.length));hash.update(part);yield part;}})(),fs.createWriteStream(target));
    files.push({id,path:relative,size,hash:hash.digest('hex')});
    console.log(`[large-offline] generated ${files.length}/${sizes.length}`);
  }
  await new Promise((resolve,reject)=>{server.once('message',message=>message.type==='seeded'?resolve():reject(new Error(message.error)));server.send({type:'seed-attachments',userId:account.user.id,noteId:note.id,files});});
  const local=path.join(directory,'client');fs.mkdirSync(local,{recursive:true});
  client=spawn(electron,['--import',pathToFileURL(path.join(root,'backend/node_modules/tsx/dist/loader.mjs')).href,path.join(root,'backend/tests/nas-offline-large-client.ts')],{cwd:root,env:{...env,ELECTRON_USER_DATA:local,DB_PATH:path.join(local,'client.db')},stdio:['pipe','pipe','pipe']});
  let clientOutput='';client.stdout.on('data',data=>{clientOutput+=data;for(const line of String(data).split('\n'))if(line.startsWith('CAPACITY_PROGRESS '))console.log(line);});client.stderr.on('data',data=>{logs=(logs+data).slice(-20_000);});
  client.stdin.end(JSON.stringify({server:base,token:account.token,userId:account.user.id,bookId:book.id,noteId:note.id,files}));
  const code=await new Promise(resolve=>client.once('exit',resolve));assert.equal(code,0,'large attachment client failed');
  const line=clientOutput.split('\n').find(line=>line.startsWith('CAPACITY_RESULT '));assert.ok(line);Object.assign(report,JSON.parse(line.slice('CAPACITY_RESULT '.length)),{passed:true});
  report.serverMemory=await new Promise(resolve=>{server.once('message',resolve);server.send({type:'metrics'});});
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
  await stop(client);await stop(server);
  for(const secret of [account?.token,account?.refreshToken,'isolated-capacity-password'])if(secret)logs=logs.replaceAll(secret,'[redacted]');
  report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'runtime.log'),logs);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  fs.rmSync(directory,{recursive:true,force:true});console.log(`[large-offline] ${report.passed?'PASS':'FAIL'} ${path.join(output,'report.json')}`);
}
