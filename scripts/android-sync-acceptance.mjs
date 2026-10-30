// Runs only against the separate com.nowen.note.syncacceptance debug APK.
// Requires backend/tests/sync-v2-android-server.ts on loopback port 47831.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { _android } = require("@playwright/test");
const serial = process.argv[2];
if (!serial) throw new Error("Pass the isolated test device serial");
const adbPath = process.env.ADB || path.join(process.env.LOCALAPPDATA, "Android/Sdk/platform-tools/adb.exe");
const adb = (...args) => execFileSync(adbPath, ["-s", serial, ...args], { encoding: "utf8", timeout: 30_000 });
const base = "http://127.0.0.1:47831";
const config = await (await fetch(`${base}/acceptance/config`)).json();
let browser, page;
async function attach() {
  const devices = await _android.devices();
  browser = devices.find((device) => device.serial() === serial);
  assert.ok(browser, "isolated acceptance device is available");
  page = await (await browser.webView({ pkg: "com.nowen.note.syncacceptance" })).page();
  await page.goto("https://localhost/tests/android-sync/index.html");
  await page.waitForFunction(() => typeof window.initializeAcceptance === "function");
  await page.evaluate(async (config) => {
    await window.initializeAcceptance(config);
  }, config);
  await page.waitForFunction(() => !!window.acceptance, { timeout: 20_000 });
}
async function wait(work, message, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await work()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
const native = (method, ...args) => page.evaluate(({ method, args }) => window.acceptance[method](...args), { method, args });
const serverNote = async (id) => (await fetch(`${base}/acceptance/note/${id}`)).json();
const remoteEdit = async (id, text) => {
  const response = await fetch(`${base}/acceptance/edit/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  assert.ok(response.ok);
  const body = await response.json();
  assert.equal(body.results[0].status, "applied");
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
const stats = (values) => ({ samples: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99) });
try {
  await attach();
  adb("reverse", "--remove", "tcp:47831");
  const unreachable = await page.evaluate(async () => {
    try { await fetch("http://127.0.0.1:47831/acceptance/config"); return false; }
    catch { return true; }
  });
  assert.ok(unreachable, "Android cannot reach the test server during offline edits");
  await native("start");
  const ids = await native("createOffline");
  let rows = await native("status");
  assert.deepEqual(rows.map((r) => r.note.contentText), ["offline-markdown", "offline-rich"]);
  assert.ok(rows.every((r) => r.receipt.phase === "pending"));
  await browser.close();
  adb("shell", "am", "force-stop", "com.nowen.note.syncacceptance");
  adb("shell", "am", "start", "-n", "com.nowen.note.syncacceptance/com.nowen.note.MainActivity");
  await attach();
  rows = await native("status");
  assert.deepEqual(rows.map((r) => r.note.id), ids);
  assert.deepEqual(rows.map((r) => r.note.contentText), ["offline-markdown", "offline-rich"]);
  assert.ok(rows.every((r) => r.receipt.phase === "pending"));
  adb("reverse", "tcp:47831", "tcp:47831");
  await native("start");
  await wait(async () => (await native("status")).every((r) => r.receipt.phase === "confirmed"), "offline edits not acknowledged");
  const download = [], upload = [];
  for (let i = 0; i < 30; i++) {
    const id = ids[i % 2], remoteText = `remote-${i}`, localText = `native-${i}`;
    let started = performance.now();
    await remoteEdit(id, remoteText);
    await wait(async () => (await native("status")).find((r) => r.id === id).note.contentText === remoteText, "remote update not pulled");
    download.push(Math.round(performance.now() - started));
    started = performance.now();
    await native("edit", id, localText);
    await wait(async () => (await serverNote(id))?.contentText === localText, "native update not pushed");
    await wait(async () => (await native("status")).find((r) => r.id === id).receipt.phase === "confirmed", "edit ACK not persisted");
    upload.push(Math.round(performance.now() - started));
  }
  // Remove the notification transport while leaving the same engine's poll active.
  await page.evaluate(async () => { const realtime = window.acceptanceRealtime; realtime.disconnect(); });
  await remoteEdit(ids[0], "lost-notice");
  await wait(async () => (await native("status"))[0].note.contentText === "lost-notice", "poll did not compensate for missing notification", 40_000);
  await native("stop");
  await remoteEdit(ids[0], "reconnected");
  await native("start");
  await wait(async () => (await native("status"))[0].note.contentText === "reconnected", "reconnect did not catch up");
  let structureStarted = performance.now();
  const folderResponse = await fetch(`${base}/acceptance/tree-folder`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({parentId:`note:${ids[0]}`})});
  assert.ok(folderResponse.ok, `remote folder create failed: ${folderResponse.status}`);
  const folder = await folderResponse.json();
  await wait(async () => (await native("structure",folder.id))?.parentId === `note:${ids[0]}`, "folder-under-document structure not pulled");
  const remoteFolderCreateMs = Math.round(performance.now()-structureStarted);
  structureStarted = performance.now();
  const moved = await fetch(`${base}/acceptance/tree-move/${encodeURIComponent(folder.id)}`, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({parentId:null,sortOrder:17})});
  assert.ok(moved.ok, `remote tree move failed: ${moved.status}`);
  await wait(async () => {const row=await native("structure",folder.id);return row?.parentId === null && row.sortOrder === 17;}, "remote tree move not pulled");
  const remoteTreeMoveMs = Math.round(performance.now()-structureStarted);
  await page.evaluate(() => window.acceptanceRealtime.disconnect());
  const movedWithoutNotice = await fetch(`${base}/acceptance/tree-move/${encodeURIComponent(folder.id)}`, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({parentId:`note:${ids[0]}`,sortOrder:19})});
  assert.ok(movedWithoutNotice.ok);
  await wait(async () => {const row=await native("structure",folder.id);return row?.parentId === `note:${ids[0]}` && row.sortOrder === 19;}, "poll did not compensate for a missing tree notification",40_000);
  await native("treeList");
  await native("stop");
  adb("reverse", "--remove", "tcp:47831");
  await native("treeMove",folder.id,`note:${ids[1]}`,29);
  assert.equal((await native("pendingTree")).length,1);
  const offlineTree = await native("treeList");
  assert.equal(offlineTree.nodes.find((node)=>node.id===folder.id)?.parentId,`note:${ids[1]}`);
  await browser.close();
  adb("shell", "am", "force-stop", "com.nowen.note.syncacceptance");
  adb("shell", "am", "start", "-n", "com.nowen.note.syncacceptance/com.nowen.note.MainActivity");
  await attach();
  const restoredStructure = await native("structure",folder.id);
  assert.equal(restoredStructure.parentId,`note:${ids[1]}`); assert.equal(restoredStructure.sortOrder,29);
  assert.equal((await native("pendingTree")).length,1);
  assert.equal((await native("schema"))[0].user_version,7);
  const serverTree = async () => (await fetch(`${base}/acceptance/tree/${encodeURIComponent(folder.id)}`)).json();
  adb("reverse","tcp:47831","tcp:47831");
  await native("start");
  await wait(async () => (await serverTree()).parentId===`note:${ids[1]}` && (await native("pendingTree")).length===0,"offline structure not automatically pushed");
  await native("treeList"); await native("stop");
  adb("reverse","--remove","tcp:47831");
  await native("treeMove",folder.id,`note:${ids[0]}`,30);
  const concurrent = await fetch(`${base}/acceptance/tree-move/${encodeURIComponent(folder.id)}`, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({parentId:null,sortOrder:31})});
  assert.ok(concurrent.ok);
  adb("reverse","tcp:47831","tcp:47831"); await native("start");
  await wait(async () => (await native("treeConflicts")).length===1,"concurrent move not retained in conflict center");
  const [conflict] = await native("treeConflicts");
  assert.equal(conflict.local.parentId,`note:${ids[0]}`); assert.equal(conflict.remote.parentId,null);
  await native("resolveTreeConflict",conflict.id);
  await wait(async () => (await serverTree()).parentId===`note:${ids[0]}` && (await native("pendingTree")).length===0,"keep-local structure did not converge");
  assert.equal((await native("treeConflicts")).length,0);
  await native("treeList"); await native("stop");
  adb("reverse","--remove","tcp:47831");
  const created=await native("createOfflineFolders");
  const creationMutations=await native("pendingMutations");
  assert.equal(creationMutations.filter((row)=>row.entityType==="knowledge_tree_node").length,3);
  const createdOfflineTree=await native("treeList");
  for(const item of created.folders) assert.equal(createdOfflineTree.nodes.find((node)=>node.id===item.id)?.parentId,item.parentId);
  assert.equal((await native("noteStatus",created.noteId)).note.contentText,"folder-offline-body");
  await browser.close();
  adb("shell","am","force-stop","com.nowen.note.syncacceptance");
  adb("shell","am","start","-n","com.nowen.note.syncacceptance/com.nowen.note.MainActivity");
  await attach();
  assert.deepEqual(await native("pendingMutations"),creationMutations);
  const restoredFolderTree=await native("treeList");
  for(const item of created.folders) {
    assert.equal((await native("structure",item.id)).parentId,item.parentId);
    assert.equal(restoredFolderTree.nodes.find((node)=>node.id===item.id)?.parentId,item.parentId);
  }
  assert.equal((await native("noteStatus",created.noteId)).note.contentText,"folder-offline-body");
  adb("reverse","tcp:47831","tcp:47831");
  const folderPushStarted=performance.now(); await native("start");
  await wait(async()=>{
    if((await native("pendingMutations")).length) return false;
    for(const item of created.folders) {
      const row=await (await fetch(`${base}/acceptance/tree/${encodeURIComponent(item.id)}`)).json();
      if(!row || row.parentId!==item.parentId) return false;
    }
    return (await serverNote(created.noteId))?.contentText==="folder-offline-body"
      && (await native("noteStatus",created.noteId)).receipt.phase==="confirmed";
  },"offline folder resources, nesting and note did not automatically converge");
  const nativeFolderCreationMs=Math.round(performance.now()-folderPushStarted);
  assert.equal((await native("treeConflicts")).length,0);
  const acknowledgedFolderTree=await native("treeList");
  for(const item of created.folders) assert.equal(acknowledgedFolderTree.nodes.filter((node)=>node.id===item.id).length,1);
  await native("treeList",true);await native("stop");adb("reverse","--remove","tcp:47831");
  await native("edit",created.noteId,"folder-trash-offline-body");
  await native("treeTrash",created.folders[0].id);
  assert.equal((await native("structure",created.folders[0].id)).isDeleted,1);
  assert.equal((await native("retainedNoteStatus",created.noteId)).note.isTrashed,1);
  assert.equal((await native("retainedNoteStatus",created.noteId)).receipt.phase,"pending");
  assert.ok(!(await native("treeList")).nodes.some((node)=>node.id===created.folders[0].id));
  assert.ok((await native("trashList")).items.some((item)=>item.id===created.folders[0].id));
  const trashMutations=await native("pendingMutations");
  await browser.close();adb("shell","am","force-stop","com.nowen.note.syncacceptance");
  adb("shell","am","start","-n","com.nowen.note.syncacceptance/com.nowen.note.MainActivity");await attach();
  assert.deepEqual(await native("pendingMutations"),trashMutations);
  assert.ok((await native("trashList")).items.some((item)=>item.id===created.folders[0].id));
  assert.equal((await native("retainedNoteStatus",created.noteId)).note.contentText,"folder-trash-offline-body");
  adb("reverse","tcp:47831","tcp:47831");await native("start");
  await wait(async()=>!(await native("pendingMutations")).length && (await serverNote(created.noteId))?.isTrashed===1,
    "offline folder trash did not automatically commit with the pending body");
  await native("trashList");await native("stop");adb("reverse","--remove","tcp:47831");
  const restored=await native("treeRestore",created.folders[1].id);
  assert.deepEqual(restored.failures,[],"selecting the child restores its deleted ancestor cohort");
  assert.equal((await native("structure",created.folders[0].id)).isDeleted,0);
  assert.equal((await native("noteStatus",created.noteId)).note.isTrashed,0);
  assert.equal((await native("noteStatus",created.noteId)).receipt.phase,"pending");
  const restoreMutations=await native("pendingMutations");
  await browser.close();adb("shell","am","force-stop","com.nowen.note.syncacceptance");
  adb("shell","am","start","-n","com.nowen.note.syncacceptance/com.nowen.note.MainActivity");await attach();
  assert.deepEqual(await native("pendingMutations"),restoreMutations);
  assert.ok((await native("treeList")).nodes.some((node)=>node.id===created.folders[0].id));
  adb("reverse","tcp:47831","tcp:47831");await native("start");
  await wait(async()=>!(await native("pendingMutations")).length && (await serverNote(created.noteId))?.isTrashed===0
    && (await native("noteStatus",created.noteId)).receipt.phase==="confirmed","offline folder restore did not automatically converge");
  assert.equal((await serverNote(created.noteId)).contentText,"folder-trash-offline-body");
  assert.equal((await native("treeConflicts")).length,0);
  const report = { device: serial, package: "com.nowen.note.syncacceptance", offlineImmediateRead: true, forceStopRecovery: true,
    nativeOfflineFolderTrash:true,offlineUnifiedTrashList:true,pendingChildBodyPreserved:true,trashMutationIdentitySurvivesRestart:true,
    automaticFolderTrashPush:true,nativeOfflineFolderRestore:true,restoreIncludesDeletedAncestors:true,restoreMutationIdentitySurvivesRestart:true,
    automaticFolderRestorePush:true,lifecycleReceiptInvalidation:true,
    sourceCommit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
    nativeOfflineFolderCreate:true,nestedOfflineFolderCreate:true,offlineFolderUnderDocument:true,noteInsideOfflineFolder:true,
    folderCreationMutationIdentitySurvivesRestart:true,folderCreationOfflineListRecovery:true,automaticFolderCreationPush:true,nativeFolderCreationMs,
    knowledgeTreeRootCreate: true, readWriteThroughProductionApiBridge: true,
    negotiatedPersonalTreePull:true,remoteFolderUnderDocument:true,remoteTreeMove:true,structureForceStopRecovery:true,nativeSchemaVersion:7,
    nativeOfflineTreeMoveAndSort:true,pendingTreeForceStopRecovery:true,automaticStructurePush:true,nativeConcurrentMoveKeepLocal:true,
    missingTreeNoticePoll:true,remoteFolderCreateMs,remoteTreeMoveMs,
    offlineNetworkIsolation: "adb reverse removed; HTTP server unreachable from Android",
    markdownAndRichText: true, missingNoticePoll: true, reconnect: true,
    httpPushToNativePull: stats(download), nativeCommitToServerAndAck: stats(upload), errors: await native("errors"),
    boundary: "Loopback adb reverse; actual Android Native SQLite, production API Bridge personal folder creation/nesting/document parents and note creation inside the new folder, tree move/sort, personal folder subtree trash/restore through the unified trash API with pending child body preservation, lifecycle receipt invalidation (retained trashed bodies are inspected via Native Repository; production API reads resume after restore), Outbox restart recovery, automatic Push and concurrent move keep-local via the Native conflict service. Full ConflictCenter GUI, EditorPane, protected/shared ACL, attachment bytes and full production JWT middleware are not accepted here." };
  fs.mkdirSync(new URL("../docs/test-results/", import.meta.url), { recursive: true });
  fs.writeFileSync(new URL("../docs/test-results/sync-v2-native-folder-trash-2026-10-11.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (page) await native("stop").catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (adb("reverse", "--list").includes("tcp:47831")) adb("reverse", "--remove", "tcp:47831");
}
process.exit(0);
