import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Hono } from "hono";

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"nowen-asset-desktop-"));
process.env.DB_PATH=path.join(temp,"server.db");process.env.ELECTRON_USER_DATA=temp;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2="1";
const USER="asset-desktop-owner";
const locals:Database.Database[]=[];

test.after(async()=>{
  for(const db of locals) db.close();
  (await import("../src/db/schema")).closeDb();fs.rmSync(temp,{recursive:true,force:true});
});

test("desktop directory CRUD captures durable organization mutations and converges through real Sync V2 routes",async()=>{
  const {getDb}=await import("../src/db/schema");
  const {createProfile,switchActiveProfile}=await import("../src/sync/profile");
  const {ensureDevice}=await import("../src/sync/device");
  const {SyncEngine}=await import("../src/sync/engine");
  const {SyncRemoteClient}=await import("../src/sync/remote");
  const {default:routes}=await import("../src/routes/sync-v2");
  const server=getDb();server.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'x')").run(USER,USER);
  server.prepare("INSERT INTO attachment_folders(id,userId,name) VALUES ('server-folder',?,'Server folder')").run(USER);
  await server.backup(path.join(temp,"desktop.db"));
  const local=new Database(path.join(temp,"desktop.db"));locals.push(local);local.pragma("foreign_keys=ON");
  const profile=createProfile(local,{name:"Asset desktop",serverUrl:"http://asset-sync.test"});switchActiveProfile(local,profile.id);
  local.prepare("UPDATE sync_profiles SET remoteUserId=?,bootstrapStatus='ready' WHERE id=?").run(USER,profile.id);
  const device=ensureDevice(local,{profileId:profile.id});
  const app=new Hono();app.use('*',async(c,next)=>{c.req.raw.headers.set("X-User-Id",USER);await next();});app.route('/api/sync/v2',routes);
  let offline=false,loseAssetAck=true;
  local.prepare("INSERT INTO attachment_folders(id,userId,name) VALUES ('desktop-before-binding',?,'Existing local asset folder')").run(USER);
  const remote=new SyncRemoteClient({serverUrl:"http://asset-sync.test",token:"fixture"},{fetchImpl:async(url,init)=>{
    if(offline) throw new Error("offline fixture");
    const response=await app.request(url,init);
    if(loseAssetAck && url.includes("/ack?") && url.includes("attachment_organization")) {loseAssetAck=false;throw new Error("initial asset ACK lost");}
    return response;
  }});
  const engine=new SyncEngine({db:local,profileId:profile.id,deviceId:device.id,userId:USER,client:remote,intervalMs:0,scheduler:{setTimeout:()=>0,clearTimeout:()=>{}}});
  try{
    let status=await engine.syncOnce();assert.equal(status.state,"offline");
    assert.equal((local.prepare("SELECT ready FROM asset_sync_bindings WHERE profileId=?").get(profile.id) as {ready:number}).ready,0);
    const bindingIntents=local.prepare("SELECT mutationId FROM sync_outbox WHERE entityType='attachment_organization'").all();assert.equal(bindingIntents.length,1);
    status=await engine.syncOnce();assert.equal(status.lastError,null,JSON.stringify(status));
    assert.equal((server.prepare("SELECT COUNT(*) AS count FROM sync_v2_applied_mutations WHERE entityType='attachment_organization' AND entityId='folder:desktop-before-binding'").get() as {count:number}).count,1);
    assert.equal((local.prepare("SELECT ready FROM asset_sync_bindings WHERE profileId=?").get(profile.id) as {ready:number}).ready,1);
    local.prepare("INSERT INTO attachment_folders(id,userId,name,parentId) VALUES ('desktop-child',?,'Local child','server-folder')").run(USER);
    local.prepare("UPDATE attachment_folders SET name='Renamed before sync' WHERE id='desktop-child'").run();
    const queued=local.prepare("SELECT mutationId,payload,baseVersion FROM sync_outbox WHERE entityType='attachment_organization' ORDER BY rowid").all();assert.equal(queued.length,2);
    offline=true;status=await engine.syncOnce();assert.equal(status.state,"offline");
    assert.deepEqual(local.prepare("SELECT mutationId,payload,baseVersion FROM sync_outbox WHERE entityType='attachment_organization' ORDER BY rowid").all(),queued);
    offline=false;status=await engine.syncOnce();assert.equal(status.lastError,null,JSON.stringify(status));
    assert.equal((server.prepare("SELECT name FROM attachment_folders WHERE id='desktop-child'").get() as {name:string}).name,"Renamed before sync");
    assert.equal((local.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType='attachment_organization'").get() as {count:number}).count,0);
    server.prepare("UPDATE attachment_folders SET parentId=NULL,name='Moved on Web' WHERE id='desktop-child'").run();
    status=await engine.syncOnce();assert.equal(status.lastError,null);
    assert.deepEqual(local.prepare("SELECT name,parentId FROM attachment_folders WHERE id='desktop-child'").get(),{name:"Moved on Web",parentId:null});
    local.prepare("DELETE FROM attachment_folders WHERE id='desktop-child'").run();status=await engine.syncOnce();assert.equal(status.lastError,null);
    assert.equal(server.prepare("SELECT 1 FROM attachment_folders WHERE id='desktop-child'").get(),undefined);
    assert.equal((server.prepare("SELECT json_extract(payload,'$.deleted') AS deleted FROM asset_sync_metadata WHERE id='folder:desktop-child'").get() as {deleted:number}).deleted,1);
  }finally{engine.stop();}
});

test("asset migration preserves queue order, failed retry state, conflict history and the feed high-water mark",async()=>{
  const {getDb}=await import("../src/db/schema");const {assetSyncMigration}=await import("../src/db/assetSyncMigration");
  const server=getDb();await server.backup(path.join(temp,"migration.db"));
  const db=new Database(path.join(temp,"migration.db"));locals.push(db);db.pragma("foreign_keys=ON");
  const {createProfile,switchActiveProfile}=await import("../src/sync/profile");
  const {ensureDevice}=await import("../src/sync/device");
  const profile=createProfile(db,{name:"Migration",serverUrl:"http://migration.test"});switchActiveProfile(db,profile.id);const device=ensureDevice(db,{profileId:profile.id});
  db.prepare(`INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,entityType,entityId,operation,status,retryCount,lastError)
    VALUES ('old-1','old-mutation-1',?,?,'note','retained','upsert','failed',7,'NETWORK_UNAVAILABLE')`).run(profile.id,device.id);
  db.prepare(`INSERT INTO sync_conflicts(id,profileId,entityType,entityId,localPayload,remotePayload,status,resolvedAt)
    VALUES ('old-conflict',?,'note','retained','{"content":"left"}','{"content":"right"}','resolved','resolved-time')`).run(profile.id);
  db.prepare("DELETE FROM sync_changes_v2 WHERE entityType='attachment_organization'").run();
  // Exercise v128's actual CHECK constraints again rather than only fresh v129 tables.
  const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as {name:string;sql:string}[];
  for(const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  for(const table of ['sync_outbox','sync_conflicts','sync_changes_v2']) {
    const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string}).sql;
    const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table) as {sql:string}[];
    db.exec(sql.replace(/CREATE TABLE\s+(?:"[^"]+"|\w+)/i,`CREATE TABLE ${table}_old`).replace(", 'attachment_organization'",''));
    db.exec(`INSERT INTO ${table}_old SELECT * FROM ${table} ORDER BY rowid; DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table}`);
    for(const index of indexes) db.exec(index.sql);
  }
  for(const t of triggers) if(!t.name.startsWith('asset_sync_')) db.exec(t.sql);
  db.prepare("UPDATE sqlite_sequence SET seq=999999 WHERE name='sync_changes_v2'").run();
  const beforeQueue=db.prepare("SELECT * FROM sync_outbox ORDER BY rowid").all(),beforeConflicts=db.prepare("SELECT * FROM sync_conflicts ORDER BY rowid").all();
  db.transaction(()=>assetSyncMigration.up(db))();db.transaction(()=>assetSyncMigration.up(db))();
  assert.deepEqual(db.prepare("SELECT * FROM sync_outbox ORDER BY rowid").all(),beforeQueue);
  assert.deepEqual(db.prepare("SELECT * FROM sync_conflicts ORDER BY rowid").all(),beforeConflicts);
  assert.deepEqual(db.pragma("foreign_key_check"),[]);
  db.prepare("INSERT INTO attachment_folders(id,userId,name) VALUES ('after-migration',?,'After migration')").run(USER);
  assert.ok((db.prepare("SELECT MAX(sequence) AS sequence FROM sync_changes_v2").get() as {sequence:number}).sequence>999999);
});

test("directory routes reject signed-in writes until their exact profile has completed organization binding",async()=>{
  const {getDb}=await import("../src/db/schema");const db=getDb();
  const {createProfile}=await import("../src/sync/profile");const {ensureDevice}=await import("../src/sync/device");
  const {default:folders}=await import("../src/routes/attachment-folders");
  const profile=createProfile(db,{name:"Old remote",serverUrl:"http://old-remote.test"});
  db.prepare("UPDATE sync_profiles SET enabled=1,remoteUserId=?,bootstrapStatus='ready' WHERE id=?").run(USER,profile.id);ensureDevice(db,{profileId:profile.id});
  const app=new Hono();app.use('*',async(c,next)=>{c.req.raw.headers.set("X-User-Id",USER);await next();});app.route('/folders',folders);
  try{
    assert.equal(((await (await app.request('/folders')).json()) as {supported:boolean}).supported,false);
    const denied=await app.request('/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Unbound write'})});
    assert.equal(denied.status,409);assert.equal((await denied.json() as {code:string}).code,'ATTACHMENT_FOLDER_SYNC_NOT_READY');
    assert.equal(db.prepare("SELECT 1 FROM attachment_folders WHERE name='Unbound write'").get(),undefined);
    db.prepare("INSERT INTO asset_sync_bindings(profileId,userId,ready) VALUES (?,?,1)").run(profile.id,USER);
    const created=await app.request('/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Bound write'})});assert.equal(created.status,201);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE profileId=? AND entityType='attachment_organization'").get(profile.id) as {count:number}).count,1);
  }finally{db.prepare("UPDATE sync_profiles SET enabled=0 WHERE id=?").run(profile.id);}
});

test("incoming trash visibility cannot reopen a previously public link after restoration",async()=>{
  const {getDb}=await import("../src/db/schema");await getDb().backup(path.join(temp,'policy.db'));
  const db=new Database(path.join(temp,'policy.db'));locals.push(db);db.pragma('foreign_keys=ON');
  (await import("../src/lib/searchIndex")).ensureNormalizedSearchFts(db);
  const {setAttachmentExternalAccessEnabled}=await import('../src/services/attachment-link-policy');
  const {applyAssetMetadataLocal,readAssetMetadata}=await import('../src/sync/assetOrganization');
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('policy-book',?,'Policy')").run(USER);
  db.prepare("INSERT INTO notes(id,userId,notebookId,title,content) VALUES ('policy-note',?,'policy-book','Policy','{}')").run(USER);
  db.prepare("INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,path,hash) VALUES ('policy-file','policy-note',?,'kept.txt','text/plain',5,'kept-path','kept-hash')").run(USER);
  setAttachmentExternalAccessEnabled('policy-file',true,db);
  const payload=readAssetMetadata(db,'file:policy-file',USER)!;
  applyAssetMetadataLocal(db,[{...payload,version:2,trashedAt:'server-trash'}],USER);
  applyAssetMetadataLocal(db,[{...payload,version:3,trashedAt:null}],USER);
  assert.deepEqual(db.prepare("SELECT path,hash,trashedAt FROM attachments WHERE id='policy-file'").get(),{path:'kept-path',hash:'kept-hash',trashedAt:null});
  assert.equal((db.prepare("SELECT externalAccessEnabled FROM attachment_link_policies WHERE attachmentId='policy-file'").get() as {externalAccessEnabled:number}).externalAccessEnabled,0);
});
