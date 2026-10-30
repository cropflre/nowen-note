import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = 'http://127.0.0.1:3001';
for (let i = 0; i < 150; i++) {
  try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* startup */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'docker_qa152', password: 'isolated-fixture-password' }) });
assert.equal(login.status, 200); const token = (await login.json()).token;
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const book = await fetch(base + '/api/notebooks', { method: 'POST', headers, body: JSON.stringify({ name: 'Sync safety audit' }) });
assert.equal(book.status, 201);
const created = await fetch(base + '/api/notes', { method: 'POST', headers, body: JSON.stringify({
  notebookId: (await book.json()).id, title: 'Sync safety audit', contentFormat: 'markdown', content: '# retain me' }) });
assert.equal(created.status, 201); const id = (await created.json()).id;
const before = await (await fetch(base + '/api/notes/' + id, { headers })).json();
assert.equal(before.isTrashed, 0);
const response = await fetch(base + '/api/sync/v2/push', { method: 'POST', headers, body: JSON.stringify({
  scopeKey: 'personal', deviceId: 'qa-contract-audit', mutations: [{ mutationId: randomUUID(), entityType: 'note',
    entityId: id, operation: 'delete', baseVersion: before.version }] }) });
const result = await response.json();
const after = await fetch(base + '/api/notes/' + id, { headers });
const restore = await fetch(base + '/api/trash/batch?workspaceId=personal', { method: 'POST', headers,
  body: JSON.stringify({ action: 'restore', ids: ['note:' + id] }) });
const restoreResult = await restore.json();
console.log(JSON.stringify({ authenticatedOwnerOnly: true, activeBefore: true, syncHttpStatus: response.status,
  mutationResults: result.results, readAfterStatus: after.status,
  restoreHttpStatus: restore.status, restoreFailures: restoreResult.failures,
  boundary: 'Audit of separate Sync V2 delete protocol, not a passing release safety test. No shared editor/anonymous exploit claimed.' }, null, 2));
