import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { completedOnLocalDay } from "../src/lib/taskLifecycle";

const directory = fs.mkdtempSync(path.join(os.tmpdir(),"nowen-task-lifecycle-"));
process.env.DB_PATH = path.join(directory,"test.db");
process.env.ELECTRON_USER_DATA = directory;
let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let notebookId: string;
let storage: typeof import("../src/services/attachment-storage.js");

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const schema = await import("../src/db/schema.js"); db = schema.getDb(); closeDb = schema.closeDb;
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  for (const user of ["owner","stranger"]) db.prepare("INSERT INTO users (id,username,passwordHash) VALUES (?,?,'hash')").run(user,user);
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  notebookId = createKnowledgeChild({ actorUserId:"owner",workspaceId:null,parentId:null,nodeType:"folder",title:"Snapshots",db }).resourceId;
  storage = await import("../src/services/attachment-storage.js");
  app = new Hono(); app.route("/tasks",(await import("../src/routes/tasks.js")).default);
  app.route("/task-reminders",(await import("../src/routes/task-reminders.js")).default);
  app.route("/task-dependencies",(await import("../src/routes/task-dependencies.js")).default);
});
test.after(() => { closeDb?.(); fs.rmSync(directory,{recursive:true,force:true}); });
function create(parentId: string | null = null, completed = true) {
  const id = randomUUID();
  db.prepare("INSERT INTO tasks (id,userId,title,description,parentId,isCompleted,status,completedAt) VALUES (?,'owner','Task','Saved description',?,?,?,?)")
    .run(id,parentId,completed ? 1 : 0,completed ? "done" : "todo",completed ? new Date().toISOString() : null);
  return id;
}
async function request(url: string, method = "GET", body?: unknown, user = "owner") {
  const response = await app.request(url,{method,headers:{"X-User-Id":user,"Content-Type":"application/json"},body:body === undefined ? undefined : JSON.stringify(body)});
  const text = await response.text();
  return {status:response.status,body:response.headers.get("Content-Type")?.includes("json") ? JSON.parse(text) : text};
}
test("daily completion uses the user's local midnight and ignores due date, reopened tasks and unknown history",() => {
  const now = new Date("2026-10-13T00:30:00+08:00");
  assert.equal(completedOnLocalDay({isCompleted:1,completedAt:"2026-10-12T16:10:00Z"},"Asia/Shanghai",now),true);
  assert.equal(completedOnLocalDay({isCompleted:1,completedAt:"2026-10-12T15:59:59Z"},"Asia/Shanghai",now),false);
  assert.equal(completedOnLocalDay({isCompleted:0,completedAt:now.toISOString()},"Asia/Shanghai",now),false);
  assert.equal(completedOnLocalDay({isCompleted:1,completedAt:null},"Asia/Shanghai",now),false);
  assert.equal(completedOnLocalDay({isCompleted:1,completedAt:"2026-10-12 16:10:00"},"Asia/Shanghai",now),true);
});
test("imported completed tasks with unknown or old completion dates are not counted as today's work",async () => {
  const unknown=await request("/tasks","POST",{title:"Imported unknown date",status:"done",completedAt:null});
  const old=await request("/tasks","POST",{title:"Imported old date",status:"done",completedAt:"2025-01-01T12:00:00Z"});
  assert.equal(unknown.status,201);assert.equal(unknown.body.completedAt,null);assert.equal(old.status,201);
  const today=await request("/tasks?filter=completed-today&timezone=Asia/Shanghai");
  assert.ok(!today.body.some((task:any) => [unknown.body.id,old.body.id].includes(task.id)));
});
test("archive and restore retain a deep completed task tree and its daily completion history",async () => {
  const root = create(); const child = create(root); const grandchild = create(child);
  const before = db.prepare("SELECT * FROM tasks WHERE id=?").get(grandchild) as any;
  const archived = await request(`/tasks/${root}/archive`,"PATCH",{archived:true}); assert.equal(archived.status,200); assert.equal(archived.body.affected,3);
  assert.equal((await request("/tasks")).body.some((task:any) => task.id === root),false);
  assert.equal((await request("/tasks?filter=archived")).body.filter((task:any) => [root,child,grandchild].includes(task.id)).length,3);
  assert.equal((await request("/tasks?filter=completed-today&timezone=Asia/Shanghai")).body.some((task:any) => task.id === root),true);
  assert.equal((await request(`/tasks/${child}/toggle`,"PATCH")).status,409);
  assert.equal((await request(`/tasks/${root}`,"PUT",{title:"Cannot edit"})).status,409);
  assert.equal((await request(`/tasks/${root}/archive`,"PATCH",{archived:false})).status,200);
  const after = db.prepare("SELECT * FROM tasks WHERE id=?").get(grandchild) as any;
  for (const field of ["title","description","parentId","isCompleted","completedAt","sortOrder"]) assert.equal(after[field],before[field]);
  assert.equal(after.archivedAt,null);
});
test("archive rejects incomplete descendants, child-only operations and unauthorized actors without changing the tree",async () => {
  const root = create(); const child = create(root,false);
  assert.equal((await request(`/tasks/${root}/archive`,"PATCH",{archived:true})).status,409);
  assert.equal((await request(`/tasks/${child}/archive`,"PATCH",{archived:true})).status,409);
  assert.equal((await request(`/tasks/${root}/archive`,"PATCH",{archived:true},"stranger")).status,403);
  assert.equal((db.prepare("SELECT archivedAt FROM tasks WHERE id=?").get(root) as any).archivedAt,null);
});
test("archive rolls back the whole subtree when a later write fails",async () => {
  const root = create(); const child = create(root);
  db.exec(`CREATE TRIGGER fail_archive BEFORE UPDATE OF archivedAt ON tasks WHEN NEW.id='${child}' BEGIN SELECT RAISE(ABORT,'injected archive failure'); END`);
  try { assert.equal((await request(`/tasks/${root}/archive`,"PATCH",{archived:true})).status,500); }
  finally { db.exec("DROP TRIGGER fail_archive"); }
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id IN (?,?) AND archivedAt IS NOT NULL").get(root,child) as any).count,0);
});
test("saving a task note copies the latest draft and attachment bytes, preserves the source, and is idempotent",async () => {
  const task = create(); const attachmentId = randomUUID(); const sourcePath = "2026/10/task-snapshot-source.txt";
  await storage.writeAttachmentObject(sourcePath,Buffer.from("independent attachment"),"text/plain");
  db.prepare("INSERT INTO task_attachments (id,taskId,userId,filename,mimeType,size,path) VALUES (?,?,'owner','report.txt','text/plain',22,?)").run(attachmentId,task,sourcePath);
  const body = {requestId:randomUUID(),notebookId,title:"Latest title",description:`Unsaved draft\n\n[file](/api/task-attachments/${attachmentId})`};
  const saved = await request(`/tasks/${task}/note`,"POST",body); assert.equal(saved.status,201);
  assert.equal(saved.body.title,"Latest title"); assert.match(saved.body.content,/Unsaved draft/); assert.doesNotMatch(saved.body.content,/task-attachments/);
  assert.equal((db.prepare("SELECT description FROM tasks WHERE id=?").get(task) as any).description,"Saved description");
  const copy = db.prepare("SELECT * FROM attachments WHERE noteId=?").get(saved.body.id) as any;
  assert.notEqual(copy.path,sourcePath);
  await storage.deleteAttachmentObject(sourcePath); db.prepare("DELETE FROM task_attachments WHERE id=?").run(attachmentId);
  assert.equal((await storage.readAttachmentObject(copy.path))?.toString(),"independent attachment");
  const repeated = await request(`/tasks/${task}/note`,"POST",body); assert.equal(repeated.status,201); assert.equal(repeated.body.id,saved.body.id);
  assert.equal((await request(`/tasks/${task}/note`,"POST",{...body,description:"Changed draft"})).status,409);
});
test("snapshot refuses inaccessible or missing attachments and leaves no partial note",async () => {
  const task = create(); const before = (db.prepare("SELECT COUNT(*) AS count FROM notes").get() as any).count;
  const body = {requestId:randomUUID(),notebookId,title:"No partial copy",description:"[missing](/api/task-attachments/missing)"};
  assert.equal((await request(`/tasks/${task}/note`,"POST",body)).status,409);
  assert.equal((await request(`/tasks/${task}/note`,"POST",body,"stranger")).status,403);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes").get() as any).count,before);
});

test("archived tasks reject mixed batch completion without changing active tasks", async () => {
  const archived = create(), active = create(null, false);
  assert.equal((await request(`/tasks/${archived}/archive`,"PATCH",{archived:true})).status,200);
  const result = await request("/tasks/batch","POST",{ids:[archived,active],action:"complete"});
  assert.equal(result.status,409); assert.equal(result.body.code,"TASK_ARCHIVED");
  assert.equal((db.prepare("SELECT isCompleted FROM tasks WHERE id=?").get(active) as any).isCompleted,0);
});

test("archived trees retain reminders and dependencies while preventing their modification", async () => {
  const root = create(), other = create();
  const reminder = await request(`/task-reminders/${root}`,"POST",{offsetMinutes:30});
  assert.equal(reminder.status,201);
  const link = await request("/task-dependencies","POST",{predecessorTaskId:root,successorTaskId:other});
  assert.equal(link.status,201);
  assert.equal((await request(`/tasks/${root}/archive`,"PATCH",{archived:true})).status,200);
  assert.equal((await request(`/task-reminders/${root}`,"POST",{offsetMinutes:60})).status,409);
  assert.equal((await request(`/task-reminders/${reminder.body.id}`,"PUT",{enabled:false})).status,409);
  assert.equal((await request(`/task-reminders/${reminder.body.id}`,"DELETE")).status,409);
  assert.equal((await request("/task-dependencies","POST",{predecessorTaskId:other,successorTaskId:root})).status,409);
  assert.equal((await request(`/task-dependencies/${link.body.id}`,"DELETE")).status,409);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM task_reminders WHERE id=?").get(reminder.body.id) as any).count,1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM task_dependencies WHERE id=?").get(link.body.id) as any).count,1);
  assert.equal((await request(`/tasks/${root}/archive`,"PATCH",{archived:false})).status,200);
  assert.equal((await request(`/task-reminders/${reminder.body.id}`,"DELETE")).status,200);
  assert.equal((await request(`/task-dependencies/${link.body.id}`,"DELETE")).status,200);
});
