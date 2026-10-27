// Full debug APK, isolated application ID, private emulator and loopback NAS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'frontend/package.json'));
const {_android,expect}=require('@playwright/test');
const electron=createRequire(path.join(root,'package.json'))('electron');
const serial=process.argv[2];
assert.equal(serial,'emulator-5580','Use the dedicated read-only acceptance emulator on port 5580');
const pkg='com.nowen.note.offlineacceptance';
const adbPath=process.env.ADB || path.join(os.homedir(),'Library/Android/sdk/platform-tools/adb');
const adb=(...args)=>execFileSync(adbPath,['-s',serial,...args],{encoding:'utf8',timeout:30_000});
const output=path.join(root,'frontend/node_modules/.cache/nas-offline-results/android');fs.mkdirSync(output,{recursive:true});
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nowen-nas-offline-'));
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const base=`http://127.0.0.1:${port}`;
const env={...process.env,NOWEN_NAS_OFFLINE_PROFILE:directory,ELECTRON_RUN_AS_NODE:'1',PORT:String(port),JWT_SECRET:'isolated-native-acceptance-secret'};
delete env.NODE_OPTIONS;
let nas,device,page,account,logs='';
const report={serial,applicationId:pkg,startedAt:new Date().toISOString(),checks:[],passed:false};
const record=(name,details={})=>{report.checks.push({name,...details});console.log(`[android-offline] ${name}`);};
async function wait(work,message,timeout=30_000){const end=Date.now()+timeout;while(Date.now()<end){if(await work())return;await new Promise(r=>setTimeout(r,100));}throw new Error(message);}
async function stopNas(){if(!nas||nas.exitCode!==null)return;await new Promise(resolve=>{nas.once('exit',resolve);nas.kill();});nas=undefined;}
async function startNas(){
  nas=spawn(electron,['--import',pathToFileURL(path.join(root,'backend/node_modules/tsx/dist/loader.mjs')).href,path.join(root,'backend/tests/nas-offline-server.ts')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  for(const stream of [nas.stdout,nas.stderr])stream.on('data',data=>{logs=(logs+data).slice(-20_000);});
  await wait(()=>fetch(`${base}/api/health`).then(r=>r.ok).catch(()=>false),'NAS not ready');
}
async function api(endpoint,body){const r=await fetch(`${base}/api${endpoint}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(account?{Authorization:`Bearer ${account.token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`${endpoint}: ${r.status}`);return r.json();}
async function attach(){device=(await _android.devices()).find(d=>d.serial()===serial);assert.ok(device);page=await(await device.webView({pkg})).page();await page.waitForLoadState();}
async function restart(){if(device)await device.close();adb('shell','am','force-stop',pkg);adb('shell','am','start','-n',`${pkg}/com.nowen.note.MainActivity`);await attach();}
async function nativeSnapshot(noteId){
  const files=adb('shell','run-as',pkg,'ls','databases').trim().split(/\s+/).filter(file=>file.endsWith('.db'));
  for(const file of files){
    const target=path.join(directory,file);
    fs.writeFileSync(target,execFileSync(adbPath,['-s',serial,'exec-out','run-as',pkg,'cat',`databases/${file}`]));
    try{fs.writeFileSync(`${target}-wal`,execFileSync(adbPath,['-s',serial,'exec-out','run-as',pkg,'cat',`databases/${file}-wal`],{stdio:['ignore','pipe','ignore']}));}catch{}
    const script=`const Database=require(${JSON.stringify(path.join(root,'backend/node_modules/better-sqlite3'))});const db=new Database(process.argv[1],{readonly:true});const row=db.prepare("SELECT content,version FROM notes WHERE scopeKey='personal' AND id=?").get(process.argv[2]);const pending=db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE entityId=?').get(process.argv[2]).n;console.log(JSON.stringify({row,pending}));db.close();`;
    const result=JSON.parse(execFileSync(electron,['-e',script,target,noteId],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'}));
    if(result.row)return result;
  }
  return null;
}
try{
  // Keep all ordinary network interfaces disabled. adb reverse carries only this test port.
  adb('shell','svc','wifi','disable');adb('shell','svc','data','disable');
  adb('shell','pm','clear',pkg);
  await startNas();
  account=await api('/auth/register',{username:'native_offline',password:'isolated-native-password'});
  const book=await api('/notebooks',{name:'Native NAS Notes'});
  const note=await api('/notes',{notebookId:book.id,title:'Native Offline Editable',contentFormat:'markdown',content:'native NAS body',contentText:'native NAS body'});
  const unread=await api('/notes',{notebookId:book.id,title:'Native Previously Unread',contentFormat:'markdown',content:'native unread survives restart',contentText:'native unread survives restart'});
  adb('reverse',`tcp:${port}`,`tcp:${port}`);
  adb('shell','am','force-stop',pkg);adb('shell','am','start','-n',`${pkg}/com.nowen.note.MainActivity`);
  await attach();
  await expect(page.getByRole('button',{name:/^(New Note|新建笔记)$/}).first()).toBeVisible({timeout:20_000});
  await page.evaluate(version=>{localStorage.setItem('i18nextLng','zh-CN');localStorage.setItem('nowen-seen-version',version);},require(path.join(root,'package.json')).version);
  // A process restart closes native SQLite cleanly; do not reload its WebView
  // while the first-run schema transaction is still opening.
  await new Promise(resolve=>setTimeout(resolve,1500));
  await restart();
  const whatsNew=page.getByRole('button',{name:/^(Got it|知道了)$/});
  if(await whatsNew.isVisible())await whatsNew.click();
  await page.locator('button:has(svg.lucide-menu)').first().click();
  await page.getByRole('button',{name:/^(设置|Settings)$/}).click();
  await page.getByRole('button',{name:/^(数据与同步|Data & Sync)$/}).click();
  await page.getByRole('radio').last().click({noWaitAfter:true});
  await page.getByPlaceholder('admin',{exact:true}).fill('native_offline');
  await page.getByPlaceholder('fnos.net/user:3001 或 192.168.1.10:3001',{exact:true}).fill(new URL(base).host);
  await page.locator('input[type=password]').fill('isolated-native-password');
  await page.getByRole('button',{name:/^(登录工作台|Sign In)$/}).click({noWaitAfter:true});
  await expect(page.getByText('Native Offline Editable',{exact:true}).first()).toBeVisible({timeout:30_000});
  record('full APK logged into loopback NAS and downloaded notes');
  await stopNas();adb('reverse','--remove',`tcp:${port}`);
  await restart();
  await page.getByText('Native Previously Unread',{exact:true}).first().click();
  await expect(page.locator('.cm-content').first()).toContainText('native unread survives restart');
  record('NAS stopped and app force-stopped: previously unread native note opens');
  // Back to the note list via the editor's mobile back control.
  await page.locator('button:has(svg.lucide-chevron-left)').first().click();
  await page.getByText('Native Offline Editable',{exact:true}).first().click();
  const editor=page.locator('.cm-content').first();await editor.click();await page.keyboard.press('Control+End');await page.keyboard.type('\nnative offline acceptance edit');
  await wait(async()=>{const snapshot=await nativeSnapshot(note.id);return snapshot?.row.content.includes('native offline acceptance edit')&&snapshot.pending>0;},'offline edit not committed to native SQLite/outbox');
  await restart();
  await page.getByText('Native Offline Editable',{exact:true}).first().click();
  await expect(page.locator('.cm-content').first()).toContainText('native offline acceptance edit');
  const snapshot=await nativeSnapshot(note.id);assert.ok(snapshot.pending>0);
  record('offline edit survives force-stop in actual native SQLite with pending Outbox',{pending:snapshot.pending});
  await startNas();adb('reverse',`tcp:${port}`,`tcp:${port}`);
  await restart();
  await expect.poll(async()=> (await api(`/notes/${note.id}`)).content,{timeout:60_000}).toContain('native offline acceptance edit');
  record('reconnected native edit is readable through authenticated server route');
  await page.screenshot({path:path.join(output,'native-offline.png')});report.passed=true;
}catch(error){report.error=error instanceof Error?error.message:String(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{
  if(device)await device.close().catch(()=>{});await stopNas();
  try{adb('reverse','--remove',`tcp:${port}`);}catch{}
  for(const value of [account?.token,account?.refreshToken,'isolated-native-password'])if(value)logs=logs.replaceAll(value,'[redacted]');
  fs.writeFileSync(path.join(output,'runtime.log'),logs);report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  fs.rmSync(directory,{recursive:true,force:true});console.log(`[android-offline] ${report.passed?'PASS':'FAIL'} ${path.join(output,'report.json')}`);
}
