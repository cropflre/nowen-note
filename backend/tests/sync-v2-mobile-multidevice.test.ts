import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { NativeLocalRepository } from "../../frontend/src/lib/nativeLocalRepository";
import { MobileSyncEngine } from "../../frontend/src/lib/mobileSyncEngine";
import { NATIVE_TASK_REPEAT_COLUMNS } from "../../frontend/src/lib/nativeTaskFields";
import type { NativeDatabase } from "../../frontend/src/lib/nativeDatabase";
import { NATIVE_TASK_DELETION_STATEMENTS } from "../../frontend/src/lib/nativeTaskRecurrenceDeletion";
import { nativeReceiptKey, readNativeNoteSyncReceipt } from "../../frontend/src/lib/mobileNoteSyncReceipt";
import { applyNativePersonalTree } from "../../frontend/src/lib/nativeKnowledgeTreeSync";
import { readMobileOfflineReadiness } from '../../frontend/src/lib/mobileOfflineReadiness';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-multidevice-"));
process.env.DB_PATH = path.join(tmpDir, "server.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";
const browser = new EventTarget();
Object.assign(globalThis, { window: browser });
const scope = { scopeKey: "personal", workspaceId: null, workspaceName: null, role: "owner", canWrite: true, accessFingerprint: "personal:owner" };
const USER = "multidevice-user";
let serverDb: Database.Database;
let closeServerDb: () => void;
let httpServer: ReturnType<typeof serve>;
let serverUrl: string;
const clients: Client[] = [];
let syncDiagnostics = 0;
let afterPush: ((response: Response) => Promise<Response>) | undefined;
let afterSnapshot: ((response: Response) => Promise<Response>) | undefined;
let afterAck: ((response: Response) => Promise<Response>) | undefined;
let legacyTaskCapabilities = false;
let legacyNoteDeletionCapabilities = false;

// The real native schema, with independent on-disk SQLite databases. The adapter
// serializes transactions just like NativeDatabaseImpl; no shared client state.
function openClientDb(file: string): NativeDatabase {
  const raw = new Database(file);
  raw.pragma("foreign_keys = ON");
  const source = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/lib/nativeDatabase.ts"), "utf8");
  const scopeCheck = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const entityTypes = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1];
  for (const [, sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    raw.exec(sql.replaceAll("${SCOPE_CHECK}", scopeCheck).replaceAll("${ENTITY_TYPE_CHECK}", entityTypes));
  }
  const taskColumns = new Set((raw.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(column => column.name));
  for (const [field, type] of Object.entries(NATIVE_TASK_REPEAT_COLUMNS)) {
    if (!taskColumns.has(field)) raw.exec(`ALTER TABLE tasks ADD COLUMN ${field} ${type}`);
  }
  for (const statement of NATIVE_TASK_DELETION_STATEMENTS) raw.exec(statement);
  let queue = Promise.resolve();
  const schedule = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const tx: NativeDatabase = {
    async run(sql, values = []) { const result = raw.prepare(sql).run(...values); return { changes: result.changes }; },
    async query<T>(sql: string, values: unknown[] = []) { return raw.prepare(sql).all(...values) as T[]; },
    async transaction(work) { return work(tx); },
    async close() { raw.close(); },
  };
  return {
    run: (sql, values) => schedule(() => tx.run(sql, values)),
    query: <T>(sql: string, values?: unknown[]) => schedule(() => tx.query<T>(sql, values)),
    transaction: (work) => schedule(async () => {
      raw.exec("BEGIN IMMEDIATE");
      try { const result = await work(tx); raw.exec("COMMIT"); return result; }
      catch (error) { raw.exec("ROLLBACK"); throw error; }
    }),
    close: () => schedule(() => tx.close()),
  };
}

interface Client {
  db: NativeDatabase;
  file: string;
  repository: NativeLocalRepository;
  engine: MobileSyncEngine;
  profileId: string;
  removedFiles: string[];
  sync(): Promise<void>;
}
async function client(name: string): Promise<Client> {
  const file = path.join(tmpDir, `${name}.db`);
  const db = openClientDb(file);
  const profileId = `profile-${name}`;
  await db.run(`INSERT OR IGNORE INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
    VALUES (?,?,?, ?,1,'now','now')`, [profileId, name, serverUrl, USER]);
  await db.run("INSERT OR IGNORE INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES (?,?,'android','now')", [profileId, name]);
  const repository = new NativeLocalRepository({ db, attachments: {} as never, accountId: name, userId: USER, getScopeKey: () => "personal" });
  const removedFiles: string[] = [];
  const engine = new MobileSyncEngine({ db, attachments: { remove: async (id: string) => { removedFiles.push(id); } } as never, profileId, deviceId: name, serverUrl, token: USER, userId: USER });
  const result = { db, file, repository, engine, profileId, removedFiles, async sync() {
    engine.start();
    try {
      await engine.syncOnce();
      // The engine deliberately reports scope failures in durable lastError
      // instead of rejecting. Print bounded, credential-free diagnostics when
      // the test observes an unsuccessful sync, without changing test outcomes.
      const diagnostics = await db.query<{ scopeKey: string; lastError: string; lastSequence: number }>(
        "SELECT scopeKey,lastError,lastSequence FROM sync_state WHERE profileId=? AND lastError IS NOT NULL", [profileId],
      );
      if (diagnostics.length && syncDiagnostics < 12) {
        syncDiagnostics++;
        console.error("[multidevice-sync-diagnostic]", JSON.stringify({ client: name, diagnostics }));
      }
    } finally { engine.stop(); }
  } };
  clients.push(result);
  return result;
}
test('DCC-005: native offline availability checks actual files without treating local edits as server ACKs', async () => {
  const c = await client('offline-availability');
  await c.sync();
  const book = randomUUID(), note = randomUUID(), attachment = randomUUID();
  await c.repository.notebooks.create({id:book,name:'Offline'});
  await c.repository.notes.create({id:note,notebookId:book,content:'local unsent body'});
  await c.db.run(`INSERT INTO attachments(id,scopeKey,noteId,userId,filename,mimeType,size,available,localPath,transferStatus,createdAt,updatedAt)
    VALUES (?,'personal',?,?,'file','text/plain',3,1,'local-file','pending_upload','now','now')`, [attachment,note,USER]);
  const store = { stat: async () => ({size:3,sha256:'abc'}) };
  const before = await pending(c);
  const ready = await readMobileOfflineReadiness(c.db,store as never,c.profileId,USER);
  assert.equal(ready.contentState,'ready');
  assert.equal(ready.attachments.available,1);
  assert.deepEqual(await pending(c),before);
  await c.db.run("UPDATE attachments SET hash='changed' WHERE id=?",[attachment]);
  const missing = await readMobileOfflineReadiness(c.db,{stat:async()=>null} as never,c.profileId,USER);
  assert.equal(missing.fullyAvailable,false);
  assert.equal(missing.attachments.missingFiles,1);
  assert.equal((await c.db.query<{transferStatus:string}>('SELECT transferStatus FROM attachments WHERE id=?',[attachment]))[0].transferStatus,'pending_download');
  assert.equal((await c.repository.notes.get(note))?.content,'local unsent body');
});

async function pending(c: Client) { return c.db.query<{ mutationId: string; baseVersion: number; payload: string }>("SELECT mutationId,baseVersion,payload FROM sync_outbox WHERE profileId=? ORDER BY createdAt,rowid", [c.profileId]); }
async function conflicts(c: Client) { return c.db.query<{ localPayload: string; remotePayload: string }>("SELECT localPayload,remotePayload FROM sync_conflicts WHERE profileId=? AND status='unresolved'", [c.profileId]); }

test("native recurrence stop survives restart and whole-series deletion converges across three SQLite devices",async()=>{
  const root=randomUUID(),next=randomUUID(),child=randomUUID();
  for(const [id,parent,group,done] of [[root,null,null,1],[next,null,root,0],[child,next,null,0]]) serverDb.prepare(`INSERT INTO tasks
    (id,userId,title,parentId,repeatGroupId,isCompleted,status,dueDate,repeatRule,repeatSequenceIndex)
    VALUES (?,?,'Daily',?,?,?,?,'2026-10-14','daily',1)`).run(id,USER,parent,group,done,done?"done":"todo");
  const first=await client("repeat-first"),second=await client("repeat-second");await first.sync();await second.sync();
  await first.repository.removeTaskOccurrences(next,"stop");const mutations=await pending(first);
  await first.db.close();const reopened=await client("repeat-first");
  assert.deepEqual(await pending(reopened),mutations);await reopened.sync();assert.equal((await pending(reopened)).length,0);
  await second.sync();
  for(const c of [reopened,second]){
    const history=(await c.db.query<any>("SELECT * FROM tasks WHERE id=?",[root]))[0];
    assert.equal(history.isCompleted,1);assert.equal(history.repeatRule,"none");
    assert.equal((await c.db.query<any>("SELECT * FROM tasks WHERE id=?",[next]))[0].repeatRule,"none");
    assert.equal((await c.db.query<any>("SELECT action FROM task_recurrence_state WHERE groupId=?",[root]))[0].action,"stop");
  }
  await second.repository.removeTaskOccurrences(next,"series");await second.sync();await reopened.sync();
  const third=await client("repeat-third");await third.sync();
  for(const c of [reopened,second,third]) for(const id of [root,next,child]) assert.equal((await c.db.query("SELECT id FROM tasks WHERE id=?",[id])).length,0);
  assert.equal(serverDb.prepare("SELECT 1 FROM tasks WHERE id=?").get(root),undefined);
});
test("native recurrence intent stays durable until the server advertises support",async()=>{
  const id=randomUUID();serverDb.prepare("INSERT INTO tasks(id,userId,title,repeatRule) VALUES (?,?,'Old server','daily')").run(id,USER);
  const c=await client("repeat-old-server");await c.sync();await c.repository.removeTaskOccurrences(id,"stop");
  const intent=await pending(c);legacyTaskCapabilities=true;
  try {await c.sync();} finally {legacyTaskCapabilities=false;}
  assert.deepEqual(await pending(c),intent);
  assert.equal((serverDb.prepare("SELECT title,repeatRule FROM tasks WHERE id=?").get(id) as any).repeatRule,"daily");
  await c.sync();assert.equal((await pending(c)).length,0);
  assert.equal((serverDb.prepare("SELECT title FROM tasks WHERE id=?").get(id) as any).title,"Old server");
});

test("native task archive survives restart and converges with its details on a second device",async () => {
  const root=randomUUID(),child=randomUUID();
  for (const [id,parent] of [[root,null],[child,root]]) serverDb.prepare(`INSERT INTO tasks
    (id,userId,title,description,parentId,isCompleted,status,completedAt,dueAt,repeatRule,repeatInterval,repeatEndCount) VALUES (?,?,'Project','Preserved task details',?,1,'done',?,'2026-10-13T18:00','daily',2,7)`)
    .run(id,USER,parent,new Date().toISOString());
  const first=await client("task-archive-first");await first.sync();
  assert.equal((await first.db.query<any>("SELECT * FROM tasks WHERE id=?",[root]))[0].description,"Preserved task details");
  await first.repository.archiveTaskTree(root,true);
  const mutationIds=(await pending(first)).map((item) => item.mutationId);
  assert.equal(mutationIds.length,2);
  await first.repository.archiveTaskTree(root,false);
  await first.repository.archiveTaskTree(root,true);
  assert.deepEqual((await pending(first)).map((item) => item.mutationId),mutationIds);
  await first.db.close();const reopened=await client("task-archive-first");
  assert.deepEqual((await pending(reopened)).map((item) => item.mutationId),mutationIds);
  await reopened.sync();assert.equal((await pending(reopened)).length,0);
  const second=await client("task-archive-second");await second.sync();
  for (const id of [root,child]) {
    const row=(await second.db.query<any>("SELECT * FROM tasks WHERE id=?",[id]))[0];
    assert.ok(row.archivedAt);assert.equal(row.description,"Preserved task details");assert.equal(row.dueAt,"2026-10-13T18:00");assert.equal(row.status,"done");assert.equal(row.repeatRule,"daily");assert.equal(row.repeatInterval,2);assert.equal(row.repeatEndCount,7);
  }
  await second.repository.archiveTaskTree(root,false);await second.sync();await reopened.sync();
  assert.equal((await reopened.db.query<any>("SELECT * FROM tasks WHERE id=?",[root]))[0].archivedAt,null);
  assert.equal((await reopened.db.query<any>("SELECT * FROM tasks WHERE id=?",[child]))[0].archivedAt,null);
});

test("native task archive rolls back data and Outbox together on a child enqueue failure",async () => {
  const c=await client("task-archive-rollback"),root=randomUUID(),child=randomUUID();
  for (const [id,parent] of [[root,null],[child,root]]) await c.db.run(`INSERT INTO tasks
    (id,userId,title,parentId,isCompleted,status,createdAt,updatedAt) VALUES (?,?,'Completed',?,1,'done','created','before')`,[id,USER,parent]);
  await c.db.run(`CREATE TRIGGER task_archive_failure BEFORE INSERT ON sync_outbox
    WHEN NEW.entityType='task' AND NEW.entityId='${child}' BEGIN SELECT RAISE(ABORT,'injected task enqueue failure'); END`);
  await assert.rejects(c.repository.archiveTaskTree(root,true),/injected task enqueue failure/);
  assert.equal((await pending(c)).length,0);
  for (const id of [root,child]) {
    const row=(await c.db.query<any>("SELECT * FROM tasks WHERE id=?",[id]))[0];assert.equal(row.archivedAt,null);assert.equal(row.updatedAt,"before");
  }
});

test("native task note snapshots keep the source and atomically persist an idempotent note",async () => {
  const c=await client("task-note-snapshot"),task=randomUUID(),notebook=randomUUID(),requestId=randomUUID();
  const objects=new Map<string,Buffer>();
  const store={
    async save(input:any) {
      const bytes=input.data instanceof Blob ? Buffer.from(await input.data.arrayBuffer()) : Buffer.from(input.data);
      objects.set(input.attachmentId,bytes);
      return {attachmentId:input.attachmentId,path:`objects/${input.attachmentId}`,size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),mtime:0,uri:"memory://fixture"};
    },
    async read(id:string) { const bytes=objects.get(id);if(!bytes)throw new Error("Missing bytes");return new Blob([bytes]); },
    async remove(id:string) { objects.delete(id); },
    async resolveUrl() { return null; },
  };
  c.repository=new NativeLocalRepository({db:c.db,attachments:store as never,accountId:"task-note-snapshot",userId:USER,getScopeKey:() => "personal"});
  await c.repository.notebooks.create({id:notebook,name:"Snapshots"});
  await c.db.run("INSERT INTO tasks (id,userId,title,description,createdAt,updatedAt) VALUES (?,?,'Task','Source details','created','updated')",[task,USER]);
  const sourceNote=randomUUID(),sourceAttachment=randomUUID();
  await c.repository.notes.create({id:sourceNote,notebookId:notebook,title:"Source",contentFormat:"markdown",content:"Source document"});
  await c.repository.attachments.save({id:sourceAttachment,noteId:sourceNote,filename:"source.txt",mimeType:"text/plain",blob:new Blob(["Independent bytes"])});
  const draft={requestId,notebookId:notebook,title:"Latest draft",description:`Unsaved task details\n\n[file](/api/attachments/${sourceAttachment})`};
  const saved=await c.repository.saveTaskNoteSnapshot(task,draft);
  assert.match(saved.content,/Unsaved task details/);assert.ok(!saved.content.includes(sourceAttachment));assert.equal(saved.title,draft.title);
  assert.equal((await c.db.query<any>("SELECT * FROM tasks WHERE id=?",[task]))[0].description,"Source details");
  assert.equal((await c.repository.saveTaskNoteSnapshot(task,draft)).id,saved.id);
  assert.equal((await c.db.query<any>("SELECT * FROM sync_outbox WHERE entityType='note' AND entityId=?",[saved.id])).length,1);
  const failingId=randomUUID();
  const objectCount=objects.size;
  await c.db.run(`CREATE TRIGGER task_note_failure BEFORE INSERT ON sync_outbox WHEN NEW.entityId='${failingId}' BEGIN SELECT RAISE(ABORT,'injected note enqueue failure'); END`);
  await assert.rejects(c.repository.saveTaskNoteSnapshot(task,{...draft,requestId:failingId}),/injected note enqueue failure/);
  assert.equal((await c.db.query("SELECT * FROM notes WHERE id=?",[failingId])).length,0);
  assert.equal((await c.db.query("SELECT * FROM native_runtime_meta WHERE key=?",[`taskNoteSnapshot:${failingId}`])).length,0);
  assert.equal(objects.size,objectCount);
  const attachment=(await c.repository.attachments.listByNote(saved.id))[0];
  await store.remove(sourceAttachment);
  assert.equal(await (await store.read(attachment.id)).text(),"Independent bytes");
});

async function cachePersonalTree(c: Client,includeDeleted=false): Promise<void> {
  const response = await fetch(`${serverUrl}/api/knowledge-tree/?workspaceId=personal${includeDeleted?"&includeDeleted=1":""}`, { headers: { Authorization: `Bearer ${USER}` } });
  assert.equal(response.status, 200);
  const { nodes } = await response.json() as { nodes: unknown[] };
  await c.db.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,'now')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [`knowledgeTreeSnapshot:v1:personal:${includeDeleted?1:0}`,JSON.stringify(nodes)]);
}

async function movableTree(name: string) {
  const c = await client(name), ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) await c.repository.notebooks.create({ id, name: "Move fixture" });
  const document = randomUUID();
  await c.repository.createPersonalTreeNote({ id: document, contentFormat: "markdown", content: "Preserved body" }, null);
  await c.sync(); await cachePersonalTree(c);
  return { c, node: `notebook:${ids[0]}`, left: `notebook:${ids[1]}`, right: `notebook:${ids[2]}`, document: `note:${document}` };
}

test("offline folder trash and restore preserve bodies and replay their deletion cohort after restart", async () => {
  const {c,node}=await movableTree("folder-trash"), child=randomUUID(), note=randomUUID(), old=randomUUID();
  await c.repository.createPersonalTreeFolder(child,"Nested",node);
  await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"Original"},child);
  await c.repository.createPersonalTreeNote({id:old,contentFormat:"markdown",content:"Earlier trash"},child);
  await c.sync();
  const {deleteKnowledgeNode}=await import("../src/services/knowledgeTree");
  deleteKnowledgeNode({db:serverDb,actorUserId:USER,nodeId:`note:${old}`,mode:"subtree"});
  await c.sync(); await cachePersonalTree(c);
  await c.repository.notes.update(note,{content:"Pending before trash",contentText:"Pending before trash"});
  const bodyIds=(await pending(c)).map((row)=>row.mutationId);
  const deleted=await c.repository.trashPersonalTreeFolders([node]);
  assert.ok(deleted.affectedNodeIds.includes(`note:${note}`));
  assert.ok(!deleted.affectedNodeIds.includes(`note:${old}`));
  assert.equal((await c.repository.notes.get(note))?.content,"Pending before trash");
  assert.equal((await c.repository.notes.get(note))?.isTrashed,1);
  assert.equal((await c.repository.listPersonalTreeOverrides()).find((row)=>row.id===`note:${note}`)?.localLifecycle,"trash");
  assert.equal((await readNativeNoteSyncReceipt(c.db,c.profileId,note)).phase,"pending");
  const queued=(await pending(c)).map((row)=>row.mutationId);
  assert.ok(bodyIds.every((id)=>queued.includes(id)));
  await c.db.close(); const reopened=await client("folder-trash");
  assert.deepEqual((await pending(reopened)).map((row)=>row.mutationId),queued);
  const restored=await reopened.repository.restorePersonalTreeFolder(node);
  assert.ok(restored.restoredNodeIds.includes(`note:${note}`));
  assert.equal((await reopened.repository.listPersonalTreeOverrides()).find((row)=>row.id===`note:${note}`)?.localLifecycle,"restore");
  assert.equal((await reopened.repository.notes.get(note))?.isTrashed,0);
  assert.equal((await reopened.repository.notes.get(old))?.isTrashed,1);
  await reopened.sync(); const peer=await client("folder-trash-peer"); await peer.sync();
  assert.equal((await pending(reopened)).length,0); assert.equal((await conflicts(reopened)).length,0);
  assert.equal((await peer.repository.notes.get(note))?.content,"Pending before trash");
  assert.equal((await peer.repository.notes.get(note))?.isTrashed,0);
  assert.equal((await peer.repository.notes.get(old))?.isTrashed,1);
});

test("native folder trash and restore retain TXT bodies and synchronize their lifecycle", async () => {
  const { c, node } = await movableTree("txt-trash"), id = randomUUID(), content = "# literal TXT  \n";
  await c.repository.createPersonalTreeNote({ id, contentFormat: "plaintext", content, contentText: content }, node.slice(9));
  await c.sync(); await cachePersonalTree(c);
  await c.repository.trashPersonalTreeFolders([node]); await c.sync();
  assert.equal((await c.repository.notes.get(id))?.content, content);
  assert.equal((serverDb.prepare("SELECT isTrashed FROM notes WHERE id=?").get(id) as any).isTrashed, 1);
  await c.repository.restorePersonalTreeFolder(node); await c.sync();
  const peer = await client("txt-trash-peer"); await peer.sync();
  assert.equal((await peer.repository.notes.get(id))?.content, content);
  assert.equal((await peer.repository.notes.get(id))?.contentFormat, "plaintext");
  assert.equal((await peer.repository.notes.get(id))?.isTrashed, 0);
});

test("remote document moves reject stale body metadata without losing the offline edit",async()=>{
  const {c,node,left}=await movableTree("document-move-body"),note=randomUUID();
  await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"Before move"},node.slice(9));
  await c.sync();
  const original=serverDb.prepare("SELECT version FROM notes WHERE id=?").get(note) as {version:number};
  await c.repository.notes.update(note,{content:"Retained offline edit",contentText:"Retained offline edit"});
  const {moveKnowledgeNode}=await import("../src/services/knowledgeTree");
  moveKnowledgeNode({db:serverDb,actorUserId:USER,nodeId:`note:${note}`,parentId:left});
  await c.sync();
  const remote=serverDb.prepare("SELECT notebookId,content,version FROM notes WHERE id=?").get(note) as {notebookId:string;content:string;version:number};
  assert.equal(remote.notebookId,left.slice(9),"a stale body must not undo the remote container move");
  assert.equal(remote.content,"Before move");
  assert.equal(remote.version,original.version+1);
  assert.equal((await c.repository.notes.get(note))?.content,"Retained offline edit");
  const conflict=(await c.db.query<{id:string;localPayload:string;remotePayload:string}>("SELECT id,localPayload,remotePayload FROM sync_conflicts WHERE entityType='note' AND entityId=? AND status='unresolved'",[note]))[0];
  assert.ok(conflict);
  assert.equal(JSON.parse(conflict.localPayload).content,"Retained offline edit");
  assert.equal(JSON.parse(conflict.remotePayload).notebookId,left.slice(9));
  await c.engine.resolveLocalConflict(conflict.id,"keep-remote");await c.sync();
  assert.equal((await c.repository.notes.get(note))?.notebookId,left.slice(9));
  assert.equal((await conflicts(c)).length,0);
});

test("folder lifecycle rolls back the entire local subtree when Outbox persistence fails",async()=>{
  const {c,node}=await movableTree("folder-trash-rollback"), note=randomUUID();
  await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"Keep"},node.slice(9));
  await c.sync(); await cachePersonalTree(c);
  await c.db.run("CREATE TRIGGER reject_trash BEFORE INSERT ON sync_outbox WHEN json_extract(NEW.payload,'$.lifecycle') IS NOT NULL BEGIN SELECT RAISE(ABORT,'Lifecycle Outbox failed'); END");
  await assert.rejects(c.repository.trashPersonalTreeFolders([node]),/Lifecycle Outbox failed/);
  assert.equal((await c.repository.notes.get(note))?.isTrashed,0);
  assert.equal((await c.db.query<{isDeleted:number}>("SELECT isDeleted FROM native_knowledge_tree_nodes WHERE id=?",[node]))[0].isDeleted,0);
  assert.equal((await pending(c)).length,0);
});

test("lost folder trash ACK and a restore queued during Push retain stable intentions and child bodies",async()=>{
  const {c,node}=await movableTree("folder-trash-lost-ack"),note=randomUUID();
  await c.repository.createPersonalTreeNote({id:note,contentFormat:"tiptap-json",content:JSON.stringify({type:"doc",content:[]})},node.slice(9));
  await c.sync();await cachePersonalTree(c);
  await c.repository.trashPersonalTreeFolders([node]);
  const mutation=(await pending(c))[0].mutationId;
  afterPush=async(response)=>{
    const result=await response.json();
    await c.repository.restorePersonalTreeFolder(node);
    return Response.json({...result,results:result.results.map((row:Record<string,unknown>)=>({...row,status:"failed",code:"NETWORK_UNAVAILABLE"}))});
  };
  try{await c.sync();}finally{afterPush=undefined;}
  assert.equal((await c.repository.notes.get(note))?.isTrashed,0);
  assert.ok((await pending(c)).some((row)=>row.mutationId===mutation));
  assert.equal((await conflicts(c)).length,0);
  await c.sync();assert.equal((await pending(c)).length,0);assert.equal((await conflicts(c)).length,0);
  assert.equal(serverDb.prepare("SELECT isTrashed FROM notes WHERE id=?").get(note).isTrashed,0);
});

test("concurrent child moves conflict with offline folder trash and both explicit choices retain bodies",async()=>{
  for(const choice of ["keep-local","keep-remote"] as const) for(const kind of ["child","root"] as const) {
    const {c,node,left}=await movableTree(`folder-trash-${choice}-${kind}`),child=randomUUID(),note=randomUUID();
    await c.repository.createPersonalTreeFolder(child,"Moved child",node);
    await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"Retained child"},child);
    await c.sync();await cachePersonalTree(c);
    await c.repository.trashPersonalTreeFolders([node]);
    const {moveKnowledgeNode}=await import("../src/services/knowledgeTree");
    moveKnowledgeNode({db:serverDb,actorUserId:USER,nodeId:kind==="child"?`notebook:${child}`:node,parentId:left});
    await c.sync();
    const conflict=(await c.db.query<{id:string;localPayload:string}>("SELECT id,localPayload FROM sync_conflicts WHERE profileId=? AND entityId=? AND status='unresolved'",[c.profileId,node]))[0];
    assert.ok(conflict);assert.equal(JSON.parse(conflict.localPayload).lifecycle,"trash");
    assert.equal((await readNativeNoteSyncReceipt(c.db,c.profileId,note)).phase,"conflict");
    assert.equal((await c.repository.notes.get(note))?.content,"Retained child");
    await c.engine.resolveLocalConflict(conflict.id,choice);await c.sync();
    assert.equal((await conflicts(c)).length,0);assert.equal((await pending(c)).length,0);
    assert.equal((await c.repository.notes.get(note))?.isTrashed,kind==="root" && choice==="keep-local"?1:0,"only current descendants belong to a rebased delete");
    assert.equal(serverDb.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id=?").get(node).isDeleted,choice==="keep-local"?1:0);
    assert.equal((await c.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?",[`notebook:${child}`]))[0].parentId,kind==="child"?left:node);
  }
});

test("folder trash rejects missing server capability and protected ancestry without altering queues",async()=>{
  const {c,node}=await movableTree("folder-trash-guards");
  await c.db.run("DELETE FROM native_runtime_meta WHERE key=?",[`nativeTreeLifecycle:${c.profileId}:personal`]);
  await assert.rejects(c.repository.trashPersonalTreeFolders([node]),/尚未确认/);
  await c.db.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,'personal-folder-v1','now')",[`nativeTreeLifecycle:${c.profileId}:personal`]);
  const cache=(await c.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key='knowledgeTreeSnapshot:v1:personal:0'"))[0];
  const nodes=JSON.parse(cache.value);nodes.find((row:Record<string,unknown>)=>row.id===node).isPasswordProtected=1;
  await c.db.run("UPDATE native_runtime_meta SET value=? WHERE key='knowledgeTreeSnapshot:v1:personal:0'",[JSON.stringify(nodes)]);
  await assert.rejects(c.repository.trashPersonalTreeFolders([node]),/权限|密码/);
  assert.equal((await pending(c)).length,0);
  assert.equal((await c.db.query<{isDeleted:number}>("SELECT isDeleted FROM native_knowledge_tree_nodes WHERE id=?",[node]))[0].isDeleted,0);
});

test("acknowledged folder trash restores its cohort and a reverse-ordered batch deletes each subtree once",async()=>{
  const {c,node}=await movableTree("folder-trash-batch"),child=randomUUID(),note=randomUUID();
  await c.repository.createPersonalTreeFolder(child,"Child",node);
  await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"Batch body"},child);
  await c.sync();await cachePersonalTree(c);
  await c.repository.trashPersonalTreeFolders([`notebook:${child}`,node]);
  assert.equal((await pending(c)).length,1);
  const payload=JSON.parse((await pending(c))[0].payload);
  assert.equal(payload.sortOrder,undefined,"an old per-node parser must reject the atomic command");
  const {applyKnowledgeTreeStructureMutation}=await import("../src/sync/knowledgeTreeStructure");
  assert.throws(()=>applyKnowledgeTreeStructureMutation(serverDb,{userId:USER,workspaceId:null,entityId:node,operation:"upsert",payload:{...payload,lifecycle:undefined}}),
    (error:{code:string})=>error.code==="INVALID_PAYLOAD");
  await c.sync();assert.equal((await pending(c)).length,0);
  await cachePersonalTree(c,true);await c.repository.restorePersonalTreeFolder(node);await c.sync();
  assert.equal((await c.repository.notes.get(note))?.isTrashed,0);assert.equal((await pending(c)).length,0);
});

test("a pre-trash edit from an old device cannot revive a document under a trashed folder",async()=>{
  const {c,node}=await movableTree("folder-trash-old-writer"),note=randomUUID();
  await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"Cloud body"},node.slice(9));
  await c.sync();await cachePersonalTree(c);
  const peer=await client("folder-trash-old-reader");await peer.sync();
  await peer.repository.notes.update(note,{content:"Offline old device",contentText:"Offline old device"});
  await c.repository.trashPersonalTreeFolders([node]);await c.sync();await peer.sync();
  assert.equal(serverDb.prepare("SELECT isTrashed FROM notes WHERE id=?").get(note).isTrashed,1);
  assert.equal((await peer.repository.notes.get(note))?.content,"Offline old device");
  assert.equal((await conflicts(peer)).length,1);
});

test("a password added after local trash was committed blocks server application and retains the intent",async()=>{
  const {c,node}=await movableTree("folder-trash-password-race");
  await c.repository.trashPersonalTreeFolders([node]);
  const mutation=(await pending(c))[0].mutationId;
  serverDb.prepare("INSERT INTO notebook_passwords (notebookId,passwordHash) VALUES (?,'test-only-hash')").run(node.slice(9));
  await c.sync();
  assert.equal((await pending(c))[0].mutationId,mutation);
  assert.equal(serverDb.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id=?").get(node).isDeleted,0);
  assert.equal((await c.db.query<{status:string;lastError:string}>("SELECT status,lastError FROM sync_outbox WHERE mutationId=?",[mutation]))[0].lastError,"SCOPE_FORBIDDEN");
});


test("folder trash committed during the final Snapshot page retains its complete pending projection",async()=>{
  const {c,node}=await movableTree("folder-trash-snapshot"),note=randomUUID();
  await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"Snapshot body"},node.slice(9));
  await c.sync();await cachePersonalTree(c);
  await c.db.run("UPDATE sync_state SET lastSequence=0 WHERE profileId=?",[c.profileId]);
  let injected=false;
  afterSnapshot=async(response)=>{
    const result=await response.json();
    if(!result.nextCursor && !injected){injected=true;await c.repository.trashPersonalTreeFolders([node]);}
    return Response.json(result);
  };
  try{await c.sync();}finally{afterSnapshot=undefined;}
  assert.ok(injected);assert.equal((await pending(c)).length,0);assert.equal((await conflicts(c)).length,0);
  assert.equal((await c.repository.notes.get(note))?.content,"Snapshot body");
  assert.equal((await c.repository.notes.get(note))?.isTrashed,1);
  assert.equal(serverDb.prepare("SELECT isTrashed FROM notes WHERE id=?").get(note).isTrashed,1);
});

test("offline folder creation atomically persists nested resources and document parents across reopen and a second device", async () => {
  const {c,document}=await movableTree("folder-create"), root=randomUUID(), child=randomUUID(), underDocument=randomUUID(), note=randomUUID();
  await c.repository.createPersonalTreeFolder(root,"Offline root",null);
  await c.repository.createPersonalTreeFolder(child,"Offline child",`notebook:${root}`);
  await c.repository.createPersonalTreeFolder(underDocument,"Under document",document);
  await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"Nested offline body"},child);
  const intents=await pending(c); assert.equal(intents.length,7);
  assert.equal(JSON.parse(intents[5].payload).baseParentId,null);
  assert.equal(JSON.parse(intents[5].payload).parentId,document);
  assert.equal((await c.repository.listPersonalTreeFolderDrafts()).length,3);
  await c.db.close(); const reopened=await client("folder-create");
  assert.deepEqual((await pending(reopened)).map((row)=>row.mutationId),intents.map((row)=>row.mutationId));
  assert.equal((await reopened.repository.notes.get(note))?.content,"Nested offline body");
  await reopened.sync();
  const peer=await client("folder-create-peer"); await peer.sync();
  assert.equal((await pending(reopened)).length,0); assert.equal((await conflicts(reopened)).length,0);
  for (const device of [reopened,peer]) {
    const graph=await device.db.query<{id:string;parentId:string|null}>("SELECT id,parentId FROM native_knowledge_tree_nodes WHERE id IN (?,?,?)",[`notebook:${root}`,`notebook:${child}`,`notebook:${underDocument}`]);
    assert.equal(graph.find((row)=>row.id===`notebook:${root}`)?.parentId,null);
    assert.equal(graph.find((row)=>row.id===`notebook:${child}`)?.parentId,`notebook:${root}`);
    assert.equal(graph.find((row)=>row.id===`notebook:${underDocument}`)?.parentId,document);
    assert.equal((await device.repository.notes.get(note))?.content,"Nested offline body");
  }
  await reopened.repository.notebooks.update(underDocument,{name:"Renamed"}); await reopened.sync();
  assert.equal((await pending(reopened)).length,0);
  assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${underDocument}`).parentId,document);
});

test("lost creation ACK replays immutable mutations before later offline nested creation and moves", async () => {
  const {c,document}=await movableTree("folder-create-lost-ack"), id=randomUUID(), child=randomUUID();
  await c.repository.createPersonalTreeFolder(id,"Before ACK",document);
  const original=(await pending(c)).map((row)=>row.mutationId);
  afterPush=async()=>{
    await c.repository.createPersonalTreeFolder(child,"During ACK",`notebook:${id}`);
    await c.repository.movePersonalTreeNodes([{id:`notebook:${id}`,parentId:null,sortOrder:41}]);
    return Response.json({code:"SERVER_ERROR"},{status:503});
  };
  try {await c.sync();} finally {afterPush=undefined;}
  assert.deepEqual((await pending(c)).slice(0,2).map((row)=>row.mutationId),original);
  await c.db.close(); const reopened=await client("folder-create-lost-ack");
  await reopened.db.run("UPDATE sync_state SET lastSequence=0 WHERE profileId=?",[reopened.profileId]);
  await reopened.sync(); assert.equal((await pending(reopened)).length,0); assert.equal((await conflicts(reopened)).length,0);
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${id}`),{parentId:null,sortOrder:41});
  assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${child}`).parentId,`notebook:${id}`);
});

test("folder creation fails closed for unbound, missing, foreign and newly protected ancestor proofs", async () => {
  const {c,node,left}=await movableTree("folder-create-guards");
  const cached=(await c.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key='knowledgeTreeSnapshot:v1:personal:0'"))[0];
  const nodes=JSON.parse(cached.value) as Array<{id:string;userId:string;isPasswordProtected:number}>;
  await assert.rejects(c.repository.createPersonalTreeFolder(randomUUID(),"Missing","notebook:missing"),/权限|密码/);
  nodes.find((n)=>n.id===left)!.userId="other-user";
  await c.db.run("UPDATE native_runtime_meta SET value=? WHERE key='knowledgeTreeSnapshot:v1:personal:0'",[JSON.stringify(nodes)]);
  await assert.rejects(c.repository.createPersonalTreeFolder(randomUUID(),"Foreign",left),/权限|密码/);
  await cachePersonalTree(c);
  await c.repository.movePersonalTreeNodes([{id:node,parentId:left}]);
  await c.repository.movePersonalTreeNodes([{id:node,parentId:null}]);
  const changed=JSON.parse(cached.value) as Array<{id:string;parentId:string|null;isPasswordProtected:number}>;
  changed.find((n)=>n.id===node)!.parentId=left; changed.find((n)=>n.id===left)!.isPasswordProtected=1;
  await c.db.run("UPDATE native_runtime_meta SET value=? WHERE key='knowledgeTreeSnapshot:v1:personal:0'",[JSON.stringify(changed)]);
  await assert.rejects(c.repository.createPersonalTreeFolder(randomUUID(),"Protected source",node),/权限|密码/);
  await c.db.run("DELETE FROM native_runtime_meta WHERE key=?",[`nativeTreeSubscription:${c.profileId}:personal`]);
  await assert.rejects(c.repository.createPersonalTreeFolder(randomUUID(),"Unbound",null),/订阅/);
  assert.equal((await c.repository.listPersonalTreeFolderDrafts()).length,0); assert.equal((await pending(c)).length,2);
});

test("a lost structural creation ACK retains the local folder for further nested writes and snapshot recovery", async () => {
  const {c,document}=await movableTree("folder-create-partial-ack"), id=randomUUID(), child=randomUUID();
  await c.repository.createPersonalTreeFolder(id,"Partial ACK",document);
  const treeId=(await c.db.query<{mutationId:string}>("SELECT mutationId FROM sync_outbox WHERE entityType='knowledge_tree_node'"))[0].mutationId;
  await c.db.run("UPDATE sync_state SET lastSequence=0 WHERE profileId=?",[c.profileId]);
  afterPush=async (response)=>{
    const body=await response.json() as {results:Array<{mutationId:string}>};
    return Response.json({...body,results:body.results.map((row)=>row.mutationId===treeId?{...row,status:"failed",code:"NETWORK_UNAVAILABLE"}:row)});
  };
  try {await c.sync();} finally {afterPush=undefined;}
  assert.deepEqual((await pending(c)).map((row)=>row.mutationId),[treeId]);
  await c.repository.createPersonalTreeFolder(child,"Still offline",`notebook:${id}`);
  await c.db.close(); const reopened=await client("folder-create-partial-ack"); await reopened.sync();
  assert.equal((await pending(reopened)).length,0); assert.equal((await conflicts(reopened)).length,0);
  assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${child}`).parentId,`notebook:${id}`);
});

test("creation dependencies remain ordered when folder mutations span the 100-row Push boundary", async () => {
  const {c}=await movableTree("folder-create-page"), ids:string[]=[];
  for(let i=0;i<51;i++) {
    const id=randomUUID(); await c.repository.createPersonalTreeFolder(id,"Paged folder",ids.length?`notebook:${ids.at(-1)}`:null); ids.push(id);
  }
  assert.equal((await pending(c)).length,102);
  await c.sync(); await c.sync();
  assert.equal((await pending(c)).length,0); assert.equal((await conflicts(c)).length,0);
  assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${ids.at(-1)}`).parentId,`notebook:${ids.at(-2)}`);
});

test("a folder created during the final Snapshot page remains a creation intent rather than a remote tombstone",async()=>{
  const {c}=await movableTree("folder-create-during-snapshot"), id=randomUUID(), child=randomUUID(), note=randomUUID();
  await c.db.run("UPDATE sync_state SET lastSequence=0 WHERE profileId=?",[c.profileId]);
  afterSnapshot=async(response)=>{
    const page=await response.clone().json() as {nextCursor:string|null};
    if(!page.nextCursor) {
      afterSnapshot=undefined;
      await c.repository.createPersonalTreeFolder(id,"During Snapshot",null);
      await c.repository.createPersonalTreeFolder(child,"Nested during Snapshot",`notebook:${id}`);
      await c.repository.createPersonalTreeNote({id:note,contentFormat:"markdown",content:"During Snapshot body"},child);
    }
    return response;
  };
  try {await c.sync();} finally {afterSnapshot=undefined;}
  assert.equal((await conflicts(c)).length,0); assert.equal((await pending(c)).length,0);
  assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${id}`).parentId,null);
  assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${child}`).parentId,`notebook:${id}`);
  assert.equal((await c.repository.notes.get(note))?.content,"During Snapshot body");
});

test("offline folder creation rolls back the business row, structure, origin and both queues on a structural enqueue failure", async () => {
  const {c}=await movableTree("folder-create-rollback"), id=randomUUID();
  await c.db.run("CREATE TRIGGER reject_folder_create BEFORE INSERT ON sync_outbox WHEN NEW.entityType='knowledge_tree_node' BEGIN SELECT RAISE(ABORT,'Folder Outbox failure'); END");
  await assert.rejects(c.repository.createPersonalTreeFolder(id,"Unsaved",null),/Folder Outbox failure/);
  assert.equal(await c.repository.notebooks.get(id),null);
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?",[`notebook:${id}`])).length,0);
  assert.equal((await c.repository.listPersonalTreeFolderDrafts()).length,0);
  assert.equal((await pending(c)).length,0);
});

test("native personal moves and sorting are atomic, survive reopen and push only structural fields", async () => {
  const { c, node, left, document } = await movableTree("active-offline");
  await c.repository.movePersonalTreeNodes([{ id: node, parentId: document, sortOrder: 23 }, { id: left, sortOrder: 24 }]);
  const outbox = await pending(c); assert.equal(outbox.length, 2);
  const mutation = JSON.parse(outbox[0].payload);
  assert.equal(mutation.parentId, document); assert.equal(mutation.baseParentId, null);
  assert.equal(mutation.content, undefined); assert.equal(mutation.title, undefined);
  await c.db.close();
  const reopened = await client("active-offline");
  assert.deepEqual((await reopened.db.query("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [node]))[0], { parentId: document, sortOrder: 23 });
  await reopened.sync();
  assert.equal((await pending(reopened)).length, 0);
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node), { parentId: document, sortOrder: 23 });
  assert.equal(serverDb.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id=?").get(left).sortOrder, 24);
  assert.equal((await reopened.repository.notes.get(document.slice(5)))?.content, "Preserved body");
  await reopened.repository.notebooks.update(node.slice(9),{name:"Rename after move"}); await reopened.sync();
  assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(node).parentId,document);
  assert.equal(serverDb.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node).sortOrder,23);
  assert.equal(serverDb.prepare("SELECT parentId FROM notebooks WHERE id=?").get(node.slice(9)).parentId,
    (await reopened.repository.notebooks.get(node.slice(9)))?.parentId);
});

for (const resolution of ["keep-local", "keep-remote"] as const) test(`concurrent native tree moves recover with ${resolution} and preserve latest local position`, async () => {
  const { c: a, node, left, right } = await movableTree(`active-${resolution}`), b = await client(`active-peer-${resolution}`);
  await b.sync(); await cachePersonalTree(b);
  await a.repository.movePersonalTreeNodes([{ id: node, parentId: left, sortOrder: 11 }]);
  await b.repository.movePersonalTreeNodes([{ id: node, parentId: right, sortOrder: 12 }]);
  await a.sync(); await b.sync();
  const rows = await b.db.query<{id:string;remotePayload:string}>("SELECT id,remotePayload FROM sync_conflicts WHERE profileId=? AND entityId=? AND status='unresolved'", [b.profileId,node]);
  assert.equal(rows.length, 1); assert.equal(JSON.parse(rows[0].remotePayload).parentId, left);
  assert.equal((await b.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?", [node]))[0].parentId, right);
  await b.repository.movePersonalTreeNodes([{ id: node, parentId: right, sortOrder: 33 }]);
  await b.engine.resolveLocalConflict(rows[0].id, resolution); await b.sync(); await a.sync();
  assert.equal((await conflicts(b)).length, 0); assert.equal((await pending(b)).length, 0);
  const expected = { parentId: resolution === "keep-local" ? right : left, sortOrder: resolution === "keep-local" ? 33 : 11 };
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node), expected);
  assert.deepEqual((await a.db.query("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [node]))[0], expected);
});

test("lost tree Push ACK and a newer move during Push retain stable mutation identities", async () => {
  const { c, node, left, right } = await movableTree("active-lost-ack");
  await c.repository.movePersonalTreeNodes([{ id: node, parentId: left, sortOrder: 3 }]);
  const first = (await pending(c))[0].mutationId;
  afterPush = async () => {
    await c.repository.movePersonalTreeNodes([{ id: node, parentId: right, sortOrder: 4 }]);
    return Response.json({code:"SERVER_ERROR"}, {status:503});
  };
  try { await c.sync(); } finally { afterPush = undefined; }
  assert.equal((await pending(c))[0].mutationId, first);
  await c.db.close(); const reopened = await client("active-lost-ack"); await reopened.sync();
  assert.equal((await pending(reopened)).length, 0); assert.equal((await conflicts(reopened)).length, 0);
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node), { parentId: right, sortOrder: 4 });
});

test("native tree writes reject missing subscription, protected ancestry and cycles without partial commits", async () => {
  const { c, node, left } = await movableTree("active-guards");
  await assert.rejects(c.repository.movePersonalTreeNodes([{ id: node, parentId: left }, { id: left, parentId: node }]), /循环/);
  assert.equal((await pending(c)).length, 0);
  const cached = (await c.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key='knowledgeTreeSnapshot:v1:personal:0'"))[0];
  const nodes = JSON.parse(cached.value) as Array<{id:string;isPasswordProtected?:number}>;
  nodes.find((n) => n.id === left)!.isPasswordProtected = 1;
  await c.db.run("UPDATE native_runtime_meta SET value=? WHERE key='knowledgeTreeSnapshot:v1:personal:0'", [JSON.stringify(nodes)]);
  await assert.rejects(c.repository.movePersonalTreeNodes([{ id: node, parentId: left }]), /权限|密码/);
  await c.db.run("DELETE FROM native_runtime_meta WHERE key=?", [`nativeTreeSubscription:${c.profileId}:personal`]);
  await assert.rejects(c.repository.movePersonalTreeNodes([{ id: node, parentId: null }]), /订阅/);
  assert.equal((await pending(c)).length, 0);
  assert.equal((await c.db.query<{parentId:string|null}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?", [node]))[0].parentId, null);
});

test("a structural Outbox insert failure rolls back every move in the local batch", async () => {
  const { c,node,left,right } = await movableTree("active-write-failure");
  await c.db.run(`CREATE TRIGGER reject_fixture_tree BEFORE INSERT ON sync_outbox
    WHEN NEW.entityType='knowledge_tree_node' AND NEW.entityId='${left}' BEGIN SELECT RAISE(ABORT,'Outbox fixture failure'); END`);
  await assert.rejects(c.repository.movePersonalTreeNodes([{id:node,parentId:right},{id:left,parentId:right}]), /Outbox fixture failure/);
  assert.equal((await pending(c)).length,0);
  assert.equal((await c.db.query<{parentId:string|null}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?",[node]))[0].parentId,null);
});

test("full tree rebuild preserves newer pending moves and recognizes an intermediate lost ACK echo", async () => {
  const { c,node,left,right } = await movableTree("active-snapshot-pending");
  await c.repository.movePersonalTreeNodes([{id:node,parentId:left,sortOrder:1}]);
  await c.db.run("UPDATE sync_state SET lastSequence=0 WHERE profileId=?",[c.profileId]);
  afterPush = async (response) => {
    const body = await response.json() as {serverSequence:number;results:Array<{mutationId:string}>};
    await c.repository.movePersonalTreeNodes([{id:node,parentId:right,sortOrder:2}]);
    return Response.json({...body,results:body.results.map((r)=>({...r,status:"failed",code:"NETWORK_UNAVAILABLE"}))});
  };
  try { await c.sync(); } finally { afterPush=undefined; }
  assert.equal((await conflicts(c)).length,0);
  assert.equal((await c.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?",[node]))[0].parentId,right);
  await c.sync(); assert.equal((await pending(c)).length,0); assert.equal((await conflicts(c)).length,0);
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node),{parentId:right,sortOrder:2});
});

test("a remote folder tombstone retains pending native structure and child bodies until an explicit remote choice", async () => {
  const {c,node,left} = await movableTree("active-delete-race"), note=randomUUID();
  await c.repository.notes.create({id:note,notebookId:node.slice(9),contentFormat:"markdown",content:"Protected from cascade"});
  await c.sync(); await cachePersonalTree(c);
  await c.repository.movePersonalTreeNodes([{id:node,parentId:left,sortOrder:7}]);
  const before=(await c.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=?",[c.profileId]))[0].lastSequence;
  serverDb.prepare("DELETE FROM notebooks WHERE id=?").run(node.slice(9));
  await c.sync();
  assert.equal((await c.repository.notes.get(note))?.content,"Protected from cascade");
  assert.equal((await c.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=?",[c.profileId]))[0].lastSequence,before);
  const [conflict]=await c.db.query<{id:string;remotePayload:string}>("SELECT id,remotePayload FROM sync_conflicts WHERE profileId=? AND entityId=? AND status='unresolved'",[c.profileId,node]);
  assert.ok(conflict); assert.equal(JSON.parse(conflict.remotePayload).__delete,true);
  await assert.rejects(c.engine.resolveLocalConflict(conflict.id,"keep-local"),/业务资源缺失/);
  await c.engine.resolveLocalConflict(conflict.id,"keep-remote"); await c.sync();
  assert.equal((await pending(c)).length,0); assert.equal((await conflicts(c)).length,0);
  assert.equal(await c.repository.notes.get(note),null);
});

test.before(async () => {
  const schema = await import("../src/db/schema");
  const routes = await import("../src/routes/sync-v2");
  const treeRoutes = await import("../src/routes/knowledge-tree");
  serverDb = schema.getDb(); closeServerDb = schema.closeDb;
  for (const user of [USER, "other-user"]) serverDb.prepare("INSERT INTO users (id,username,passwordHash,createdAt,updatedAt) VALUES (?,?,'x','now','now')").run(user, user);
  const app = new Hono();
  // Route tests use fixture identities; production auth remains in index.ts.
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-User-Id", c.req.header("Authorization")?.replace("Bearer ", "") || "");
    await next();
    if (c.req.path.endsWith("/push") && afterPush) c.res = await afterPush(c.res);
    if (c.req.path.endsWith("/snapshot") && afterSnapshot) c.res = await afterSnapshot(c.res);
    if (c.req.path.endsWith("/ack") && afterAck) c.res = await afterAck(c.res);
    if(c.req.path.endsWith("/scopes") && legacyNoteDeletionCapabilities) {
      const payload=await c.res.json() as {items:Array<Record<string,unknown>>};
      c.res=Response.json({items:payload.items.map(({noteDeletionLifecycle:_capability,...scope})=>scope)});
    }
    if (c.req.path.endsWith("/scopes") && legacyTaskCapabilities) {
      const payload=await c.res.json() as {items:Array<Record<string,unknown>>};
      c.res=Response.json({items:payload.items.map(({taskRecurrenceLifecycle: _capability,...scope})=>scope)});
    }
  });
  app.route("/api/sync/v2", routes.default);
  app.route("/api/knowledge-tree/", treeRoutes.default);
  app.route("/api/agent", (await import("../src/routes/agent")).default);
  httpServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address(); assert.ok(address && typeof address !== "string");
  serverUrl = `http://127.0.0.1:${address.port}`;
});
test.after(async () => {
  for (const c of clients) { c.engine.stop(); await c.db.close().catch(() => undefined); }
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  closeServerDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("TXT survives native SQLite restart and bidirectional Sync V2 without interpreting syntax", async () => {
  const name = "txt-offline", a = await client(name), id = randomUUID();
  const content = '  # 原文\n**bold**\n<script>literal</script>\n{"type":"doc","content":[]}\n![image](blob:literal)\n```nowen-encrypted-v1\n原文\n```\n\t尾部  \n';
  await a.repository.createPersonalTreeNote({ id, title: "TXT", contentFormat: "plaintext", content, contentText: content }, null);
  assert.equal((await a.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType='note' AND entityId=?", [id]))[0].count, 1);
  await a.db.close();
  const reopened = await client(name), b = await client("txt-peer");
  assert.equal((await reopened.repository.notes.get(id))?.content, content);
  await reopened.sync(); await b.sync();
  assert.equal((await pending(reopened)).length, 0);
  assert.equal((await b.repository.notes.get(id))?.content, content);
  assert.equal((await b.repository.notes.get(id))?.contentFormat, "plaintext");
  assert.equal((serverDb.prepare("SELECT content FROM notes WHERE id=?").get(id) as any).content, content);
  await b.repository.notes.update(id, { content: "", contentText: "" });
  await b.sync(); await reopened.sync();
  assert.equal((await reopened.repository.notes.get(id))?.content, "");
  assert.equal((await reopened.repository.notes.get(id))?.contentFormat, "plaintext");
});

test("personal tree creates are readable offline, survive reopen and converge with stable root identities", async () => {
  const name = "tree-offline", a = await client(name);
  const ids: string[] = [];
  for (const contentFormat of ["markdown", "tiptap-json"] as const) {
    const id = randomUUID(); ids.push(id);
    await a.repository.createPersonalTreeNote({ id, title: "Offline root", contentFormat, content: "offline body" }, null);
    assert.equal((await a.repository.notes.get(id))?.content, "offline body");
  }
  assert.equal((await a.repository.listLocalTreeDrafts()).length, 2);
  assert.equal((await a.repository.notebooks.list()).length, 0, "internal root container stays hidden");
  await a.db.close();
  const reopened = await client(name), b = await client("tree-reader");
  assert.equal((await reopened.repository.listLocalTreeDrafts()).length, 2);
  for (const id of ids) assert.equal((await reopened.repository.notes.get(id))?.content, "offline body");
  await reopened.sync(); await b.sync();
  assert.equal((await pending(reopened)).length, 0);
  for (const id of ids) {
    assert.equal((await b.repository.notes.get(id))?.content, "offline body");
    assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(`note:${id}`).parentId, null);
  }
});

test("negotiated native tree preserves folder-under-document links and remote moves across reopen", async () => {
  const a = await client("structure-writer"), b = await client("structure-reader");
  const book = randomUUID(), note = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Tree folder" });
  await a.repository.createPersonalTreeNote({ id: note, contentFormat: "markdown", content: "Tree body" }, null);
  await a.sync();
  serverDb.prepare("UPDATE knowledge_tree_nodes SET parentId=?,sortOrder=17 WHERE id=?")
    .run(`note:${note}`, `notebook:${book}`);
  await b.sync();
  const row = (await b.db.query<{ parentId: string; sortOrder: number }>("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE scopeKey='personal' AND id=?", [`notebook:${book}`]))[0];
  assert.deepEqual(row, { parentId: `note:${note}`, sortOrder: 17 });
  assert.equal((await b.repository.notebooks.get(book))?.parentId, null, "legacy resource parent does not flatten the tree");
  assert.equal((await b.repository.notes.get(note))?.content, "Tree body");
  const binding = serverDb.prepare("SELECT entitySet FROM sync_v2_clients WHERE deviceId=? AND userId=? AND scopeKey='personal'").get("structure-reader", USER) as { entitySet: string };
  assert.ok(binding.entitySet.includes("knowledge_tree_node"));
  await b.db.close();
  const reopened = await client("structure-reader");
  assert.equal((await reopened.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${book}`]))[0].parentId, `note:${note}`);
  serverDb.prepare("UPDATE knowledge_tree_nodes SET parentId=NULL,sortOrder=18 WHERE id=?").run(`notebook:${book}`);
  await reopened.sync();
  assert.deepEqual((await reopened.db.query("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${book}`]))[0], { parentId: null, sortOrder: 18 });
});

test("a new native tree subscription rebuilds an existing legacy cursor without discarding local edits", async () => {
  const c = await client("structure-upgrade"), book = randomUUID(), note = randomUUID();
  await c.repository.notebooks.create({ id: book, name: "Upgrade folder" });
  await c.repository.createPersonalTreeNote({ id: note, contentFormat: "markdown", content: "Pending body" }, null);
  await c.db.run("INSERT INTO sync_state (profileId,scopeKey,lastSequence,accessStatus,accessFingerprint) VALUES (?,'personal',999999,'active','personal:owner')", [c.profileId]);
  await c.sync();
  assert.equal((await pending(c)).length, 0);
  assert.equal((await c.repository.notes.get(note))?.content, "Pending body");
  assert.ok((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${book}`])).length);
  const state = (await c.db.query<{lastSequence:number;lastError:string|null}>("SELECT lastSequence,lastError FROM sync_state WHERE profileId=?", [c.profileId]))[0];
  assert.equal(state.lastError, null);
  assert.ok(state.lastSequence < 999999, "the new entity set must not inherit the legacy high-water mark");
});

test("lost initial tree ACK retains subscription intent and replays the complete baseline after reopen", async () => {
  const c = await client("structure-lost-ack"), id = randomUUID();
  await c.repository.notebooks.create({ id,name:"Lost tree ACK" });
  afterAck = async () => Response.json({code:"SERVER_ERROR"},{status:503});
  try { await c.sync(); } finally { afterAck = undefined; }
  const marker = (await c.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?", [`nativeTreeSubscription:${c.profileId}:personal`]))[0];
  assert.ok(marker.value.startsWith("pending:"));
  assert.ok((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${id}`])).length);
  assert.equal((await c.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=?", [c.profileId]))[0].lastSequence, 0);
  await c.db.close();
  const reopened = await client("structure-lost-ack"); await reopened.sync();
  assert.equal((await reopened.db.query<{lastError:string|null}>("SELECT lastError FROM sync_state WHERE profileId=?", [c.profileId]))[0].lastError, null);
  assert.ok(!(await reopened.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?", [`nativeTreeSubscription:${c.profileId}:personal`]))[0].value.startsWith("pending:"));
});

test("REST tree movement emits a committed metadata-only Sync V2 notice and wakes the negotiated receiver", async () => {
  const c = await client("structure-rest-notice"), id = randomUUID();
  await c.repository.notebooks.create({id,name:"Private folder title must not enter notice"}); await c.sync();
  // Match routes' CommonJS loader; a late native import creates a separate tsx
  // module instance and cannot register their broadcaster in this test process.
  const {setSyncBroadcaster} = createRequire(path.resolve(__dirname,"../package.json"))("./src/sync/notify.ts") as typeof import("../src/sync/notify");
  const notices: Array<{recipient:string;notice:Record<string,unknown>;committed:boolean;sortOrder:number}> = [];
  setSyncBroadcaster((recipient,notice) => {
    notices.push({recipient,notice:notice as Record<string,unknown>,committed:!serverDb.inTransaction,
      sortOrder:(serverDb.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${id}`) as {sortOrder:number}).sortOrder});
  });
  try {
    const before = (serverDb.prepare("SELECT MAX(sequence) AS sequence FROM sync_changes_v2").get() as {sequence:number}).sequence;
    const response = await fetch(`${serverUrl}/api/knowledge-tree/nodes/${encodeURIComponent(`notebook:${id}`)}/move`, {method:"PUT",headers:{Authorization:`Bearer ${USER}`,"Content-Type":"application/json"},body:JSON.stringify({parentId:null,sortOrder:17})});
    assert.equal(response.status,200);
    assert.equal(notices.length,1,JSON.stringify(serverDb.prepare("SELECT entityType,userId,workspaceId FROM sync_changes_v2 WHERE sequence>?").all(before))); assert.equal(notices[0].recipient,USER);
    assert.equal(notices[0].committed,true); assert.equal(notices[0].sortOrder,17);
    assert.deepEqual(Object.keys(notices[0].notice).sort(),["accessFingerprint","scopeKey","sequence","type"]);
    assert.equal(notices[0].notice.type,"sync.changed"); assert.equal(notices[0].notice.scopeKey,"personal");
    const rejected = await fetch(`${serverUrl}/api/knowledge-tree/nodes/${encodeURIComponent(`notebook:${id}`)}/move`, {method:"PUT",headers:{Authorization:"Bearer other-user","Content-Type":"application/json"},body:JSON.stringify({parentId:null,sortOrder:18})});
    assert.equal(rejected.status,403); assert.equal(notices.length,1);
  } finally {setSyncBroadcaster(null);}
  await c.sync();
  assert.equal((await c.db.query<{sortOrder:number}>("SELECT sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${id}`]))[0].sortOrder,17);
});

test("invalid remote tree rolls back incremental bodies and structure without acknowledging the cursor", async () => {
  const c = await client("structure-invalid"), note = randomUUID();
  await c.repository.createPersonalTreeNote({ id: note, contentFormat: "markdown", content: "Before invalid tree" }, null);
  await c.sync();
  const checkpoint = (await c.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=?", [c.profileId]))[0].lastSequence;
  const original = (await c.db.query("SELECT * FROM native_knowledge_tree_nodes WHERE id=?", [`note:${note}`]))[0];
  serverDb.prepare("UPDATE notes SET content='After remote edit',version=version+1 WHERE id=?").run(note);
  serverDb.prepare("UPDATE knowledge_tree_nodes SET sortOrder=sortOrder+1 WHERE id=?").run(`note:${note}`);
  afterSnapshot = async (response) => {
    const body = await response.json() as {items:Array<{entityId:string;entityType:string;payload:Record<string,unknown>}>};
    for (const item of body.items || []) if (item.entityType === "knowledge_tree_node" && item.entityId === `note:${note}`) item.payload.parentId = item.entityId;
    return Response.json(body, {status:response.status});
  };
  try { await c.sync(); } finally { afterSnapshot = undefined; }
  assert.equal((await c.repository.notes.get(note))?.content, "Before invalid tree");
  assert.deepEqual((await c.db.query("SELECT * FROM native_knowledge_tree_nodes WHERE id=?", [`note:${note}`]))[0], original);
  const state = (await c.db.query<{lastSequence:number;lastError:string}>("SELECT lastSequence,lastError FROM sync_state WHERE profileId=?", [c.profileId]))[0];
  assert.equal(state.lastSequence, checkpoint); assert.equal(state.lastError, "INVALID_TREE_STRUCTURE");
  assert.equal((serverDb.prepare("SELECT lastSequence FROM sync_v2_clients WHERE deviceId=? AND userId=? AND scopeKey='personal'").get("structure-invalid", USER) as {lastSequence:number}).lastSequence, checkpoint);
  await c.sync();
  assert.equal((await c.repository.notes.get(note))?.content, "After remote edit");
});

test("native structural Apply rejects foreign scopes, identities and missing dependencies without altering Outbox", async () => {
  const c = await client("structure-validation"), id = randomUUID();
  await c.repository.notebooks.create({ id, name: "Validation" });
  const entry = { entityId:`notebook:${id}`, payload: { id:`notebook:${id}`, userId:USER, workspaceId:null,
    parentId:null, nodeType:"folder", resourceType:"notebook", resourceId:id, sortOrder:0, isDeleted:0, deletedAt:null, createdAt:"now", updatedAt:"now" } };
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[entry],USER,true));
  const queued = await pending(c);
  for (const patch of [{userId:"other-user"}, {workspaceId:"foreign"}, {scopeKey:"workspace:foreign"}, {resourceId:"missing"}, {parentId:"notebook:missing"}, {sortOrder:Number.MAX_SAFE_INTEGER+1}, {sortOrder:1.5}, {nodeType:"file"}, {parentId:entry.entityId}]) {
    await assert.rejects(c.db.transaction((tx) => applyNativePersonalTree(tx,[{...entry,payload:{...entry.payload,...patch}}],USER,true)), {code:"INVALID_TREE_STRUCTURE"});
    assert.deepEqual((await c.db.query("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [entry.entityId]))[0], {parentId:null,sortOrder:0});
    assert.deepEqual(await pending(c), queued);
  }
});

test("native file tree metadata requires its scoped attachment without claiming bytes or authorization", async () => {
  const c = await client("structure-file"), note = randomUUID(), file = randomUUID();
  await c.repository.createPersonalTreeNote({ id:note, contentFormat:"markdown", content:"Attachment owner" },null);
  const root = {entityId:`note:${note}`,payload:{id:`note:${note}`,userId:USER,workspaceId:null,parentId:null,nodeType:"markdown",resourceType:"note",resourceId:note,sortOrder:0,isDeleted:0,deletedAt:null,createdAt:"now",updatedAt:"now"}};
  const entry = {entityId:`file:${file}`,payload:{...root.payload,id:`file:${file}`,parentId:root.entityId,nodeType:"file",resourceType:"file",resourceId:file}};
  await assert.rejects(c.db.transaction((tx) => applyNativePersonalTree(tx,[root,entry],USER,true)), {code:"INVALID_TREE_STRUCTURE"});
  await c.db.run(`INSERT INTO attachments (id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,available,transferStatus,createdAt,updatedAt)
    VALUES (?,'personal',NULL,?,?,'fixture.txt','text/plain',1,0,'remote','now','now')`, [file,note,USER]);
  const queued = await pending(c);
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[root,entry],USER,true));
  assert.equal((await c.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?", [entry.entityId]))[0].parentId, root.entityId);
  assert.equal((await c.db.query<{available:number}>("SELECT available FROM attachments WHERE id=?", [file]))[0].available, 0);
  assert.deepEqual(await pending(c), queued);
  assert.equal((await c.db.query("SELECT key FROM native_runtime_meta WHERE key LIKE 'knowledgeTreeSnapshot:%'")).length, 0);
});

test("native structural Apply validates final ancestry and deletes parent/child in either order", async () => {
  const c = await client("structure-reversal"), a = randomUUID(), b = randomUUID();
  for (const id of [a,b]) await c.repository.notebooks.create({ id, name:"Reversal" });
  const entry = (id:string,parentId:string|null) => ({entityId:`notebook:${id}`,payload:{id:`notebook:${id}`,userId:USER,workspaceId:null,parentId,
    nodeType:"folder",resourceType:"notebook",resourceId:id,sortOrder:0,isDeleted:0,deletedAt:null,createdAt:"now",updatedAt:"now"}});
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[entry(a,`notebook:${b}`),entry(b,null)],USER,true));
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[entry(b,`notebook:${a}`),entry(a,null)],USER,false));
  await assert.rejects(c.db.transaction((tx) => applyNativePersonalTree(tx,[{entityId:`notebook:${a}`,payload:{__delete:true}}],USER,false)), {code:"INVALID_TREE_STRUCTURE"});
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes")).length, 2);
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[a,b].map((id) => ({entityId:`notebook:${id}`,payload:{__delete:true}})),USER,false));
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes")).length, 0);
  assert.equal((await pending(c)).length, 2, "structural deletes do not delete business rows or queued changes");
});

test("native tree Snapshot reconciles stale metadata after remote permanent deletion", async () => {
  const c = await client("structure-prune"), note = randomUUID();
  await c.repository.createPersonalTreeNote({ id:note, contentFormat:"markdown", content:"Deleted remote root" },null);
  await c.sync();
  serverDb.prepare("DELETE FROM notes WHERE id=?").run(note);
  await c.db.run("UPDATE sync_state SET accessStatus='replan_required' WHERE profileId=?", [c.profileId]);
  await c.sync();
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?", [`note:${note}`])).length, 0);
});

test("tree create rolls back body, root container and provenance when Outbox insertion fails", async () => {
  const c = await client("tree-rollback"), id = randomUUID();
  await c.db.run("CREATE TRIGGER reject_tree_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END");
  await assert.rejects(c.repository.createPersonalTreeNote({ id, contentFormat: "markdown" }, null), /outbox failure/);
  assert.equal(await c.repository.notes.get(id), null);
  assert.equal((await c.db.query("SELECT id FROM notebooks")).length, 0);
  assert.equal((await c.repository.listLocalTreeDrafts()).length, 0);
});

test("authorized hydration persists a remote body without creation mutations and preserves newer local writes", async () => {
  const c = await client("hydrate"), id = randomUUID(), book = randomUUID();
  const notebook = { id: book, userId: USER, workspaceId: null, name: "Remote folder", parentId: null } as never;
  const remote = { id, userId: USER, workspaceId: null, notebookId: book, title: "Remote", content: "remote body", contentFormat: "markdown", version: 4 } as never;
  await c.repository.hydrateAuthorizedNote(remote, notebook);
  assert.equal((await c.repository.notes.get(id))?.content, "remote body");
  assert.equal((await pending(c)).length, 0);
  await c.repository.notes.update(id, { content: "new local body" });
  await c.repository.hydrateAuthorizedNote(remote, notebook);
  assert.equal((await c.repository.notes.get(id))?.content, "new local body");
  assert.equal((await pending(c))[0].baseVersion, 4);
  await assert.rejects(c.repository.notes.remove(id), { code: "NOTE_NOT_TRASHED" });
  assert.equal((await c.repository.notes.get(id))?.content, "new local body");
  assert.equal((await pending(c)).length, 1);
  await c.repository.notes.update(id, { isTrashed: 1, trashedAt: new Date().toISOString() });
  await c.repository.notes.remove(id);
  await assert.rejects(c.repository.hydrateAuthorizedNote(remote, notebook), /本机.*删除/);
  assert.equal(await c.repository.notes.get(id), null);
  await assert.rejects(c.repository.hydrateAuthorizedNote({ ...remote, id: randomUUID(), userId: "other-user" }, notebook), /身份|空间/);
});

test("workspace Snapshot pruning preserves pending descendants, unresolved conflicts and local attachment bytes", async () => {
  const c = await client("prune-native");
  const key = "workspace:prune", book = randomUUID(), pendingNote = randomUUID(), conflictedNote = randomUUID(), attachment = randomUUID();
  await c.db.run("INSERT INTO notebooks (id,scopeKey,workspaceId,userId,name,createdAt,updatedAt) VALUES (?,?,'prune',?,'Book','now','now')", [book,key,USER]);
  for (const id of [pendingNote, conflictedNote]) await c.db.run("INSERT INTO notes (id,scopeKey,workspaceId,userId,notebookId,title,content,createdAt,updatedAt) VALUES (?,?,'prune',?,?,'Title','retained','now','now')", [id,key,USER,book]);
  await c.db.run("INSERT INTO sync_outbox (id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,createdAt) VALUES (?,?,?,?,?,'note',?,'upsert','{}','now')", [randomUUID(),randomUUID(),c.profileId,"prune-native",key,pendingNote]);
  await c.db.run("INSERT INTO sync_conflicts (id,profileId,scopeKey,entityType,entityId,localPayload,remotePayload,createdAt) VALUES (?,?,?,'note',?,'{}','{}','now')", [randomUUID(),c.profileId,key,conflictedNote]);
  await c.db.run("INSERT INTO attachments (id,scopeKey,workspaceId,userId,noteId,filename,mimeType,size,localPath,available,transferStatus,createdAt,updatedAt) VALUES (?,?,'prune',?,?,'a.png','image/png',4,'fixture',1,'pending_upload','now','now')", [attachment,key,USER,pendingNote]);
  await (c.engine as unknown as { pruneWorkspaceSnapshot(s: unknown, seen: Map<string,Set<string>>): Promise<void> }).pruneWorkspaceSnapshot({ ...scope, scopeKey: key, workspaceId: "prune" }, new Map());
  assert.equal((await c.db.query("SELECT id FROM notes WHERE scopeKey=?", [key])).length, 2);
  assert.equal((await c.db.query("SELECT id FROM notebooks WHERE scopeKey=?", [key])).length, 1);
  assert.equal((await c.db.query("SELECT id FROM attachments WHERE scopeKey=?", [key])).length, 1);
  assert.deepEqual(c.removedFiles, []);
});

test("create then permanent delete between Pulls advances the cursor without a missing Snapshot error", async () => {
  const a = await client("fold-a"), b = await client("fold-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.sync(); await b.sync();
  await a.repository.notes.create({ id, notebookId: book, content: "temporary" });
  await a.sync();
  await a.repository.notes.update(id, { isTrashed: 1, trashedAt: new Date().toISOString() });
  await a.sync();
  await a.repository.notes.remove(id);
  await a.sync();
  await b.sync();
  assert.equal((await b.repository.notes.get(id)), null);
  const state = (await b.db.query<{lastError:string|null;lastSequence:number}>("SELECT lastError,lastSequence FROM sync_state WHERE profileId=?", [b.profileId]))[0];
  assert.equal(state.lastError, null);
  assert.equal(state.lastSequence, serverDb.prepare("SELECT MAX(sequence) AS seq FROM sync_changes_v2 WHERE userId=?").get(USER).seq);
});

test("three independent SQLite clients converge bidirectionally after consecutive Markdown and rich-text edits", async () => {
  for (const format of ["markdown", "tiptap-json"]) {
    const a = await client(`a-${format}`), b = await client(`b-${format}`), c = await client(`c-${format}`);
    const book = randomUUID(), id = randomUUID();
    await a.repository.notebooks.create({ id: book, name: "Book" });
    const content = format === "markdown" ? "first" : JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] });
    await a.repository.notes.create({ id, notebookId: book, content, contentFormat: format });
    await a.sync(); await b.sync(); await c.sync();
    assert.equal((await b.repository.notes.get(id))?.content, content);
    const base = (await a.repository.notes.get(id))!.version;
    await a.repository.notes.update(id, { title: "edit 1" });
    await a.repository.notes.update(id, { title: "edit 2" });
    await a.sync();
    assert.equal((await conflicts(a)).length, 0, "sequential local writes are descendants, not concurrent conflicts");
    assert.equal((await pending(a)).length, 0);
    await b.sync(); await c.sync();
    assert.equal((await b.repository.notes.get(id))?.title, "edit 2");
    assert.ok((await a.repository.notes.get(id))!.version > base);
    await b.repository.notes.update(id, { title: "from B" });
    await b.sync(); await a.sync(); await c.sync();
    assert.equal((await a.repository.notes.get(id))?.title, "from B");
    assert.equal((await c.repository.notes.get(id))?.version, (await a.repository.notes.get(id))?.version);
  }
});

test("remote permanent deletion preserves offline body, pending mutation and recoverable conflict", async () => {
  const a = await client("delete-a"), b = await client("delete-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  await b.repository.notes.update(id, { content: "offline recovery body" });
  await a.repository.notes.update(id, { isTrashed: 1, trashedAt: new Date().toISOString() });
  await a.sync();
  await a.repository.notes.remove(id); await a.sync();
  const pull = b.engine as unknown as { pull(scope: typeof scope): Promise<void> };
  await pull.pull(scope);
  assert.equal((await b.repository.notes.get(id))?.content, "offline recovery body");
  assert.equal((await pending(b)).length, 1);
  const saved = await conflicts(b);
  assert.equal(saved.length, 1);
  assert.equal(JSON.parse(saved[0].localPayload).content, "offline recovery body");
  assert.equal(JSON.parse(saved[0].remotePayload).__delete, true);
});

test("offline create survives database close/reopen and immediate local read before uploading", async () => {
  const a = await client("restart-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Offline book" });
  await a.repository.notes.create({ id, notebookId: book, content: "durable", contentFormat: "markdown" });
  const mutations = (await pending(a)).map((row) => row.mutationId);
  assert.equal((await a.repository.notes.get(id))?.content, "durable");
  await a.db.close();
  const restarted = await client("restart-a");
  assert.equal((await restarted.repository.notes.get(id))?.content, "durable");
  assert.deepEqual((await pending(restarted)).map((row) => row.mutationId), mutations);
  await restarted.sync();
  const b = await client("restart-b"); await b.sync();
  assert.equal((await b.repository.notes.get(id))?.content, "durable");
});

test("missing or invalid successful ACK version cannot claim cloud confirmation", async () => {
  const a = await client("receipt-a");
  for (const version of [null, 0, -1, "4"]) {
    await a.db.run("INSERT OR REPLACE INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,'now')", [nativeReceiptKey(a.profileId, "test-note"), JSON.stringify({ mutationId: "m", serverVersion: version })]);
    assert.equal((await readNativeNoteSyncReceipt(a.db, a.profileId, "test-note")).phase, "unverified");
  }
});

test("an old offline update cannot resurrect a permanently deleted server note", async () => {
  const a = await client("resurrect-a"), b = await client("resurrect-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  await b.repository.notes.update(id, { content: "offline retained" });
  await a.repository.notes.update(id, { isTrashed: 1, trashedAt: new Date().toISOString() });
  await a.sync();
  await a.repository.notes.remove(id); await a.sync();
  await b.sync();
  assert.equal(serverDb.prepare("SELECT id FROM notes WHERE id=?").get(id), undefined);
  assert.equal((await b.repository.notes.get(id))?.content, "offline retained");
  assert.equal((await conflicts(b)).length, 1);
});

test("apply failure rolls back the entire batch and leaves cursor and ACK unchanged", async () => {
  const a = await client("apply-a"), b = await client("apply-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  const state = await b.db.query("SELECT * FROM sync_state");
  await a.repository.notes.update(id, { content: "after failure" }); await a.sync();
  const run = b.db.transaction;
  b.db.transaction = (work) => run(async (tx) => work({ ...tx, run: async (sql, values) => {
    if (sql.includes("INSERT INTO notes")) throw new Error("SQLITE_FULL fixture");
    return tx.run(sql, values);
  } }));
  await assert.rejects((b.engine as unknown as { pull(s: typeof scope): Promise<void> }).pull(scope), /SQLITE_FULL/);
  assert.equal((await b.repository.notes.get(id))?.content, "base");
  assert.deepEqual(await b.db.query("SELECT * FROM sync_state"), state);
  b.db.transaction = run;
  await b.sync();
  assert.equal((await b.repository.notes.get(id))?.content, "after failure");
});

test("successful push replay after client ACK crash uses the same mutationId exactly once", async () => {
  const a = await client("ack-crash-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "durable ACK", contentFormat: "markdown" });
  const before = await pending(a);
  const run = a.db.transaction;
  a.db.transaction = (work) => run(async (tx) => work({ ...tx, run: async (sql, values) => {
    if (sql.includes("DELETE FROM sync_outbox WHERE mutationId")) throw new Error("ACK crash fixture");
    return tx.run(sql, values);
  } }));
  await assert.rejects((a.engine as unknown as { push(s: typeof scope): Promise<void> }).push(scope), /ACK crash/);
  assert.equal(serverDb.prepare("SELECT content FROM notes WHERE id=?").get(id)?.content, "durable ACK");
  assert.deepEqual((await pending(a)).map((row) => row.mutationId), before.map((row) => row.mutationId));
  a.db.transaction = run;
  await (a.engine as unknown as { push(s: typeof scope): Promise<void> }).push(scope);
  assert.equal((await pending(a)).length, 0);
  for (const row of before) assert.equal((serverDb.prepare("SELECT COUNT(*) AS count FROM sync_v2_applied_mutations WHERE mutationId=?").get(row.mutationId) as {count:number}).count, 1);
});

test("overlapping native writes read the latest revision inside the write transaction", async () => {
  const a = await client("overlap-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync();
  await Promise.all([
    a.repository.notes.update(id, { title: "new title" }),
    a.repository.notes.update(id, { content: "new body" }),
  ]);
  const note = await a.repository.notes.get(id);
  assert.equal(note?.title, "new title"); assert.equal(note?.content, "new body");
  const rows = await pending(a);
  assert.equal(rows[1].baseVersion, JSON.parse(rows[0].payload).version);
  await a.sync();
  assert.equal((await conflicts(a)).length, 0);
});

test("concurrent devices preserve both versions, and keep-local resolution establishes the remote base", async () => {
  const a = await client("conflict-a"), b = await client("conflict-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  await b.repository.notes.update(id, { content: "B version" });
  for (let index = 0; index < 4; index++) { await a.repository.notes.update(id, { content: "A version" }); await a.sync(); }
  await b.sync();
  const rows = await b.db.query<{id:string;localPayload:string;remotePayload:string}>("SELECT * FROM sync_conflicts WHERE profileId=? AND status='unresolved'", [b.profileId]);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].localPayload).content, "B version");
  assert.equal(JSON.parse(rows[0].remotePayload).content, "A version");
  await b.repository.notes.update(id, { content: "B edited after conflict" });
  await b.sync();
  const fork = await b.engine.forkLocalConflict(rows[0].id, "local");
  assert.equal((await b.repository.notes.get(fork))?.content, "B edited after conflict");
  await b.engine.resolveLocalConflict(rows[0].id, "keep-local");
  await b.sync();
  assert.equal((await b.repository.notes.get(id))?.version, (serverDb.prepare("SELECT version FROM notes WHERE id=?").get(id) as {version:number}).version);
  await b.repository.notes.update(id, { title: "after resolution" }); await b.sync(); await a.sync();
  assert.equal((await conflicts(b)).length, 0);
  assert.equal((await a.repository.notes.get(id))?.content, "B edited after conflict");
});

test("two edits committed during a delayed ACK survive own echo and subsequent push", async () => {
  const a = await client("delayed-a"), b = await client("delayed-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  await a.repository.notes.update(id, { content: "sent version" });
  let release!: () => void, received!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const committed = new Promise<void>((resolve) => { received = resolve; });
  afterPush = async (response) => { received(); await gate; return response; };
  const internal = a.engine as unknown as { push(s: typeof scope): Promise<void>; pull(s: typeof scope): Promise<void> };
  try {
    const pushing = internal.push(scope);
    await committed;
    await a.repository.notes.update(id, { content: "newer local 1" });
    await a.repository.notes.update(id, { content: "newer local 2" });
    release(); await pushing;
    afterPush = undefined;
    await internal.pull(scope);
    assert.equal((await conflicts(a)).length, 0, "multiple later edits must not turn own ACK into a conflict");
    assert.equal((await a.repository.notes.get(id))?.content, "newer local 2");
    assert.equal((await pending(a)).length, 2);
    await a.sync(); await b.sync();
    assert.equal((await conflicts(a)).length, 0);
    assert.equal((await b.repository.notes.get(id))?.content, "newer local 2");
  } finally { release(); afterPush = undefined; }
});

test("invalid note ACK leaves the durable mutation available for an idempotent retry", async () => {
  const a = await client("invalid-ack-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "retained", contentFormat: "markdown" });
  const before = await pending(a);
  afterPush = async (response) => {
    const json = await response.json();
    for (const result of json.results) delete result.version;
    return Response.json(json);
  };
  try {
    await assert.rejects((a.engine as unknown as {push(s:typeof scope):Promise<void>}).push(scope), /ACK/);
    assert.deepEqual((await pending(a)).map((row) => row.mutationId), before.map((row) => row.mutationId));
    assert.equal((await readNativeNoteSyncReceipt(a.db, a.profileId, id)).phase, "pending");
  } finally { afterPush = undefined; }
  await a.sync();
  assert.equal((await pending(a)).length, 0);
  assert.equal((await a.repository.notes.get(id))?.content, "retained");
});

test("a failed Outbox insertion rolls back note creation in the same SQLite transaction", async () => {
  const a = await client("outbox-failure-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  const transaction = a.db.transaction;
  a.db.transaction = (work) => transaction(async (tx) => work({ ...tx, run: async (sql, values) => {
    if (sql.includes("INSERT INTO sync_outbox")) throw new Error("Outbox full fixture");
    return tx.run(sql, values);
  } }));
  await assert.rejects(a.repository.notes.create({ id, notebookId: book, content: "must not falsely save", contentFormat: "markdown" }), /Outbox full/);
  assert.equal(await a.repository.notes.get(id), null);
  a.db.transaction = transaction;
  await a.repository.notes.create({ id, notebookId: book, content: "saved after retry", contentFormat: "markdown" });
  assert.equal((await a.repository.notes.get(id))?.content, "saved after retry");
});

test("native tree subscription completes multiple Snapshot pages before binding and survives incremental deletion", async () => {
  const c = await client("structure-pagination"), ids = Array.from({length:230},() => randomUUID());
  const insert = serverDb.prepare("INSERT INTO notebooks (id,userId,workspaceId,parentId,name,createdAt,updatedAt) VALUES (?,?,NULL,NULL,'Paged tree','now','now')");
  serverDb.transaction(() => { for (const id of ids) insert.run(id,USER); })();
  await c.sync();
  const rows = await c.db.query<{id:string}>("SELECT id FROM native_knowledge_tree_nodes");
  for (const id of ids) assert.ok(rows.some((row) => row.id === `notebook:${id}`));
  assert.equal((await c.db.query<{lastError:string|null}>("SELECT lastError FROM sync_state WHERE profileId=?", [c.profileId]))[0].lastError, null);
  serverDb.prepare("DELETE FROM notebooks WHERE id=?").run(ids[0]);
  await c.sync();
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${ids[0]}`])).length, 0);
});

async function createAssetFolder(c:Client,name:string,parentId:string|null=null):Promise<string>{
  const {queueNativeAsset}=await import("../../frontend/src/lib/nativeAssetOrganization");
  const id=randomUUID();
  await c.db.transaction(async tx=>{
    await tx.run("INSERT INTO mobile_local_attachment_folders(id,userId,name,parentId,createdAt,updatedAt) VALUES (?,?,?,?,'now','now')",[id,USER,name,parentId]);
    await queueNativeAsset(tx,{id:`folder:${id}`,kind:"folder",resourceId:id,name,parentId,deleted:0,createdAt:"now",updatedAt:"now"},USER);
  });return id;
}
async function changeAssetFolder(c:Client,id:string,patch:Record<string,unknown>):Promise<void>{
  const {queueNativeAsset,readNativeAssetMetadata}=await import("../../frontend/src/lib/nativeAssetOrganization");
  await c.db.transaction(async tx=>{
    const current=await readNativeAssetMetadata(tx,`folder:${id}`,USER);assert.ok(current);
    const next={...current,...patch};
    if(next.deleted) await tx.run("DELETE FROM mobile_local_attachment_folders WHERE id=?",[id]);
    else await tx.run("UPDATE mobile_local_attachment_folders SET name=?,parentId=? WHERE id=?",[next.name,next.parentId,id]);
    await queueNativeAsset(tx,next,USER);
  });
}

test("asset folders survive offline restart and converge with nested ancestry on three devices",async()=>{
  const a=await client("asset-first");await a.sync();
  const parent=await createAssetFolder(a,"Offline parent"),child=await createAssetFolder(a,"Offline child",parent);
  await changeAssetFolder(a,child,{name:"Renamed offline"});
  const mutations=await pending(a);assert.equal(mutations.length,3);
  await a.db.close();const reopened=await client("asset-first");assert.deepEqual(await pending(reopened),mutations);
  await reopened.sync();await reopened.sync();assert.equal((await pending(reopened)).length,0);
  const b=await client("asset-second"),c=await client("asset-third");await b.sync();await c.sync();
  for(const peer of [reopened,b,c]){
    const folder=(await peer.db.query<{name:string;parentId:string}>("SELECT name,parentId FROM mobile_local_attachment_folders WHERE id=?",[child]))[0];
    assert.equal(folder.name,"Renamed offline");assert.equal(folder.parentId,parent);
  }
  await changeAssetFolder(b,child,{parentId:null});await b.sync();await reopened.sync();
  assert.equal((await reopened.db.query<{parentId:string|null}>("SELECT parentId FROM mobile_local_attachment_folders WHERE id=?",[child]))[0].parentId,null);
  await changeAssetFolder(reopened,parent,{deleted:1});await reopened.sync();await c.sync();
  assert.equal((await c.db.query("SELECT id FROM mobile_local_attachment_folders WHERE id=?",[parent])).length,0);
  assert.equal((serverDb.prepare("SELECT json_extract(payload,'$.deleted') AS deleted FROM asset_sync_metadata WHERE id=?").get(`folder:${parent}`) as {deleted:number}).deleted,1);
});

test("asset folder enqueue failure rolls back the business row and retains existing mutations",async()=>{
  const a=await client("asset-rollback");await a.sync();const id=await createAssetFolder(a,"Before failure"),before=await pending(a);
  await a.db.run("CREATE TRIGGER asset_queue_failure BEFORE INSERT ON sync_outbox WHEN NEW.entityType='attachment_organization' BEGIN SELECT RAISE(ABORT,'asset queue failure'); END");
  await assert.rejects(changeAssetFolder(a,id,{name:"Must roll back"}),/asset queue failure/);
  assert.equal((await a.db.query<{name:string}>("SELECT name FROM mobile_local_attachment_folders WHERE id=?",[id]))[0].name,"Before failure");
  assert.deepEqual(await pending(a),before);
});

test("lost asset creation ACK replays immutable IDs and does not duplicate folders or versions",async()=>{
  const a=await client("asset-lost-ack");await a.sync();const id=await createAssetFolder(a,"Lost asset ACK"),before=await pending(a);
  afterPush=async response=>{const payload=await response.json();afterPush=undefined;return Response.json({...payload,results:[]});};
  await a.sync();assert.deepEqual(await pending(a),before);
  const version=(serverDb.prepare("SELECT version FROM asset_sync_metadata WHERE id=?").get(`folder:${id}`) as {version:number}).version;
  await a.db.close();const reopened=await client("asset-lost-ack");await reopened.sync();assert.equal((await pending(reopened)).length,0);
  assert.equal((serverDb.prepare("SELECT version FROM asset_sync_metadata WHERE id=?").get(`folder:${id}`) as {version:number}).version,version);
});

test("asset edit committed during delayed ACK remains queued and rebases to the acknowledged version",async()=>{
  const a=await client("asset-delayed");await a.sync();const id=await createAssetFolder(a,"Initial asset");await a.sync();
  await changeAssetFolder(a,id,{name:"First queued"});
  afterPush=async response=>{afterPush=undefined;await changeAssetFolder(a,id,{name:"During ACK"});return response;};
  await a.sync();
  assert.equal((await a.db.query<{name:string}>("SELECT name FROM mobile_local_attachment_folders WHERE id=?",[id]))[0].name,"During ACK");
  await a.sync();assert.equal((await pending(a)).length,0);
  assert.equal((serverDb.prepare("SELECT name FROM attachment_folders WHERE id=?").get(id) as {name:string}).name,"During ACK");
  assert.equal((await conflicts(a)).length,0);
});

test("concurrent asset folder edits preserve both versions and explicit keep-local converges",async()=>{
  const a=await client("asset-conflict-a");await a.sync();const id=await createAssetFolder(a,"Shared organization");await a.sync();
  const b=await client("asset-conflict-b");await b.sync();
  await changeAssetFolder(a,id,{name:"Device A"});await changeAssetFolder(b,id,{name:"Device B first"});await changeAssetFolder(b,id,{name:"Device B"});await a.sync();await b.sync();
  assert.equal((serverDb.prepare("SELECT name FROM attachment_folders WHERE id=?").get(id) as {name:string}).name,"Device A");
  const row=(await b.db.query<{id:string;localPayload:string;remotePayload:string}>("SELECT * FROM sync_conflicts WHERE profileId=? AND entityType='attachment_organization' AND entityId=? AND status='unresolved'",[b.profileId,`folder:${id}`]))[0];
  assert.ok(row);assert.equal(JSON.parse(row.localPayload).name,"Device B");assert.equal(JSON.parse(row.remotePayload).name,"Device A");
  await b.engine.resolveLocalConflict(row.id,"keep-local");await b.sync();await a.sync();
  assert.equal((serverDb.prepare("SELECT name FROM attachment_folders WHERE id=?").get(id) as {name:string}).name,"Device B");
  assert.equal((await a.db.query<{name:string}>("SELECT name FROM mobile_local_attachment_folders WHERE id=?",[id]))[0].name,"Device B");
});

test("asset tombstones reject stale offline resurrection without losing the offline name",async()=>{
  const a=await client("asset-delete-a");await a.sync();const id=await createAssetFolder(a,"Before deletion");await a.sync();
  const b=await client("asset-delete-b");await b.sync();await changeAssetFolder(b,id,{name:"Offline retained"});
  await changeAssetFolder(a,id,{deleted:1});await a.sync();await b.sync();
  assert.equal(serverDb.prepare("SELECT id FROM attachment_folders WHERE id=?").get(id),undefined);
  const row=(await b.db.query<{id:string;localPayload:string;remotePayload:string}>("SELECT * FROM sync_conflicts WHERE profileId=? AND entityType='attachment_organization' AND entityId=? AND status='unresolved'",[b.profileId,`folder:${id}`]))[0];
  assert.equal(JSON.parse(row.localPayload).name,"Offline retained");assert.equal(JSON.parse(row.remotePayload).deleted,1);
  await assert.rejects(b.engine.resolveLocalConflict(row.id,"keep-local"),/已删除/);
  await b.engine.resolveLocalConflict(row.id,"keep-remote");assert.equal((await b.db.query("SELECT id FROM mobile_local_attachment_folders WHERE id=?",[id])).length,0);
});

test("asset folder Apply failure retains cursor and the complete previous local graph",async()=>{
  const a=await client("asset-apply-failure");await a.sync();
  const cursor=(await a.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=? AND scopeKey='personal'",[a.profileId]))[0].lastSequence;
  const parent=randomUUID(),child=randomUUID();
  serverDb.prepare("INSERT INTO attachment_folders(id,userId,name,parentId) VALUES (?,?,'Server parent',NULL)").run(parent,USER);
  serverDb.prepare("INSERT INTO attachment_folders(id,userId,name,parentId) VALUES (?,?,'Server child',?)").run(child,USER,parent);
  await a.db.run(`CREATE TRIGGER asset_apply_failure BEFORE INSERT ON mobile_local_attachment_folders WHEN NEW.id='${child}' BEGIN SELECT RAISE(ABORT,'asset apply failure'); END`);
  await a.sync();
  assert.equal((await a.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=? AND scopeKey='personal'",[a.profileId]))[0].lastSequence,cursor);
  assert.equal((await a.db.query("SELECT id FROM mobile_local_attachment_folders WHERE id IN (?,?)",[parent,child])).length,0);
  await a.db.run("DROP TRIGGER asset_apply_failure");await a.sync();
  assert.equal((await a.db.query("SELECT id FROM mobile_local_attachment_folders WHERE id IN (?,?)",[parent,child])).length,2);
});

test("file locations travel from server to native and back without changing attachment identity or bytes metadata",async()=>{
  const {queueNativeAsset}=await import("../../frontend/src/lib/nativeAssetOrganization");
  const folder=randomUUID(),note=randomUUID(),book=randomUUID(),file=randomUUID();
  serverDb.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,?,'Asset host')").run(book,USER);
  serverDb.prepare("INSERT INTO notes(id,userId,notebookId,title,content) VALUES (?,?,?,'Asset host','{}')").run(note,USER,book);
  serverDb.prepare("INSERT INTO attachment_folders(id,userId,name) VALUES (?,?,'File destination')").run(folder,USER);
  serverDb.prepare("INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,path,hash,folderId) VALUES (?,?,?,'kept.txt','text/plain',5,'kept-path','kept-hash',?)").run(file,note,USER,folder);
  const a=await client("asset-location-a"),b=await client("asset-location-b");await a.sync();await b.sync();
  assert.equal((await a.db.query<{folderId:string}>("SELECT folderId FROM attachments WHERE id=?",[file]))[0].folderId,folder);
  await a.db.transaction(async tx=>{
    await tx.run("UPDATE attachments SET folderId=NULL WHERE id=?",[file]);
    await queueNativeAsset(tx,{id:`file:${file}`,kind:"file",resourceId:file,folderId:null,trashedAt:null,deleted:0},USER);
  });
  await a.sync();
  assert.deepEqual(await a.db.query("SELECT lastError,payload FROM sync_outbox WHERE profileId=?",[a.profileId]),[]);
  await b.sync();
  assert.equal((await b.db.query<{folderId:null}>("SELECT folderId FROM attachments WHERE id=?",[file]))[0].folderId,null);
  const stored=serverDb.prepare("SELECT id,folderId,path,hash,size FROM attachments WHERE id=?").get(file);
  assert.deepEqual(stored,{id:file,folderId:null,path:"kept-path",hash:"kept-hash",size:5});
  serverDb.prepare("UPDATE attachments SET trashedAt='server-trash',folderId=NULL WHERE id=?").run(file);await b.sync();
  assert.equal((await b.db.query<{assetTrashedAt:string}>("SELECT assetTrashedAt FROM attachments WHERE id=?",[file]))[0].assetTrashedAt,"server-trash");
  serverDb.prepare("UPDATE attachments SET trashedAt=NULL,folderId=? WHERE id=?").run(folder,file);await b.sync();
  assert.deepEqual((await b.db.query("SELECT folderId,assetTrashedAt FROM attachments WHERE id=?",[file]))[0],{folderId:folder,assetTrashedAt:null});
});

test("asset metadata is invisible to old clients and cannot cross accounts or workspace scopes",async()=>{
  const {applyMutation}=await import("../src/sync/apply");
  const {readAssetMetadata}=await import("../src/sync/assetOrganization");
  const {SYNC_V2_ASSET_ENTITY_TYPES}=await import("../src/sync/types");
  const a=await client("asset-acl");await a.sync();const id=await createAssetFolder(a,"Private asset folder");await a.sync();
  const legacy=await (await fetch(`${serverUrl}/api/sync/v2/snapshot`,{headers:{Authorization:`Bearer ${USER}`}})).json() as {items:Array<{entityType:string}>};
  assert.ok(legacy.items.every(item=>item.entityType!=="attachment_organization"));
  const payload=readAssetMetadata(serverDb,`folder:${id}`,USER)!;
  const mutation={deviceId:"other",mutationId:randomUUID(),entityType:"attachment_organization" as const,entityId:`folder:${id}`,operation:"upsert" as const,baseVersion:Number(payload.version),payload};
  assert.throws(()=>serverDb.transaction(()=>applyMutation(serverDb,{...mutation,userId:"other-user",payload:{...payload,userId:"other-user"}}))(),/无权/);
  assert.throws(()=>serverDb.transaction(()=>applyMutation(serverDb,{...mutation,userId:USER,workspaceId:"foreign"}))(),/仅支持个人/);
  const bad=await fetch(`${serverUrl}/api/sync/v2/push?entityTypes=${SYNC_V2_ASSET_ENTITY_TYPES.join(',')}&deviceId=unbound`,{method:"POST",headers:{Authorization:`Bearer ${USER}`,"Content-Type":"application/json"},body:JSON.stringify({deviceId:"unbound",scopeKey:"personal",mutations:[mutation]})});
  assert.equal(((await bad.json()) as {results:Array<{code:string}>}).results[0].code,"INVALID_PAYLOAD");
});

test("asset ACK without a version retains its original durable mutation for retry",async()=>{
  const a=await client("asset-invalid-ack");await a.sync();await createAssetFolder(a,"Invalid version ACK");const before=await pending(a);
  afterPush=async response=>{afterPush=undefined;const body=await response.json() as {results:Array<Record<string,unknown>>};return Response.json({...body,results:body.results.map(({version:_version,...result})=>result)});};
  await a.sync();assert.deepEqual(await pending(a),before);
  await a.sync();assert.equal((await pending(a)).length,0);
});

test("asset Pull loads final folder dependencies beyond its first change-feed page",async()=>{
  const a=await client("asset-paged-dependencies");await a.sync();const child=randomUUID(),parent=randomUUID();
  serverDb.prepare("INSERT INTO attachment_folders(id,userId,name) VALUES (?,?,'Early asset child')").run(child,USER);
  const rename=serverDb.prepare("UPDATE attachment_folders SET name=? WHERE id=?");
  serverDb.transaction(()=>{for(let i=0;i<505;i++)rename.run(`Page filler ${i}`,child);})();
  serverDb.prepare("INSERT INTO attachment_folders(id,userId,name) VALUES (?,?,'Later asset parent')").run(parent,USER);
  serverDb.prepare("UPDATE attachment_folders SET parentId=? WHERE id=?").run(parent,child);
  await a.sync();
  assert.equal((await a.db.query<{parentId:string}>("SELECT parentId FROM mobile_local_attachment_folders WHERE id=?",[child]))[0].parentId,parent);
  await a.sync();assert.equal((await conflicts(a)).length,0);
});

test("first asset binding preserves and synchronizes pre-existing native folders",async()=>{
  const a=await client("asset-old-folders"),parent=randomUUID(),child=randomUUID();
  await a.db.run("INSERT INTO mobile_local_attachment_folders(id,userId,name,parentId,createdAt,updatedAt) VALUES (?,?,'Existing parent',NULL,'now','now')",[parent,USER]);
  await a.db.run("INSERT INTO mobile_local_attachment_folders(id,userId,name,parentId,createdAt,updatedAt) VALUES (?,?,'Existing child',?,'now','now')",[child,USER,parent]);
  await a.sync();await a.sync();
  assert.equal((await pending(a)).length,0);
  assert.deepEqual(serverDb.prepare("SELECT name,parentId FROM attachment_folders WHERE id=?").get(child),{name:"Existing child",parentId:parent});
});

test("asset binding preserves server-generated negative root positions across native replicas",async()=>{
  const note=randomUUID(),book=randomUUID();
  serverDb.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,?,'Root host')").run(book,USER);
  serverDb.prepare("INSERT INTO notes(id,userId,notebookId,title,content,contentFormat) VALUES (?,?,?,'Root document','Public fixture','markdown')").run(note,USER,book);
  serverDb.prepare("UPDATE knowledge_tree_nodes SET sortOrder=-2147483647 WHERE id=?").run(`note:${note}`);
  const a=await client("asset-signed-root-a"),b=await client("asset-signed-root-b");
  await a.sync();
  const folder=await createAssetFolder(a,"Directory beside root document");await a.sync();await b.sync();
  for(const c of [a,b]) {
    assert.equal((await c.db.query<{sortOrder:number}>("SELECT sortOrder FROM native_knowledge_tree_nodes WHERE id=?",[`note:${note}`]))[0].sortOrder,-2147483647);
    assert.equal((await c.db.query<{name:string}>("SELECT name FROM mobile_local_attachment_folders WHERE id=?",[folder]))[0].name,"Directory beside root document");
    assert.equal((await pending(c)).length,0);
  }
});

test("native permanent deletion retains its recoverable body and attachment metadata in the durable Outbox", async () => {
  const c=await client("delete-recovery"),book=randomUUID(),id=randomUUID(),attachment=randomUUID();
  await c.repository.notebooks.create({id:book,name:"Recovery"});
  await c.repository.notes.create({id,notebookId:book,content:"offline recovery",isTrashed:1});
  await c.db.run(`INSERT INTO attachments(id,scopeKey,userId,noteId,filename,mimeType,size,localPath,available,transferStatus,createdAt,updatedAt)
    VALUES(?,'personal',?,?,'recover.png','image/png',4,'local-fixture',1,'pending_upload','now','now')`,[attachment,USER,id]);
  await c.repository.notes.remove(id);
  const row=(await c.db.query<{payload:string}>("SELECT payload FROM sync_outbox WHERE entityId=? AND entityType='note' AND operation='delete'",[id]))[0];
  assert.equal(JSON.parse(row.payload)._deletionRecovery.note.content,"offline recovery");
  assert.equal(JSON.parse(row.payload)._deletionRecovery.attachments[0].id,attachment);
  assert.deepEqual(c.removedFiles,[]);
  await c.db.close(); const reopened=await client("delete-recovery");
  assert.equal(JSON.parse((await reopened.db.query<{payload:string}>("SELECT payload FROM sync_outbox WHERE entityId=? AND operation='delete'",[id]))[0].payload)._deletionRecovery.note.content,"offline recovery");
});

test("native offline trash then permanent delete acknowledges trash before deletion and replays a lost ACK", async () => {
  // This scenario performs real HTTP requests; supply the browser URL used by authenticated fetch.
  Object.assign(window,{location:new URL("http://localhost")});
  const c=await client("delete-two-phase"),book=randomUUID(),id=randomUUID();
  await c.repository.notebooks.create({id:book,name:"Two phase"});
  await c.repository.notes.create({id,notebookId:book,content:"recovery after lost ACK"});
  await c.sync();
  await c.repository.notes.update(id,{isTrashed:1,trashedAt:new Date().toISOString()});
  await c.repository.notes.remove(id);
  await c.sync(); // Only the explicit trash stage can be acknowledged in this request.
  assert.equal(serverDb.prepare("SELECT isTrashed FROM notes WHERE id=?").get(id).isTrashed,1);
  const queued=await c.db.query<{mutationId:string;payload:string}>("SELECT mutationId,payload FROM sync_outbox WHERE entityId=? AND operation='delete'",[id]);
  assert.equal(queued.length,1);assert.equal(JSON.parse(queued[0].payload)._deletionRecovery.note.content,"recovery after lost ACK");
  afterPush=async()=>{afterPush=undefined;throw new Error("lost deletion ACK");};
  await c.sync();
  assert.equal(serverDb.prepare("SELECT id FROM notes WHERE id=?").get(id),undefined);
  assert.equal((await c.db.query<{mutationId:string}>("SELECT mutationId FROM sync_outbox WHERE entityId=? AND operation='delete'",[id]))[0].mutationId,queued[0].mutationId);
  await c.db.close();const reopened=await client("delete-two-phase");await reopened.sync();
  assert.equal((await reopened.db.query("SELECT id FROM sync_outbox WHERE entityId=? AND operation='delete'",[id])).length,0);
});

test("native deletion conflicts preserve both bodies and honor explicit keep-local and keep-remote choices",async()=>{
  Object.assign(window,{location:new URL("http://localhost")});
  for(const resolution of ["keep-local","keep-remote"] as const){
    const c=await client(`delete-choice-${resolution}`),book=randomUUID(),id=randomUUID();
    await c.repository.notebooks.create({id:book,name:"Deletion conflict"});
    await c.repository.notes.create({id,notebookId:book,content:"local retained body"});await c.sync();
    await c.repository.notes.update(id,{isTrashed:1});await c.repository.notes.remove(id);
    serverDb.prepare("UPDATE notes SET content='remote newer body',version=version+1 WHERE id=?").run(id);
    await c.sync();
    const conflict=(await c.db.query<{id:string;localPayload:string;remotePayload:string}>("SELECT id,localPayload,remotePayload FROM sync_conflicts WHERE entityId=? AND status='unresolved'",[id]))[0];
    assert.equal(JSON.parse(conflict.localPayload)._deletionRecovery.note.content,"local retained body");
    assert.equal(JSON.parse(conflict.remotePayload).content,"remote newer body");
    await c.engine.resolveLocalConflict(conflict.id,resolution);
    if(resolution === "keep-remote") assert.equal((await c.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=? AND scopeKey='personal'",[c.profileId]))[0].lastSequence,0,"restore must refresh authorized attachment metadata");
    await c.sync();await c.sync();
    if(resolution==="keep-local") assert.equal(serverDb.prepare("SELECT id FROM notes WHERE id=?").get(id),undefined);
    else {
      assert.equal((await c.repository.notes.get(id))?.content,"remote newer body");
      assert.equal(serverDb.prepare("SELECT content FROM notes WHERE id=?").get(id).content,"remote newer body");
    }
    assert.equal((await c.db.query("SELECT id FROM sync_outbox WHERE entityId=? AND operation='delete'",[id])).length,0);
    assert.equal(JSON.parse((await c.db.query<{localPayload:string}>("SELECT localPayload FROM sync_conflicts WHERE id=?",[conflict.id]))[0].localPayload)._deletionRecovery.note.content,"local retained body");
  }
});


test("native holds a terminal delete against an older server and resumes without changing its identity",async()=>{
  Object.assign(window,{location:new URL("http://localhost")});
  const c=await client("delete-old-server"),book=randomUUID(),id=randomUUID();
  await c.repository.notebooks.create({id:book,name:"Old server"});await c.repository.notes.create({id,notebookId:book,content:"retain on upgrade"});await c.sync();
  await c.repository.notes.update(id,{isTrashed:1});await c.repository.notes.remove(id);
  const row=(await c.db.query<{mutationId:string;payload:string}>("SELECT mutationId,payload FROM sync_outbox WHERE entityId=? AND operation='delete'",[id]))[0];
  legacyNoteDeletionCapabilities=true;
  try {
    await c.sync();await c.sync();
    assert.equal(serverDb.prepare("SELECT isTrashed FROM notes WHERE id=?").get(id).isTrashed,1);
    const pending=(await c.db.query<{mutationId:string;payload:string}>("SELECT mutationId,payload FROM sync_outbox WHERE entityId=? AND operation='delete'",[id]))[0];
    assert.equal(pending.mutationId,row.mutationId);assert.equal(pending.payload,row.payload);
    assert.equal((await c.db.query<{lastError:string}>("SELECT lastError FROM sync_state WHERE profileId=? AND scopeKey='personal'",[c.profileId]))[0].lastError,"NOTE_DELETION_UPGRADE_REQUIRED");
  } finally {legacyNoteDeletionCapabilities=false;}
  await c.sync();assert.equal(serverDb.prepare("SELECT id FROM notes WHERE id=?").get(id),undefined);
});

test("Agent approved edits survive offline restart and lost ACK before peer convergence", async () => {
  for (const format of ["markdown", "tiptap-json"] as const) {
  const a = await client(`agent-${format}-a`), b = await client(`agent-${format}-b`);
  const book = randomUUID(), id = randomUUID();
  const content = format === "markdown" ? "Original sentence\n\n[Keep](https://example.com)" : JSON.stringify({ type: "doc", content: [{ type: "paragraph", attrs: { blockId: "preserve" }, content: [{ type: "text", text: "Original sentence", marks: [{ type: "bold" }] }] }] });
  await a.repository.notebooks.create({ id: book, name: "Agent sync fixture" });
  await a.repository.notes.create({ id, notebookId: book, content, contentFormat: format });
  await a.sync(); await b.sync();
  const { setUserAISettings } = await import("../src/services/user-ai-settings");
  setUserAISettings(USER, [{ key: "ai_api_url", value: "https://agent-provider.example" }, { key: "ai_model", value: "fixture" }, { key: "ai_api_key", value: "agent-sync-fixture-key" }]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "https://agent-provider.example/chat/completions") return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    const hasContext = body.messages.some((m: any) => m.role === "tool");
    const fn = hasContext ? { name: "propose_note_edit", arguments: JSON.stringify({ edits: [{ before: "Original", after: "Improved" }] }) } : { name: "get_current_note_context", arguments: "{}" };
    return Response.json({ choices: [{ message: { tool_calls: [{ id: hasContext ? "edit" : "read", type: "function", function: fn }] } }] });
  }) as typeof fetch;
  const headers = { Authorization: `Bearer ${USER}`, "Content-Type": "application/json" };
  const post = (url: string, body = {}) => realFetch(`${serverUrl}/api/agent${url}`, { method: "POST", headers, body: JSON.stringify(body) });
  let runId: string | undefined;
  try {
    const snapshot = (await a.repository.notes.get(id))!;
    const created = await post("/runs", { noteId: id, instruction: "Improve wording without changing links or formatting", content: snapshot.content, format, version: snapshot.version });
    assert.equal(created.status, 202); runId = (await created.json()).id;
    let run: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      run = await (await realFetch(`${serverUrl}/api/agent/runs/${runId}`, { headers })).json();
      if (!["queued", "running"].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(run.status, "waiting_approval");
    const approved = await post(`/runs/${runId}/approve`, { token: run.proposal.token, snapshot: snapshot.content });
    assert.equal(approved.status, 200); const proposal = await approved.json();
    await a.repository.notes.update(id, { content: proposal.result, contentText: "Improved sentence" });
    const queued = await pending(a); assert.equal(queued.length, 1);
    assert.equal((await post(`/runs/${runId}/receipt`)).status, 409);
    assert.equal((await b.repository.notes.get(id))?.content, snapshot.content);
    await a.db.close(); const reopened = await client(`agent-${format}-a`);
    assert.deepEqual(await pending(reopened), queued);
    assert.equal((await reopened.repository.notes.get(id))?.content, proposal.result);
    afterPush = async response => {
      const result = await response.json(); for (const item of result.results) delete item.version;
      return Response.json(result);
    };
    try { await assert.rejects((reopened.engine as unknown as { push(s: typeof scope): Promise<void> }).push(scope), /ACK/); }
    finally { afterPush = undefined; }
    assert.deepEqual((await pending(reopened)).map(row => row.mutationId), queued.map(row => row.mutationId));
    assert.equal((await readNativeNoteSyncReceipt(reopened.db, reopened.profileId, id)).phase, "pending");
    // Agent persistence confirmation must not acknowledge a native client's Outbox.
    assert.equal((await (await post(`/runs/${runId}/receipt`)).json()).status, "completed");
    assert.deepEqual((await pending(reopened)).map(row => row.mutationId), queued.map(row => row.mutationId));
    const version = (serverDb.prepare("SELECT version FROM notes WHERE id=?").get(id) as { version: number }).version;
    await reopened.sync(); await b.sync();
    assert.equal((await pending(reopened)).length, 0);
    assert.equal((await readNativeNoteSyncReceipt(reopened.db, reopened.profileId, id)).phase, "confirmed");
    assert.equal((serverDb.prepare("SELECT version FROM notes WHERE id=?").get(id) as { version: number }).version, version);
    assert.equal((await b.repository.notes.get(id))?.content, proposal.result);
    assert.equal((await reopened.repository.notes.get(id))?.content, proposal.result);
    assert.equal((await conflicts(reopened)).length, 0);
  } finally {
    globalThis.fetch = realFetch; afterPush = undefined;
    if (runId) await post(`/runs/${runId}/cancel`);
  }
  }
});
