// Real desktop product/IPC plus an isolated loopback NAS. Never touches a user profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const { _electron, expect } = require('@playwright/test');
const electron = createRequire(path.join(root, 'package.json'))('electron');
const packaged = process.argv.includes('--packaged');
const executable = packaged
  ? path.join(root, `frontend/node_modules/.cache/nas-offline-packaged/mac${process.arch === 'arm64' ? '-arm64' : ''}/Nowen Note.app/Contents/MacOS/Nowen Note`)
  : electron;
const output = path.join(root, 'frontend/node_modules/.cache/nas-offline-results', packaged ? 'packaged' : 'source');
fs.mkdirSync(output, {recursive:true});
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-nas-offline-'));
const report = {platform:process.platform,arch:process.arch,packaged,startedAt:new Date().toISOString(),checks:[],passed:false};
let nas, desktop, page, logs='', account;
const env = {...process.env,NOWEN_NAS_OFFLINE_PROFILE:directory};
delete env.NODE_OPTIONS; delete env.NOWEN_DEV_BACKEND_URL; delete env.NOWEN_LITE_ONLY; delete env.ELECTRON_RUN_AS_NODE;
const port = await new Promise(resolve => {
  const socket=net.createServer(); socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>resolve(port));});
});
const server=`http://127.0.0.1:${port}`;
env.NOWEN_NAS_OFFLINE_SERVER=server;
env.JWT_SECRET='isolated-nas-acceptance-secret';
const record=(name,details={})=>{report.checks.push({name,...details});console.log(`[offline-acceptance] ${name}`);};
const wait = async (work,message,timeout=30_000) => {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await work())return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error(message);
};
async function stop(child){
  if(!child||child.exitCode!==null)return;
  await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},5000).unref();});
}
async function startNas(){
  nas=spawn(electron,['--import',pathToFileURL(path.join(root,'backend/node_modules/tsx/dist/loader.mjs')).href,path.join(root,'backend/tests/nas-offline-server.ts')],{
    cwd:root,env:{...env,ELECTRON_RUN_AS_NODE:'1',PORT:String(port)},stdio:['ignore','pipe','pipe'],
  });
  for(const stream of [nas.stdout,nas.stderr])stream.on('data',data=>{logs=(logs+data).slice(-24_000);});
  await wait(()=>fetch(`${server}/api/health`).then(r=>r.ok).catch(()=>false),'loopback NAS did not start');
}
async function api(endpoint,body,method=body?'POST':'GET'){
  const response=await fetch(`${server}/api${endpoint}`,{method,headers:{...(account?{Authorization:`Bearer ${account.token}`} :{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.ok(response.ok,`${endpoint}: HTTP ${response.status}`);
  return response.json();
}
async function startDesktop(){
  desktop=await _electron.launch({executablePath:executable,args:packaged?[]:[path.join(root,'scripts/nas-offline-app-fixture.cjs')],cwd:root,env,chromiumSandbox:true});
  for(const stream of [desktop.process().stdout,desktop.process().stderr])stream?.on('data',data=>{logs=(logs+data).slice(-24_000);});
  await wait(async()=>{page=desktop.windows().find(window=>window.url().includes('/frontend/dist/index.html'));return !!page;},'product window did not start');
  await page.waitForLoadState();
  await page.evaluate(version=>{localStorage.setItem('i18nextLng','zh-CN');localStorage.setItem('nowen-seen-version',version);},require(path.join(root,'package.json')).version);
  await page.reload();
}
try {
  await startNas();
  account=await api('/auth/register',{username:'offline_acceptance',password:'isolated-offline-password'});
  const book=await api('/notebooks',{name:'NAS Offline Acceptance'});
  const editable=await api('/notes',{notebookId:book.id,title:'Offline Editable',contentFormat:'markdown',content:'initial NAS body',contentText:'initial NAS body'});
  const unread=await api('/notes',{notebookId:book.id,title:'Offline Previously Unread',contentFormat:'markdown',content:'unread content survives NAS loss',contentText:'unread content survives NAS loss'});
  record('real NAS routes seeded',{notes:[editable.id,unread.id]});
  await startDesktop();
  await page.getByPlaceholder('fnos.net/user:3001 或 192.168.1.10:3001',{exact:true}).fill(new URL(server).host);
  await page.getByPlaceholder('admin',{exact:true}).fill('offline_acceptance');
  await page.locator('input[type=password]').fill('isolated-offline-password');
  await page.getByRole('button',{name:'登录工作台',exact:true}).click();
  await expect(page.getByRole('button',{name:'在根目录新建',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'同步',exact:true}).click();
  await expect(page.getByText('下载到本机，支持离线使用',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'开始迁移',exact:true}).click();
  await expect(page.getByText('笔记已保存到本机。退出并重新打开应用后，可继续下载剩余附件；附件离线状态请在同步设置中核验。',{exact:true})).toBeVisible({timeout:60_000});
  record('migration completed through product UI');
  await desktop.close(); desktop=undefined;
  await stop(nas); nas=undefined;
  assert.equal(await fetch(`${server}/api/health`).then(()=>true).catch(()=>false),false);
  await startDesktop();
  await expect(page.getByRole('button',{name:'在根目录新建',exact:true})).toBeVisible();
  const local=await page.evaluate(async()=>({info:await window.nowenDesktop.getAppInfo(),url:localStorage.getItem('nowen-server-url')}));
  assert.equal(local.info.runtime,'local');assert.ok(local.url.startsWith('http://127.0.0.1:'));assert.notEqual(local.url,server);
  await page.getByText('Offline Previously Unread',{exact:true}).first().click();
  await expect(page.locator('.cm-content').first()).toContainText('unread content survives NAS loss');
  record('NAS stopped: full restart and previously unread note are local',{runtime:local.info.runtime,packaged:await desktop.evaluate(({app})=>app.isPackaged)});
  await page.getByText('Offline Editable',{exact:true}).first().click();
  const editor=page.locator('.cm-content').first();
  await editor.click();await page.keyboard.press('Meta+End');await page.keyboard.type('\noffline acceptance edit');
  await expect(editor).toContainText('offline acceptance edit');
  await expect.poll(async()=>page.evaluate(async id=>{
    const base=localStorage.getItem('nowen-server-url'),token=localStorage.getItem('nowen-token');
    return (await (await fetch(`${base}/api/notes/${id}`,{headers:{Authorization:`Bearer ${token}`}})).json()).content;
  },editable.id)).toContain('offline acceptance edit');
  await desktop.close();desktop=undefined;
  await startDesktop();
  await page.getByText('Offline Editable',{exact:true}).first().click();
  await expect(page.locator('.cm-content').first()).toContainText('offline acceptance edit');
  record('offline edit persisted across another process restart');
  await startNas();
  await expect.poll(async()=> (await api(`/notes/${editable.id}`)).content,{timeout:60_000}).toContain('offline acceptance edit');
  const second=await api('/auth/login',{username:'offline_acceptance',password:'isolated-offline-password'});
  const read=await (await fetch(`${server}/api/notes/${editable.id}`,{headers:{Authorization:`Bearer ${second.token}`}})).json();
  assert.ok(read.content.includes('offline acceptance edit'));
  record('reconnected: independent authenticated service read sees the exact offline edit',{version:read.version});
  await page.screenshot({path:path.join(output,'offline-note.png')});
  report.passed=true;
} catch(error){
  report.error=error instanceof Error?error.message:String(error);
  if(page) report.session=await page.evaluate(async()=>{
    let userId=null;try{userId=JSON.parse(atob((localStorage.getItem('nowen-token')||'').split('.')[1])).userId;}catch{}
    return {serverUrl:localStorage.getItem('nowen-server-url'),hasToken:!!localStorage.getItem('nowen-token'),userId,info:await window.nowenDesktop.getAppInfo()};
  }).catch(()=>null);
  if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  process.exitCode=1;
} finally {
  if(desktop)await desktop.close().catch(()=>stop(desktop.process()));
  await stop(nas);
  let safeLogs=logs;
  for(const secret of [account?.token,account?.refreshToken,'isolated-offline-password'])if(secret)safeLogs=safeLogs.replaceAll(secret,'[redacted]');
  fs.writeFileSync(path.join(output,'runtime.log'),safeLogs);
  report.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  fs.rmSync(directory,{recursive:true,force:true});
  console.log(`[offline-acceptance] ${report.passed?'PASS':'FAIL'} ${path.join(output,'report.json')}`);
}
