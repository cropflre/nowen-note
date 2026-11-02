// Capacity probe entry, launched with Electron's matching native-module ABI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDb, closeDb } from '../src/db/schema';
import { SyncBlobClient, pullAttachmentBlobs } from '../src/sync/blob';
import { registerRemoteAttachment } from '../src/sync/attachments';

async function main(){
  let input='';for await(const chunk of process.stdin)input+=chunk;
  const options=JSON.parse(input) as {server:string;token:string;userId:string;bookId:string;noteId:string;files:Array<{id:string;path:string;size:number;hash:string}>};
  assert.equal(new URL(options.server).hostname,'127.0.0.1');
  const db=getDb();
  db.prepare("INSERT INTO users(id,username,passwordHash,createdAt,updatedAt) VALUES (?,?,'x',datetime('now'),datetime('now'))").run(options.userId,'capacity-local');
  db.prepare("INSERT INTO notebooks(id,userId,name,createdAt,updatedAt) VALUES (?,?,'Capacity',datetime('now'),datetime('now'))").run(options.bookId,options.userId);
  db.prepare("INSERT INTO notes(id,userId,notebookId,title,content,createdAt,updatedAt) VALUES (?,?,?,'Capacity','capacity body',datetime('now'),datetime('now'))").run(options.noteId,options.userId,options.bookId);
  const add=(file:typeof options.files[number])=>{
    db.prepare("INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,path,hash,createdAt) VALUES (?,?,?,'capacity.bin','application/octet-stream',?,?,?,datetime('now'))")
      .run(file.id,options.noteId,options.userId,file.size,file.path,file.hash);
    registerRemoteAttachment(db,file.id,null);
  };
  add(options.files[0]);
  let interrupt=true;
  const faultyFetch:typeof fetch=async(input,init)=>{
    const response=await fetch(input,init);
    if(!interrupt||!response.body)return response;
    interrupt=false;const reader=response.body.getReader();let bytes=0;
    return new Response(new ReadableStream({async pull(controller){
      const next=await reader.read();
      if(next.done){controller.close();return;}
      bytes+=next.value.byteLength;
      if(bytes>8*1024*1024){await reader.cancel();controller.error(new TypeError('injected connection loss'));return;}
      controller.enqueue(next.value);
    }}),{status:response.status,headers:response.headers});
  };
  const credential={serverUrl:options.server,token:options.token};
  const failed=await pullAttachmentBlobs(db,new SyncBlobClient({serverUrl:options.server,credential,fetchImpl:faultyFetch}),{batchSize:1,concurrency:1});
  assert.equal(failed.failed,1);
  assert.equal((db.prepare('SELECT remoteOnly FROM attachment_sync_state WHERE attachmentId=?').get(options.files[0].id) as {remoteOnly:number}).remoteOnly,1);
  assert.equal(fs.existsSync(path.join(process.env.ELECTRON_USER_DATA!,'attachments',options.files[0].path)),false);
  for(const file of options.files.slice(1))add(file);
  const client=new SyncBlobClient({serverUrl:options.server,credential,timeoutMs:120_000});
  const started=performance.now();let downloaded=0;
  while(downloaded<options.files.length){
    const result=await pullAttachmentBlobs(db,client,{batchSize:4,concurrency:2});
    assert.equal(result.failed,0);assert.ok(result.downloaded>0);
    downloaded+=result.downloaded;
    console.log('CAPACITY_PROGRESS '+JSON.stringify({downloaded,total:options.files.length}));
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM attachment_sync_state WHERE remoteOnly=1').get() as {n:number}).n,0);
  for(const file of options.files){
    const local=path.join(process.env.ELECTRON_USER_DATA!,'attachments',file.path),hash=createHash('sha256');
    assert.equal(fs.statSync(local).size,file.size);
    for await(const bytes of fs.createReadStream(local))hash.update(bytes);
    assert.equal(hash.digest('hex'),file.hash);
  }
  console.log('CAPACITY_RESULT '+JSON.stringify({files:downloaded,bytes:options.files.reduce((n,f)=>n+f.size,0),largestBytes:Math.max(...options.files.map(f=>f.size)),durationMs:Math.round(performance.now()-started),rssAfterBytes:process.memoryUsage().rss,maxRSSKiB:process.resourceUsage().maxRSS,interruptedDownloadRetained:true,allFilesVerified:true}));
  closeDb();
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'capacity failed');process.exitCode=1;});
