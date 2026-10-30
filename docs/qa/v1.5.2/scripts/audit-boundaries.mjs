import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const [checkout, output] = process.argv.slice(2);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-release152-audit-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(temp, 'audit.db');
process.env.ELECTRON_USER_DATA = temp;
process.env.ATTACHMENT_STORAGE = 'local';
process.env.NOWEN_EXTENSIONS_V21 = '1';
process.env.NOWEN_PLUGIN_STUDIO = '1';
const require = createRequire(path.join(checkout, 'backend/package.json'));
const { Hono } = require('hono');
const JSZip = require('jszip');
const moduleAt = (file) => import(pathToFileURL(path.join(checkout, 'backend/src', file)));
const schema = await moduleAt('db/schema.ts');
const notes = await moduleAt('routes/notes.ts');
const trash = await moduleAt('routes/trash.ts');
const attachments = await moduleAt('routes/attachments.ts');
const studio = await moduleAt('routes/plugin-studio.ts');
const studioService = await moduleAt('plugins/studio/projectService.ts');
const db = schema.getDb();
const app = new Hono();
app.route('/api/notes', notes.default);
app.route('/api/trash', trash.default);
app.route('/api/plugins/studio', studio.default);
const report = { checkout, temp, node: process.version, abi: process.versions.modules, authBoundary: 'Router/service harness with synthetic X-User-Id; upstream JWT not exercised', delete: {}, constraint: [], studio: {} };
function save() { fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
async function request(method, url, user = 'qa-owner', body) {
  const res = await app.request(url, { method, headers: { 'X-User-Id': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text=await res.text(); let parsed; try {parsed=JSON.parse(text);} catch {parsed={raw:text};}
  return { status: res.status, body: parsed };
}
function seed(id, locked = 0, trashed = 0) {
  db.prepare(`INSERT INTO notes (id,userId,notebookId,title,content,contentText,contentFormat,isLocked,isTrashed,version) VALUES (?,'qa-owner','qa-book',?,'# audit body','audit body','markdown',?,?,4)`).run(id, id, locked, trashed);
}
function snapshot(id, physical) {
  const count = (table, column) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(id).n;
  return { notes: count('notes', 'id'), histories: count('note_versions', 'noteId'), attachments: count('attachments', 'noteId'), tree: count('knowledge_tree_nodes', 'resourceId'), physicalExists: fs.existsSync(physical), outbox: db.prepare("SELECT entityType,entityId,operation,baseVersion,payload,status FROM sync_outbox WHERE entityId=?").all(id) };
}
try {
  db.prepare("INSERT INTO users (id,username,passwordHash) VALUES (?,?,'fixture-hash')").run('qa-owner','qa-owner');
  db.prepare("INSERT INTO users (id,username,passwordHash) VALUES (?,?,'fixture-hash')").run('qa-other','qa-other');
  db.prepare("INSERT INTO notebooks (id,userId,name) VALUES ('qa-book','qa-owner','QA')").run();
  db.prepare("INSERT INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,bootstrapStatus) VALUES ('qa-profile','QA','http://127.0.0.1:1','qa-owner',1,'ready')").run();
  db.prepare("INSERT OR IGNORE INTO sync_device_identity (singletonKey,deviceId) VALUES (1,'qa-device')").run();
  report.delete.gate = db.prepare('SELECT * FROM sync_v2_should_enqueue').get();
  assert.equal(report.delete.gate.enabled, 1);
  const id = 'qa-live-note'; seed(id);
  db.prepare("INSERT INTO note_versions (id,noteId,userId,title,content,contentText,contentFormat,version) VALUES ('qa-history',?,'qa-owner','Before','# old body','old body','markdown',3)").run(id);
  const relative = 'qa-release/attachment.txt';
  const physical = path.join(attachments.getAttachmentsDir(), relative);
  fs.mkdirSync(path.dirname(physical), { recursive: true }); fs.writeFileSync(physical,'QA attachment bytes');
  db.prepare("INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path) VALUES ('qa-attachment',?,'qa-owner','fixture.txt','text/plain',19,?)").run(id,relative);
  const nodeId = db.prepare("SELECT id FROM knowledge_tree_nodes WHERE resourceId=? AND resourceType='note'").get(id).id;
  // Keep the gate active, discard creation receipts, then inspect only the deletion receipts.
  db.prepare('DELETE FROM sync_outbox').run();
  report.delete.before = snapshot(id, physical);
  report.delete.crossUser = await request('DELETE', '/api/notes/'+id, 'qa-other');
  assert.equal(report.delete.crossUser.status, 403); assert.equal(snapshot(id,physical).notes,1);
  seed('qa-locked',1);
  report.delete.locked = await request('DELETE','/api/notes/qa-locked');
  assert.equal(report.delete.locked.status,403);
  report.delete.liveDelete = await request('DELETE','/api/notes/'+id);
  report.delete.after = snapshot(id, physical);
  assert.equal(report.delete.liveDelete.status,200);
  assert.deepEqual([report.delete.after.notes,report.delete.after.histories,report.delete.after.attachments,report.delete.after.tree,report.delete.after.physicalExists],[0,0,0,0,false]);
  assert.ok(report.delete.after.outbox.some((row)=>row.operation==='delete'&&row.baseVersion===4));
  report.delete.trashList = await request('GET','/api/trash');
  report.delete.restore = await request('POST','/api/trash/batch','qa-owner',{action:'restore',ids:[nodeId]});
  assert.ok(report.delete.restore.body.failures.some((row)=>row.code==='TRASH_ITEM_NOT_FOUND'));
  seed('qa-soft-note');
  report.delete.softDelete = await request('PUT','/api/notes/qa-soft-note','qa-owner',{isTrashed:1});
  report.delete.softRestore = await request('PUT','/api/notes/qa-soft-note','qa-owner',{isTrashed:0});
  assert.equal(report.delete.softDelete.status,200); assert.equal(report.delete.softRestore.status,200);
  assert.equal(db.prepare("SELECT isTrashed FROM notes WHERE id='qa-soft-note'").get().isTrashed,0);
  save();

  // Observe actual SQLite exceptions in the isolated fixture; do not replace business error handling.
  const prepare = db.prepare.bind(db); let errors = [];
  db.prepare = (sql) => { const statement = prepare(sql); const run = statement.run.bind(statement); statement.run = (...args) => { try { return run(...args); } catch(error) { errors.push({ code:error.code, message:error.message }); throw error; } }; return statement; };
  for (const [name, body] of [
    ['missing-notebook',{id:'9fa62171-1000-4000-8000-123456789abc',title:'Missing',contentFormat:'markdown',content:'body'}],
    ['valid-create',{id:'9fa62171-1000-4000-8000-123456789abd',notebookId:'qa-book',title:'Valid',contentFormat:'markdown',content:'body'}],
    ['duplicate-id',{id:'9fa62171-1000-4000-8000-123456789abd',notebookId:'qa-book',title:'Duplicate'}],
    ['nonexistent-notebook',{notebookId:'not-present',title:'Bad notebook'}],
  ]) { errors=[]; const response=await request('POST','/api/notes','qa-owner',body); report.constraint.push({name,response,rawSqlite:errors}); }
  db.prepare = prepare;
  assert.equal(report.constraint[0].response.body.code,'NOTE_ID_CONFLICT');
  assert.equal(report.constraint[1].response.status,201);
  assert.equal(report.constraint[2].response.status,409);
  save();

  const created = await request('POST','/api/plugins/studio/projects','qa-owner',{name:'QA Sandbox'});
  assert.equal(created.status,201); const projectId=created.body.project.id;
  const projectRoot=path.join(temp,'plugin-projects',projectId);
  const external=path.join(temp,'outside.json'); const marker='{"fixtureSecret":"QA_EXTERNAL_CANARY"}'; fs.writeFileSync(external,marker);
  async function read(relative) { return request('GET','/api/plugins/studio/projects/'+projectId+'/files/content?path='+encodeURIComponent(relative)); }
  for(const [label,type] of [['defaultSymlink',undefined],['explicitFileSymlink','file']]) {
    const leaf=label+'.json', link=path.join(projectRoot,leaf);
    try { fs.symlinkSync(external,link,type); const stat=fs.lstatSync(link); const response=await read(leaf); report.studio[label]={isSymbolicLink:stat.isSymbolicLink(),nlink:stat.nlink,response,externalRead:response.body.content===marker}; assert.equal(response.body.code,'PLUGIN_STUDIO_SYMLINK_REJECTED'); assert.notEqual(response.body.content,marker); }
    catch(error) { if(error.code==='EPERM') report.studio[label]={blocked:error.code}; else throw error; }
    finally { if(fs.existsSync(link)) fs.unlinkSync(link); }
  }
  const outsideDir=path.join(temp,'outside-dir');fs.mkdirSync(outsideDir);fs.writeFileSync(path.join(outsideDir,'secret.json'),marker);
  const junction=path.join(projectRoot,'junction');
  fs.symlinkSync(outsideDir,junction,process.platform==='win32'?'junction':'dir');
  report.studio.junction=await read('junction/secret.json'); assert.equal(report.studio.junction.body.code,'PLUGIN_STUDIO_SYMLINK_REJECTED'); fs.unlinkSync(junction);
  const hard=path.join(projectRoot,'hard.json'); fs.linkSync(external,hard);
  report.studio.hardlink={nlink:fs.lstatSync(hard).nlink,response:await read('hard.json')};
  assert.equal(report.studio.hardlink.response.body.content,marker);
  report.studio.crossUser=await request('GET','/api/plugins/studio/projects/'+projectId+'/files/content?path=hard.json','qa-other');assert.equal(report.studio.crossUser.status,403);
  const exported=await app.request('/api/plugins/studio/projects/'+projectId+'/export',{headers:{'X-User-Id':'qa-owner'}});
  const zip=await JSZip.loadAsync(Buffer.from(await exported.arrayBuffer()));
  report.studio.hardlinkExport={status:exported.status,externalBytesIncluded:(await zip.file('hard.json').async('string'))===marker};assert.equal(report.studio.hardlinkExport.externalBytesIncluded,true);
  report.studio.traversal=await read('../outside.json');assert.equal(report.studio.traversal.body.code,'PLUGIN_STUDIO_PATH_TRAVERSAL');
  report.studio.disallowedType=await request('PUT','/api/plugins/studio/projects/'+projectId+'/files/content','qa-owner',{path:'.env',content:'QA=1',expectedRevision:1});assert.equal(report.studio.disallowedType.body.code,'PLUGIN_STUDIO_FILE_TYPE_NOT_ALLOWED');
  const service=studioService.getPluginStudioProjectService(); const symlinkZip=new JSZip();symlinkZip.file('zip-link.json',external,{unixPermissions:0o120777});
  const imported=await service.importProject({userId:'qa-owner',isAdmin:false},{name:'Link archive',archive:await symlinkZip.generateAsync({type:'nodebuffer',platform:'UNIX'})});
  report.studio.zipLink={isSymbolicLink:fs.lstatSync(path.join(temp,'plugin-projects',imported.id,'zip-link.json')).isSymbolicLink(),content:service.readFile({userId:'qa-owner',isAdmin:false},imported.id,'zip-link.json').content};
  assert.equal(report.studio.zipLink.isSymbolicLink,false);assert.notEqual(report.studio.zipLink.content,marker);
  // Deterministic local interposition at the check/open boundary, not a remote exploit.
  const race=path.join(projectRoot,'race.json');fs.writeFileSync(race,'{}');
  const resolve=service.paths.resolveFile.bind(service.paths);
  service.paths.resolveFile=(...args)=>{const result=resolve(...args);if(args[1]==='race.json'){fs.unlinkSync(result);fs.symlinkSync(external,result,'file');}return result;};
  try { report.studio.forcedCheckOpenSwap={kind:'local deterministic service interposition; no concurrent/remote exploit claim',content:service.readFile({userId:'qa-owner',isAdmin:false},projectId,'race.json').content};assert.equal(report.studio.forcedCheckOpenSwap.content,marker); }
  finally {service.paths.resolveFile=resolve;fs.unlinkSync(race);}
  save();
  schema.closeDb();
  const reopened=schema.getDb();report.delete.afterReopen={noteRows:reopened.prepare("SELECT count(*) AS n FROM notes WHERE id='qa-live-note'").get().n,historyRows:reopened.prepare("SELECT count(*) AS n FROM note_versions WHERE noteId='qa-live-note'").get().n};assert.equal(report.delete.afterReopen.noteRows,0);save();
  console.log(JSON.stringify({result:'audit observations reproduced',output}));
} catch(error) { report.harnessError={message:error.message,stack:error.stack};save();throw error; }
finally {schema.closeDb();}
// Fixture retained for inspection. Nothing outside the new temp directory is deleted.
