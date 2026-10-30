import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const [checkout,boundaryFile,output]=process.argv.slice(2);
const boundary=JSON.parse(fs.readFileSync(boundaryFile,'utf8'));
process.env.DB_PATH=path.join(boundary.temp,'audit.db');
process.env.ELECTRON_USER_DATA=boundary.temp;
process.env.NODE_ENV='test';
const require=createRequire(path.join(checkout,'backend/package.json'));
const bcrypt=require('bcryptjs');
const schema=await import(pathToFileURL(path.join(checkout,'backend/src/db/schema.ts')));
const db=schema.getDb();const password='qa-fixture-password';
db.prepare('UPDATE users SET passwordHash=? WHERE id IN (?,?)').run(bcrypt.hashSync(password,4),'qa-owner','qa-other');
db.prepare("DELETE FROM notes WHERE id='qa-http-live'").run();
db.prepare("INSERT INTO notes (id,userId,notebookId,title,content,contentText,contentFormat) VALUES ('qa-http-live','qa-owner','qa-book','HTTP live','# HTTP body','HTTP body','markdown')").run();
schema.closeDb();
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const base='http://127.0.0.1:'+port;const secret=randomBytes(32).toString('hex');
const child=spawn(process.execPath,[path.join(checkout,'backend/dist/index.js')],{cwd:path.join(checkout,'backend'),env:{...process.env,JWT_SECRET:secret,PORT:String(port),NOWEN_LOCAL_FIRST_SYNC_V2:'0'},windowsHide:true});
let log='';child.stdout.on('data',chunk=>{log+=chunk});child.stderr.on('data',chunk=>{log+=chunk});
const report={base,executable:process.execPath,kind:'Built hardened backend on loopback with isolated fixture DB; no installer or UI proof'};
async function request(method,url,token,body,extra={}) {
  const res=await fetch(base+url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
  const text=await res.text();let json;try{json=JSON.parse(text)}catch{json={raw:text.slice(0,300)}}return{status:res.status,body:json};
}
try {
  let ready=false;for(let i=0;i<100;i++){try{const response=await fetch(base+'/api/health');if(response.ok){ready=true;break}}catch{}if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,'Built server did not become ready');
  report.headerSpoof=await request('DELETE','/api/notes/qa-http-live',null,undefined,{'X-User-Id':'qa-owner'});assert.equal(report.headerSpoof.status,401);
  const ownerLogin=await request('POST','/api/auth/login',null,{username:'qa-owner',password});assert.equal(ownerLogin.status,200);const owner=ownerLogin.body.token;
  const otherLogin=await request('POST','/api/auth/login',null,{username:'qa-other',password});assert.equal(otherLogin.status,200);const other=otherLogin.body.token;
  report.login={ownerStatus:ownerLogin.status,otherStatus:otherLogin.status};
  report.crossUser=await request('DELETE','/api/notes/qa-http-live',other);assert.equal(report.crossUser.status,403);
  report.ownerDelete=await request('DELETE','/api/notes/qa-http-live',owner);assert.equal(report.ownerDelete.status,200);
  report.readAfterDelete=await request('GET','/api/notes/qa-http-live',owner);assert.notEqual(report.readAfterDelete.status,200);
  report.restore=await request('POST','/api/trash/batch',owner,{action:'restore',ids:['note:qa-http-live']});assert.ok(report.restore.body.failures.some(row=>row.code==='TRASH_ITEM_NOT_FOUND'));
  report.openapiLegacyExport=await request('GET','/api/export/qa-soft-note',owner);assert.equal(report.openapiLegacyExport.status,404);
  const created=await request('POST','/api/export/markdown-package/jobs',owner,{notes:[{id:'qa-soft-note',title:'QA Export',notebookName:'QA',contentFormat:'markdown',markdown:'# audit body',createdAt:'2026-10-12',updatedAt:'2026-10-12'}]});
  report.exportCreate={status:created.status,body:created.body};assert.equal(created.status,202);
  let status;for(let i=0;i<100;i++){status=await request('GET','/api/export/markdown-package/jobs/'+created.body.job.id,owner);if(['ready','failed'].includes(status.body.job?.state))break;await new Promise(resolve=>setTimeout(resolve,50));}
  report.exportReady={status:status.status,state:status.body.job?.state};assert.equal(status.body.job.state,'ready');
  const download=await fetch(base+'/api/export/download/'+status.body.job.downloadToken);const bytes=Buffer.from(await download.arrayBuffer());
  const JSZip=require('jszip');const zip=await JSZip.loadAsync(bytes);const markdown=Object.keys(zip.files).filter(name=>name.endsWith('.md'));const content=await zip.file(markdown[0]).async('string');
  report.exportDownloaded={status:download.status,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),files:Object.keys(zip.files),markdownContent:content};assert.equal(download.status,200);assert.ok(content.includes('# audit body'));
  fs.writeFileSync(path.join(path.dirname(output),'http-export.zip'),bytes);
  report.exportReimport='NOT_TESTED';
  console.log(JSON.stringify({result:'authenticated HTTP bundle observations reproduced',output}));
} catch(error){report.harnessError={message:error.message,stack:error.stack};throw error;}
finally {
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(path.dirname(output),'http-bundle-server.log'),log);
  if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
}
