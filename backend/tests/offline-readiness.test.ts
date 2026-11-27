import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '../src/db/schema';
import { createProfile } from '../src/sync/profile';
import { markBootstrapReady } from '../src/sync/bootstrap';
import { markKnowledgeTreeSyncReady } from '../src/sync/knowledgeTreeReadiness';
import { readOfflineReadiness } from '../src/sync/offlineReadiness';
import { writeAttachmentObject } from '../src/services/attachment-storage';

function seed() {
  const db = getDb(), userId = randomUUID(), book = randomUUID(), note = randomUUID();
  db.prepare("INSERT INTO users(id,username,passwordHash,createdAt,updatedAt) VALUES (?,?,'x',datetime('now'),datetime('now'))").run(userId,userId);
  db.prepare("INSERT INTO notebooks(id,userId,name,createdAt,updatedAt) VALUES (?,?,'book',datetime('now'),datetime('now'))").run(book,userId);
  db.prepare("INSERT INTO notes(id,userId,notebookId,title,content,createdAt,updatedAt) VALUES (?,?,?,'note','offline body',datetime('now'),datetime('now'))").run(note,userId,book);
  const profile = createProfile(db,{name:'NAS',serverUrl:`https://${userId}.test`});
  markBootstrapReady(db,profile.id,7); markKnowledgeTreeSyncReady(db,profile.id);
  return {db,userId,note,profile};
}

test('DCC-005: offline readiness verifies bounded batches of actual files, including when sync is paused', async () => {
  const {db,userId,note,profile} = seed();
  for(let i=0;i<35;i++) {
    const id=randomUUID(), file=`offline-test/${id}.txt`;
    db.prepare("INSERT INTO attachments(id,userId,noteId,filename,mimeType,path,size,createdAt) VALUES (?,?,?,'x.txt','text/plain',?,3,datetime('now'))").run(id,userId,note,file);
    await writeAttachmentObject(file,Buffer.from('abc'));
  }
  const first=await readOfflineReadiness(db,profile.id,userId);
  assert.equal(first.verificationPending,true); assert.equal(first.fullyAvailable,false);
  const next=await readOfflineReadiness(db,profile.id,userId);
  assert.equal(next.attachments.available,35); assert.equal(next.fullyAvailable,true);
  assert.equal(db.prepare('SELECT enabled FROM sync_profiles WHERE id=?').get(profile.id)?.enabled,0);
});

test('DCC-007: a missing file remains visible and queued for download without deleting its note', async () => {
  const {db,userId,note,profile} = seed(), id=randomUUID();
  db.prepare("INSERT INTO attachments(id,userId,noteId,filename,mimeType,path,size,createdAt) VALUES (?,?,?,'x','text/plain','missing/file',3,datetime('now'))").run(id,userId,note);
  const result=await readOfflineReadiness(db,profile.id,userId);
  assert.equal(result.fullyAvailable,false); assert.equal(result.attachments.missingFiles,1);
  const state=db.prepare('SELECT remoteOnly,lastError FROM attachment_sync_state WHERE attachmentId=?').get(id) as {remoteOnly:number;lastError:string};
  assert.equal(state.remoteOnly,1); assert.equal(state.lastError,'LOCAL_FILE_MISSING');
  assert.equal((db.prepare('SELECT content FROM notes WHERE id=?').get(note) as {content:string}).content,'offline body');
  const other=seed();
  assert.equal((await readOfflineReadiness(db,other.profile.id,other.userId)).attachments.total,0);
});

test('DCC-005: offline readiness preserves verified attachment counts across incremental sync updates instead of resetting to zero', async () => {
  const {db,userId,note,profile} = seed();
  for(let i=0;i<70;i++) {
    const id=randomUUID(), file=`offline-monotonic/${id}.txt`;
    db.prepare("INSERT INTO attachments(id,userId,noteId,filename,mimeType,path,size,createdAt) VALUES (?,?,?,'x.txt','text/plain',?,3,datetime('now'))").run(id,userId,note,file);
    await writeAttachmentObject(file,Buffer.from('abc'));
  }
  const r1 = await readOfflineReadiness(db,profile.id,userId);
  assert.equal(r1.attachments.available, 32);
  assert.equal(r1.verificationPending, true);

  const r2 = await readOfflineReadiness(db,profile.id,userId);
  assert.equal(r2.attachments.available, 64);

  // 模拟后台同步新下载完成 1 个附件：旧实现会因 fingerprint 变化把 available 重置回 32
  const addedId = randomUUID(), addedFile = `offline-monotonic/${addedId}.txt`;
  db.prepare("INSERT INTO attachments(id,userId,noteId,filename,mimeType,path,size,createdAt) VALUES (?,?,?,'added.txt','text/plain',?,3,datetime('now'))").run(addedId,userId,note,addedFile);
  await writeAttachmentObject(addedFile,Buffer.from('abc'));

  const r3 = await readOfflineReadiness(db,profile.id,userId);
  assert.equal(r3.attachments.total, 71);
  assert.equal(r3.attachments.available, 71, '新增附件或状态变化时已校验的附件数不得归零重头再数');
  assert.equal(r3.verificationPending, false);
  assert.equal(r3.fullyAvailable, true);
});
