import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run with launch-electron.mjs and the repository tsx loader (SQLite ABI 130).
const [checkoutArg, evidenceArg, mode = 'source', archive] = process.argv.slice(2);
const checkout = path.resolve(checkoutArg), evidence = path.resolve(evidenceArg);
fs.mkdirSync(evidence, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nowen-152-http-' + mode + '-'));
Object.assign(process.env, { DB_PATH: path.join(directory, 'fixture.db'), ELECTRON_USER_DATA: directory,
  NODE_ENV: 'test', ATTACHMENT_STORAGE: 'local', NOWEN_LOCAL_FIRST_SYNC_V2: '0' });
const require = createRequire(path.join(checkout, 'backend/package.json'));
const schema = await import(pathToFileURL(path.join(checkout, 'backend/src/db/schema.ts')));
const attachments = await import(pathToFileURL(path.join(checkout, 'backend/src/routes/attachments.ts')));
const db = schema.getDb();
const password = randomBytes(24).toString('hex'), secret = randomBytes(32).toString('hex');
for (const id of ['qa-owner', 'qa-other']) db.prepare('INSERT INTO users (id,username,passwordHash) VALUES (?,?,?)')
  .run(id, id, require('bcryptjs').hashSync(password, 4));
// These fixture accounts represent existing users; keep a clean import target
// instead of triggering first-login tutorial notes.
db.prepare("INSERT INTO user_onboarding_state (userId,version,status) VALUES ('qa-owner',1,'existing'),('qa-other',1,'existing')").run();
const attachmentBytes = Buffer.from('QA binary fixture\x00\xff\x01', 'latin1');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let physical;
if (mode !== 'target') {
  db.prepare("INSERT INTO notebooks (id,userId,name) VALUES ('qa-book','qa-owner','QA Book')").run();
  db.prepare("INSERT INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,bootstrapStatus) VALUES ('qa-profile','QA','http://127.0.0.1:1','qa-owner',1,'ready')").run();
  db.prepare("INSERT OR IGNORE INTO sync_device_identity (singletonKey,deviceId) VALUES (1,'qa-device')").run();
  db.prepare(`INSERT INTO notes (id,userId,notebookId,title,content,contentText,contentFormat,version)
    VALUES ('qa-live','qa-owner','qa-book','QA Roundtrip','# QA body\n[fixture](/api/attachments/qa-file)','QA body','markdown',4)`).run();
  db.prepare("INSERT INTO note_versions (id,noteId,userId,content,version) VALUES ('qa-history','qa-live','qa-owner','QA old body',3)").run();
  physical = path.join(attachments.getAttachmentsDir(), 'qa/binary.dat');
  fs.mkdirSync(path.dirname(physical), { recursive: true }); fs.writeFileSync(physical, attachmentBytes);
  db.prepare("INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path) VALUES ('qa-file','qa-live','qa-owner','binary.dat','application/octet-stream',?,'qa/binary.dat')").run(attachmentBytes.length);
  db.prepare(`INSERT INTO notes (id,userId,notebookId,title,isLocked,isTrashed)
    VALUES ('qa-locked','qa-owner','qa-book','locked',1,1)`).run();
}
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const base = 'http://127.0.0.1:' + port;
let child, log = '', owner, other;
const report = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
  mode, node: process.version, abi: process.versions.modules, directory, base, checks: [] };
async function stop() {
  if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
}
async function start() {
  const packageRoot = process.env.QA_PACKAGED_ROOT;
  const backendRoot = packageRoot ? path.join(packageRoot, 'resources/backend') : path.join(checkout, 'backend');
  const diagnostics = process.env.QA_SQL_TRACE === '1' ? ['--require', path.join(checkout, 'docs/qa/v1.5.2/stage3/scripts/trace-fixture-sql.cjs')] : [];
  child = spawn(packageRoot ? path.join(packageRoot, 'Nowen Note QA152.exe') : process.execPath, [...diagnostics, path.join(backendRoot, 'dist/index.js')], {
    cwd: backendRoot, env: { ...process.env, NODE_ENV: mode === 'ui' ? 'production' : process.env.NODE_ENV, ELECTRON_RUN_AS_NODE: '1', JWT_SECRET: secret, PORT: String(port),
      FRONTEND_DIST: packageRoot ? path.join(packageRoot, 'resources/frontend/dist') : path.join(checkout, 'frontend/dist'), QA_SQLITE_MODULE: path.join(backendRoot, 'node_modules/better-sqlite3') }, windowsHide: true });
  child.stdout.on('data', (chunk) => { log += chunk; }); child.stderr.on('data', (chunk) => { log += chunk; });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* startup */ }
    assert.equal(child.exitCode, null, 'server exited before health was ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server readiness timeout');
}
async function request(method, url, token = owner, body, extra = {}) {
  const response = await fetch(base + url, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); return { status: response.status, body: data };
}
function snapshot() {
  const count = (table, column) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}='qa-live'`).get().n;
  return { body: db.prepare("SELECT content,isTrashed,version FROM notes WHERE id='qa-live'").get(),
    histories: count('note_versions', 'noteId'), attachments: count('attachments', 'noteId'), tree: count('knowledge_tree_nodes', 'resourceId'),
    fileHash: fs.existsSync(physical) ? sha256(fs.readFileSync(physical)) : null,
    outbox: db.prepare("SELECT mutationId,operation,payload FROM sync_outbox WHERE entityId='qa-live' ORDER BY rowid").all() };
}
try {
  await start();
  for (const id of ['qa-owner', 'qa-other']) {
    const login = await request('POST', '/api/auth/login', null, { username: id, password }); assert.equal(login.status, 200);
    if (id === 'qa-owner') owner = login.body.token; else other = login.body.token;
  }
  if (mode === 'ui') {
    const { runBrowserAcceptance } = await import('./browser-release-acceptance.mjs');
    report.checks.push(...await runBrowserAcceptance({ checkout, evidence, base, password }));
  } else if (mode === 'source') {
    const before = snapshot();
    for (const suffix of ['', '/permanent']) {
      assert.equal((await request('DELETE', '/api/notes/qa-live' + suffix, null, undefined, { 'X-User-Id': 'qa-owner' })).status, 401);
      assert.equal((await request('DELETE', '/api/notes/qa-live' + suffix, other)).status, 403);
      const refused = await request('DELETE', '/api/notes/qa-live' + suffix);
      assert.equal(refused.status, 409); assert.equal(refused.body.code, 'NOTE_NOT_TRASHED');
      assert.deepEqual(snapshot(), before);
    }
    assert.equal((await request('DELETE', '/api/notes/qa-locked/permanent')).status, 403);
    await stop(); await start(); assert.deepEqual(snapshot(), before);
    report.checks.push('JWT spoof/cross-user/locked denied; both active delete routes preserve body, history, tree, file and Outbox across restart');
    for (const isTrashed of [1, 0]) assert.equal((await request('PUT', '/api/notes/qa-live', owner, { isTrashed })).status, 200);
    assert.equal((await request('GET', '/api/notes/qa-live')).body.content, before.body.content);
    report.checks.push('trash and restore return the original body');
    const created = await request('POST', '/api/export/markdown-package/jobs', owner, {
      notes: [{ id: 'qa-live', title: 'QA Roundtrip', notebookName: 'QA', contentFormat: 'markdown', markdown: '# QA body', createdAt: '2026-10-12', updatedAt: '2026-10-12' }] });
    assert.equal(created.status, 202);
    let status;
    for (let i = 0; i < 100; i++) {
      status = await request('GET', '/api/export/markdown-package/jobs/' + created.body.job.id);
      if (['ready', 'failed'].includes(status.body.job?.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.body.job.state, 'ready');
    const download = await fetch(base + '/api/export/download/' + status.body.job.downloadToken);
    assert.equal(download.status, 200); const bytes = Buffer.from(await download.arrayBuffer());
    const zip = await require('jszip').loadAsync(bytes);
    const markdown = Object.keys(zip.files).find((name) => name.endsWith('.md'));
    assert.ok((await zip.file(markdown).async('string')).includes('# QA body'));
    report.markdownJob = { bytes: bytes.length, sha256: sha256(bytes), state: 'ready', downloadedAndParsed: true };
    const exported = await fetch(base + '/api/export/nowen-package?workspaceId=personal&notebookId=qa-book', { headers: { Authorization: 'Bearer ' + owner } });
    assert.equal(exported.status, 200); const packageBytes = Buffer.from(await exported.arrayBuffer());
    const packageZip = await require('jszip').loadAsync(packageBytes);
    const assets = JSON.parse(await packageZip.file('attachments.json').async('string')).items;
    assert.equal(assets.length, 1); assert.equal(sha256(await packageZip.file(assets[0].packagePath).async('nodebuffer')), sha256(attachmentBytes));
    const zipPath = path.join(evidence, 'roundtrip.nowen.zip'); fs.writeFileSync(zipPath, packageBytes);
    report.backup = { bytes: packageBytes.length, sha256: sha256(packageBytes), attachmentSha256: sha256(attachmentBytes) };
    assert.equal((await request('PUT', '/api/notes/qa-live', owner, { isTrashed: 1 })).status, 200);
    const deleted = await request('DELETE', '/api/notes/qa-live/permanent'); assert.equal(deleted.status, 200); assert.equal(deleted.body.success, true);
    await stop(); await start(); assert.equal(snapshot().body, undefined); assert.equal(snapshot().histories, 0);
    assert.equal(snapshot().attachments, 0); assert.equal(snapshot().tree, 0); assert.equal(snapshot().fileHash, null);
    report.checks.push('explicit permanent delete only succeeds after trash; removed data remains absent after restart');
    const worker = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), checkout, evidence, 'target', zipPath], { windowsHide: true, stdio: 'inherit' });
    assert.equal(await new Promise((resolve) => worker.once('close', resolve)), 0, 'clean target roundtrip failed');
    report.checks.push('downloaded backup reimported into separate fresh DB and attachment directory; restarted API body readback and physical byte hashes verified');
  } else {
    assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 0);
    const form = new FormData(); form.append('file', new Blob([fs.readFileSync(archive)], { type: 'application/zip' }), 'roundtrip.nowen.zip');
    const imported = await fetch(base + '/api/export/import/nowen-package?workspaceId=personal&importMode=new-root', { method: 'POST', headers: { Authorization: 'Bearer ' + owner }, body: form });
    const result = await imported.json(); assert.equal(imported.status, 200); assert.equal(result.success, true);
    const note = db.prepare("SELECT id,content,contentText FROM notes WHERE title='QA Roundtrip'").get(); assert.ok(note); assert.ok(note.contentText.startsWith('QA body'));
    const asset = db.prepare('SELECT id,path FROM attachments WHERE noteId=?').get(note.id); assert.ok(asset);
    assert.equal(sha256(fs.readFileSync(path.join(attachments.getAttachmentsDir(), asset.path))), sha256(attachmentBytes));
    await stop(); await start(); const readback = await request('GET', '/api/notes/' + note.id);
    assert.equal(readback.status, 200);
    // Public Markdown reads strip internal block IDs added by the importer.
    assert.equal(readback.body.content, '# QA body\n[fixture](/api/attachments/' + asset.id + ')');
    assert.ok(readback.body.contentText.startsWith('QA body'));
    assert.ok(readback.body.content.includes(asset.id));
    report.import = { success: true, counts: result.counts, separateDbInitiallyEmpty: true, restartedBodyVerified: true, attachmentSha256: sha256(attachmentBytes) };
  }
  report.result = 'PASS';
} catch (error) { report.result = 'FAIL'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  await stop(); schema.closeDb();
  fs.writeFileSync(path.join(evidence, 'http-' + mode + '.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(evidence, 'http-' + mode + '-server.log'), log);
}
console.log(JSON.stringify({ mode, result: report.result, checks: report.checks, evidence }));
