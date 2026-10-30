import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { Hono } from "hono";

let app: Hono;
let db: ReturnType<typeof import("../src/db/schema").getDb>;
let schema: typeof import("../src/db/schema");
let originalFetch: typeof fetch;
let output: unknown;
let vectorOutput: unknown;
let calls: Array<{url:string;body:Record<string,unknown>;headers:Headers}>;
let mutateDuringAI: (() => void) | undefined;
const suggestion = (id="a-one") => ({id,folderId:null,newFolderName:"Learning",tags:["Reference"],description:"A reference PDF, inferred from its filename.",reason:"Metadata only"});
const request = (path:string,body?:unknown,user="ai-owner",workspace="personal",extra:Record<string,string>={}) => app.request(`/api/files/ai${path}?workspaceId=${workspace}`,{
  method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json","X-User-Id":user,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),
});
async function json(response:Promise<Response>,status=200) {
  const result=await response;
  assert.equal(result.status,status,await result.clone().text());
  return result.json();
}
const preview = (ids=["a-one"],extra={}) => request("/preview",{ids,consent:true,...extra});
async function items(ids=["a-one"]) {
  output={items:ids.map(id=>suggestion(id))};
  const result=await json(preview(ids));
  return result.items.map(({filename: _filename,...item}:Record<string,unknown>)=>item);
}
const apply = (items:unknown[],requestId=crypto.randomUUID(),extra={}) => request("/confirm",{confirmed:true,requestId,items,...extra});
const snapshot = () => JSON.stringify(["attachments","attachment_folders","asset_tags","asset_tag_relations","asset_descriptions","asset_ai_batches","sync_outbox"].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

test.before(async()=>{
  schema=await import("../src/db/schema"); db=schema.getDb();
  for(const id of ["ai-owner","ai-other","ai-viewer"]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'hash')").run(id,id);
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('ai-book','ai-owner','Private note title')").run();
  db.prepare("INSERT INTO notes(id,userId,notebookId,title,content) VALUES ('ai-note','ai-owner','ai-book','Private note title','DO NOT SEND NOTE CONTENT')").run();
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES ('ai-team','Team','ai-owner')").run();
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('ai-team','ai-owner','owner'),('ai-team','ai-viewer','viewer')").run();
  const settings=await import("../src/services/user-ai-settings");
  settings.setUserAISettings("ai-owner",[{key:"ai_api_url",value:"https://asset-ai.test/v1"},{key:"ai_api_key",value:"owner-key"},{key:"ai_model",value:"owner-model"},{key:"ai_embedding_model",value:"metadata-model"}]);
  const {default:files}=await import("../src/routes/files");
  const {wrapKnowledgeRoute}=await import("../src/runtime/knowledge-tree");
  app=new Hono().route("/api/files",wrapKnowledgeRoute("/api/files",files));
  originalFetch=globalThis.fetch;
});
test.beforeEach(()=>{
  db.exec("DELETE FROM notebook_passwords; DELETE FROM sync_outbox; DELETE FROM sync_profiles; DELETE FROM asset_ai_batches; DELETE FROM attachments; DELETE FROM asset_tags; DELETE FROM attachment_folders; UPDATE notes SET isLocked=0;");
  const insert=db.prepare("INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,path,uploadSource,workspaceId) VALUES (?,'ai-note',?,?,'application/pdf',100,'PRIVATE/STORAGE/PATH','file_manager',?)");
  for(const [id,user,name,scope] of [["a-one","ai-owner","Research.pdf",null],["b-two","ai-owner","Screenshots.pdf",null],["hidden","ai-other","Other private file",null],["team-file","ai-owner","Team.pdf","ai-team"]]) insert.run(id,user,name,scope);
  calls=[]; output={items:[suggestion()]}; vectorOutput=undefined; mutateDuringAI=undefined;
  globalThis.fetch=(async(input:unknown,init:RequestInit)=>{
    const url=String(input),body=JSON.parse(String(init.body));
    calls.push({url,body,headers:new Headers(init.headers)}); mutateDuringAI?.();
    if(url.endsWith("/embeddings")) return new Response(JSON.stringify(vectorOutput || {data:body.input.map((_:string,index:number)=>({index,embedding:index===2?[0,1]:[1,0]}))}));
    return new Response(JSON.stringify({choices:[{message:{content:typeof output==="string"?output:JSON.stringify(output)}}]}));
  }) as typeof fetch;
});
test.afterEach(()=>{globalThis.fetch=originalFetch;});
test.after(()=>{schema.closeDb();});

test("AI preview is read-only and sends only selected authorized metadata using the owner's settings",async()=>{
  const before=snapshot(); const result=await json(preview());
  assert.equal(result.items[0].filename,"Research.pdf"); assert.equal(snapshot(),before);
  assert.equal(calls[0].headers.get("Authorization"),"Bearer owner-key"); assert.equal(calls[0].body.model,"owner-model");
  const payload=JSON.stringify(calls);
  for(const secret of ["Other private file","DO NOT SEND NOTE CONTENT","PRIVATE/STORAGE/PATH","Private note title"]) assert.ok(!payload.includes(secret));
});
test("consent, authentication, restricted tokens, scope and protected files fail before the model is called",async()=>{
  await json(preview(["hidden"]),404);
  await json(request("/preview",{ids:["a-one"],consent:false}),400);
  await json(request("/preview",{ids:["a-one"],consent:true},""),401);
  await json(request("/preview",{ids:["a-one"],consent:true},"ai-viewer","ai-team"),404);
  await json(request("/preview",{ids:["a-one"],consent:true},"ai-other","ai-team"),403);
  await json(request("/preview",{ids:["a-one"],consent:true},"ai-owner","personal",{"X-Api-Resource-Mode":"restricted"}),403);
  db.prepare("UPDATE notes SET isLocked=1 WHERE id='ai-note'").run();
  await json(preview(),403); assert.equal(calls.length,0);
});
test("invalid, destructive, duplicate and unselected model operations cannot become a plan",async()=>{
  for(const value of ["broken JSON",{items:[]},{items:[{...suggestion(),delete:true}]},{items:[suggestion("hidden")]},{items:[suggestion(),suggestion()]},{items:[{...suggestion(),folderId:"foreign",newFolderName:null}]}]){
    output=value; await json(preview(),typeof value==="object" && "items" in value && value.items[0]?.folderId==="foreign"?400:502);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM asset_ai_batches").get().n,0);
});
test("permissions and metadata are checked again after asynchronous generation",async()=>{
  mutateDuringAI=()=>db.prepare("UPDATE attachments SET filename='Changed.pdf' WHERE id='a-one'").run();
  await json(preview(),409);
  mutateDuringAI=()=>db.prepare("UPDATE notes SET isLocked=1 WHERE id='ai-note'").run();
  output={items:[suggestion("b-two")]};
  await json(preview(["b-two"]),403);
});
test("confirmed plans atomically add tags, describe files, create folders and keep attachment identity and storage",async()=>{
  const plan=await items(); const before=db.prepare("SELECT id,path,noteId,hash FROM attachments WHERE id='a-one'").get();
  const result=await json(apply(plan)); assert.equal(result.updated,1);
  assert.deepEqual(db.prepare("SELECT id,path,noteId,hash FROM attachments WHERE id='a-one'").get(),before);
  assert.equal(db.prepare("SELECT name FROM attachment_folders").get().name,"Learning");
  assert.equal(db.prepare("SELECT count(*) n FROM asset_tag_relations").get().n,1);
  assert.equal((await json(request("/metadata/a-one"))).description,suggestion().description);
});
test("editable plans may exclude files and use an existing destination",async()=>{
  const plan=await items(["a-one","b-two"]);
  db.prepare("INSERT INTO attachment_folders(id,userId,name) VALUES ('existing','ai-owner','Existing')").run();
  plan[0]={...plan[0],folderId:"existing",newFolderName:null,tags:["Edited"],description:"Edited description"};
  await json(apply([plan[0]]));
  assert.equal(db.prepare("SELECT folderId FROM attachments WHERE id='a-one'").get().folderId,"existing");
  assert.equal(db.prepare("SELECT folderId FROM attachments WHERE id='b-two'").get().folderId,null);
});
test("stale snapshots, changed ACL and invalid batch members leave all files untouched",async()=>{
  const plan=await items(["a-one","b-two"]);
  db.prepare("UPDATE attachments SET filename='New.pdf' WHERE id='b-two'").run();
  let before=snapshot(); await json(apply(plan),409); assert.equal(snapshot(),before);
  before=snapshot(); await json(apply([plan[0],{...plan[1],id:"hidden"}]),404); assert.equal(snapshot(),before);
  db.prepare("UPDATE notes SET isLocked=1 WHERE id='ai-note'").run();
  before=snapshot(); await json(apply([plan[0]]),403); assert.equal(snapshot(),before);
});
test("a database failure rolls back metadata, folders, tags, result records and existing Outbox",async()=>{
  const {createProfile}=await import("../src/sync/profile");
  const {ensureDevice}=await import("../src/sync/device");
  const {enqueueMutation}=await import("../src/sync/outbox");
  const profile=createProfile(db,{name:"Disabled sync preserves queued work",serverUrl:"http://queue.test"});
  const device=ensureDevice(db,{profileId:profile.id});
  enqueueMutation(db,{profileId:profile.id,deviceId:device.id,scopeKey:"personal",entityType:"note",entityId:"ai-note",operation:"upsert",baseVersion:0,payload:{id:"ai-note",content:"Pending draft"}});
  const plan=await items(["a-one","b-two"]); const before=snapshot();
  db.exec("CREATE TEMP TRIGGER fail_asset_description BEFORE INSERT ON asset_descriptions WHEN NEW.attachmentId='b-two' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
  try {await json(apply(plan),502); assert.equal(snapshot(),before);} finally {db.exec("DROP TRIGGER fail_asset_description");}
});
test("workspace suggestions keep scope, forbid viewers and never create personal folders",async()=>{
  output={items:[{...suggestion("team-file"),newFolderName:null}]};
  const result=await json(request("/preview",{ids:["team-file"],consent:true},"ai-owner","ai-team"));
  const payload=result.items.map(({filename: _filename,...item}:Record<string,unknown>)=>item);
  await json(request("/confirm",{confirmed:true,requestId:crypto.randomUUID(),items:payload},"ai-viewer","ai-team"),404);
  await json(request("/confirm",{confirmed:true,requestId:crypto.randomUUID(),items:payload},"ai-owner","ai-team"));
  assert.equal(db.prepare("SELECT workspaceId FROM asset_tags").get().workspaceId,"ai-team");
  assert.equal(db.prepare("SELECT count(*) n FROM attachment_folders").get().n,0);
  await json(request("/metadata/team-file",undefined,"ai-owner","personal"),404);
});
test("semantic pagination exposes only eligible file cursors and bounds each provider batch",async()=>{
  const insert=db.prepare("INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,path,uploadSource) VALUES (?,'ai-note','ai-owner',?,'text/plain',1,'test','file_manager')");
  for(let index=0;index<103;index++) insert.run("p-"+String(index).padStart(3,"0"),"Metadata "+index);
  const first=await json(request("/search",{query:"research",consent:true}));
  assert.equal(first.examined,100);assert.equal((calls[0].body.input as string[]).length,101);assert.ok(first.nextAfter);
  const second=await json(request("/search",{query:"research",consent:true,after:first.nextAfter}));
  assert.equal(second.nextAfter,null);assert.equal(first.matches.length+second.matches.length,105);
  assert.equal(new Set([...first.matches,...second.matches].map(item=>item.id)).size,105);
});
test("unavailable Embedding and upstream failures do not write metadata or expose provider secrets",async()=>{
  const {setUserAISetting}=await import("../src/services/user-ai-settings");
  setUserAISetting("ai-owner","ai_embedding_model","");
  try {await json(request("/search",{query:"research",consent:true}),400);assert.equal(calls.length,0);}
  finally {setUserAISetting("ai-owner","ai_embedding_model","metadata-model");}
  const before=snapshot();globalThis.fetch=async()=>{throw new Error("private-provider-token");};
  const result=await json(preview(),502);assert.ok(!JSON.stringify(result).includes("private-provider-token"));assert.equal(snapshot(),before);
});
test("description migration preserves existing attachments and cascades only on actual file deletion",async()=>{
  const plan=await items();await json(apply(plan));const current=schema.getDb();
  const {assetAIMigration}=await import("../src/db/assetAIMigration");assetAIMigration.up(current);
  assert.equal(current.prepare("SELECT count(*) n FROM attachments").get().n,4);
  current.prepare("DELETE FROM attachments WHERE id='a-one'").run();
  assert.equal(current.prepare("SELECT count(*) n FROM asset_descriptions").get().n,0);
  assert.equal(current.prepare("SELECT count(*) n FROM attachments").get().n,3);
});
test("folder-password protection is enforced before metadata leaves the server",async()=>{
  db.prepare("INSERT INTO notebook_passwords(notebookId,passwordHash,passwordVersion) VALUES ('ai-book','hash',1)").run();
  await json(preview(),403);assert.equal(calls.length,0);
  const result=await json(request("/search",{query:"research",consent:true}));assert.deepEqual(result.matches,[]);assert.equal(calls.length,0);
});
test("file scope transfers cannot expose a description from its previous owner or workspace",async()=>{
  await json(apply(await items()));
  db.prepare("UPDATE attachments SET workspaceId='ai-team' WHERE id='a-one'").run();
  assert.equal((await json(request("/metadata/a-one",undefined,"ai-viewer","ai-team"))).description,"");
  assert.equal(db.prepare("SELECT count(*) n FROM asset_descriptions").get().n,0);
});
test("confirmation retries are persistent and payload conflicts or revoked access cannot replay results",async()=>{
  const plan=await items(); const requestId=crypto.randomUUID();
  await json(apply(plan,requestId)); const before=snapshot();
  schema.closeDb(); db=schema.getDb();
  const repeated=await json(apply(plan,requestId)); assert.equal(repeated.replayed,true); assert.equal(snapshot(),before);
  await json(apply([{...plan[0],description:"Different"}],requestId),409);
  db.prepare("UPDATE notes SET isLocked=1 WHERE id='ai-note'").run(); await json(apply(plan,requestId),403);
});
test("desktop sync refuses unsynced AI metadata writes rather than claiming success",async()=>{
  const plan=await items();
  db.prepare("INSERT INTO sync_profiles(id,name,serverUrl,enabled) VALUES ('ai-sync','Sync','http://sync.test',1)").run();
  const before=snapshot(); await json(apply(plan),409); assert.equal(snapshot(),before);
  const count=calls.length;await json(preview(),409);assert.equal(calls.length,count);
});
test("semantic metadata search reuses Embedding configuration, ranks by meaning and sends no binary or note content",async()=>{
  const result=await json(request("/search",{query:"research material",consent:true}));
  assert.equal(result.matches[0].id,"a-one"); assert.equal(result.matches.length,2);
  assert.equal(calls[0].body.model,"metadata-model"); assert.equal(calls[0].headers.get("Authorization"),"Bearer owner-key");
  assert.ok(!JSON.stringify(calls).includes("PRIVATE/STORAGE")); assert.ok(!JSON.stringify(calls).includes("Other private file"));
});
test("invalid vectors and protected or changed search candidates never produce stale results",async()=>{
  vectorOutput={data:[{embedding:[1,0]},{embedding:[0]},{embedding:[1,0]}]};
  await json(request("/search",{query:"research",consent:true}),502);
  vectorOutput=undefined; mutateDuringAI=()=>db.prepare("UPDATE notes SET isLocked=1 WHERE id='ai-note'").run();
  const result=await json(request("/search",{query:"research",consent:true})); assert.deepEqual(result.matches,[]);
});
test("missing AI settings preserve ordinary search by filename, tag and description",async()=>{
  const {setUserAISetting}=await import("../src/services/user-ai-settings");
  setUserAISetting("ai-owner","ai_manual_enabled","false");
  try {await json(preview(),400);await json(request("/search",{query:"research",consent:true}),400);assert.equal(calls.length,0);}
  finally {setUserAISetting("ai-owner","ai_manual_enabled","true");}
  db.prepare("INSERT INTO asset_descriptions(attachmentId,description) VALUES ('a-one','unique-description')").run();
  db.prepare("INSERT INTO asset_tags(id,userId,name,normalizedName) VALUES ('search-tag','ai-owner','unique-tag','unique-tag')").run();
  db.prepare("INSERT INTO asset_tag_relations(attachmentId,tagId) VALUES ('a-one','search-tag')").run();
  for(const q of ["Research","unique-description","unique-tag"]) {
    const result=await app.request("/api/files?q="+q,{headers:{"X-User-Id":"ai-owner"}});
    assert.equal(result.status,200);assert.equal((await result.json()).items[0].id,"a-one");
  }
});
