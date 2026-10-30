import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/app/backend/package.json');
const base = 'http://127.0.0.1:3001', phase = process.argv[2] || 'create';
const report = { phase, node: process.version, checks: [] };
let token;
async function request(method, url, body, authenticated = true) {
  const response = await fetch(base + url, { method, headers: { ...(authenticated && token ? { Authorization: 'Bearer ' + token } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
try {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
  const credentials = { username: 'docker_qa152', password: 'isolated-fixture-password' };
  if (phase === 'create') assert.equal((await request('POST', '/api/auth/register', credentials, false)).status, 201);
  const login = await request('POST', '/api/auth/login', credentials, false); assert.equal(login.status, 200); token = login.body.token;
  if (phase === 'create') {
    const book = await request('POST', '/api/notebooks', { name: 'Docker QA' }); assert.equal(book.status, 201);
    const note = await request('POST', '/api/notes', { notebookId: book.body.id, title: 'Docker QA body', contentFormat: 'markdown', content: '# Docker QA', contentText: 'Docker QA' });
    assert.equal(note.status, 201);
    assert.equal((await request('DELETE', '/api/notes/' + note.body.id, undefined, false)).status, 401);
    for (const suffix of ['', '/permanent']) {
      const refused = await request('DELETE', '/api/notes/' + note.body.id + suffix);
      assert.equal(refused.status, 409); assert.equal(refused.body.code, 'NOTE_NOT_TRASHED');
      assert.equal((await request('GET', '/api/notes/' + note.body.id)).body.content, '# Docker QA');
    }
    fs.writeFileSync('/app/data/qa-retained-note-id', note.body.id);
    report.checks.push('production API create; JWT refusal; both active delete routes preserve the body');
    const project = await request('POST', '/api/plugins/studio/projects', { name: 'Docker boundary QA' });
    assert.equal(project.status, 201);
    const root = '/app/data/plugin-projects/' + project.body.project.id;
    const outside = '/app/data/qa-outside.json';
    fs.writeFileSync(outside, '{"fixture":"must not escape"}');
    const url = '/api/plugins/studio/projects/' + project.body.project.id;
    for (const kind of ['hardlink', 'symlink']) {
      const file = root + '/escape.json';
      if (kind === 'hardlink') fs.linkSync(outside, file); else fs.symlinkSync(outside, file);
      const expected = kind === 'hardlink' ? 'PLUGIN_STUDIO_HARDLINK_REJECTED' : 'PLUGIN_STUDIO_SYMLINK_REJECTED';
      for (const endpoint of ['/files/content?path=escape.json', '/export']) {
        const denied = await request('GET', url + endpoint);
        assert.equal(denied.status, 400); assert.equal(denied.body.code, expected);
        assert.equal(JSON.stringify(denied.body).includes('must not escape'), false);
      }
      fs.unlinkSync(file);
    }
    report.checks.push('actual Linux hardened Studio HTTP read/export reject hardlink and symlink without returning outside fixture bytes');
  } else {
    const id = fs.readFileSync('/app/data/qa-retained-note-id', 'utf8');
    assert.equal((await request('GET', '/api/notes/' + id)).body.content, '# Docker QA');
    assert.equal((await request('PUT', '/api/notes/' + id, { isTrashed: 1 })).status, 200);
    assert.equal((await request('PUT', '/api/notes/' + id, { isTrashed: 0 })).status, 200);
    assert.equal((await request('GET', '/api/notes/' + id)).body.content, '# Docker QA');
    report.checks.push('container restart retained body; production soft-delete and restore readback');
  }
  const Database = require('better-sqlite3'), db = new Database(':memory:');
  db.loadExtension(require('sqlite-vec').getLoadablePath()); assert.ok(db.prepare('SELECT vec_version() AS version').get().version); db.close();
  assert.equal(execFileSync('/usr/bin/ffmpeg', ['-version'], { encoding: 'utf8' }).includes('ffmpeg version'), true);
  execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-t', '0.2', '-c:v', 'libx264', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1']);
  report.checks.push('runtime sqlite-vec load and FFmpeg H.264 media generation'); report.result = 'PASS';
} catch (error) { report.result = 'FAIL'; report.error = error.message; process.exitCode = 1; }
console.log(JSON.stringify(report, null, 2));
