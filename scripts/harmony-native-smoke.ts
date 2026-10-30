// Built only by test-harmony-emulator.mjs, never included in the shipping app.
import { openNativeDatabase } from '../frontend/src/lib/nativeDatabase';
import { NativeLocalRepository } from '../frontend/src/lib/nativeLocalRepository';
import { createNativeAttachmentStore } from '../frontend/src/lib/nativeAttachmentStore';
import { SecureStorage } from '../frontend/src/lib/harmonySecureStorage';

declare const __HARMONY_TEST_ACCOUNT__: string;
const account = __HARMONY_TEST_ACCOUNT__;
const noteId = 'harmony-regression-note';
const attachmentId = 'harmony-regression-attachment';
const content = '# 鸿蒙离线验证\n中文正文，重启后应完整保留。';
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function run() {
  const db = await openNativeDatabase(account);
  const attachments = await createNativeAttachmentStore(account);
  const repo = new NativeLocalRepository({ db, attachments, accountId: account,
    userId: 'harmony-test-user', getScopeKey: () => 'personal' });
  await SecureStorage.setKeyPrefix(account + ':');
  const before = await repo.notes.get(noteId);
  if (!before) {
    const now = new Date().toISOString();
    await db.run(`INSERT OR IGNORE INTO sync_profiles
      (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt) VALUES (?,?,?,?,0,?,?)`,
    ['harmony-test-profile', 'Isolated test', 'https://invalid.example', 'harmony-test-user', now, now]);
    await db.run(`INSERT OR IGNORE INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES (?,?,?,?)`,
      ['harmony-test-profile', 'harmony-test-device', 'harmony', now]);
    await repo.createPersonalTreeNote({ id: noteId, title: '鸿蒙验证', content, contentText: content,
      contentFormat: 'markdown' }, null);
    const bytes = new Uint8Array(500000).map((_, i) => i % 251);
    await attachments.save({ attachmentId, data: bytes, expectedSize: bytes.length });
    await SecureStorage.set('harmony-regression', { token: 'test-only-value' });
    console.log('HARMONY_SMOKE_RESTART_READY');
    return;
  }
  check(before.content === content, 'Note did not survive restart');
  const queued = await db.query('SELECT mutationId,payload FROM sync_outbox ORDER BY id');
  check(queued.length >= 2, 'Missing durable Outbox');
  await db.run(`CREATE TRIGGER IF NOT EXISTS harmony_test_failure BEFORE INSERT ON sync_outbox
    BEGIN SELECT RAISE(ABORT,'harmony-test-failure'); END`);
  let rejected = false;
  try { await repo.notes.update(noteId, { content: 'must roll back', contentText: 'must roll back' }); }
  catch { rejected = true; }
  finally { await db.run('DROP TRIGGER IF EXISTS harmony_test_failure'); }
  check(rejected, 'Outbox failure did not reject save');
  check((await repo.notes.get(noteId))?.content === content, 'Business write did not roll back');
  check(JSON.stringify(await db.query('SELECT mutationId,payload FROM sync_outbox ORDER BY id')) === JSON.stringify(queued),
    'Outbox changed after rejected transaction');
  const bytes = new Uint8Array(await (await attachments.read(attachmentId)).arrayBuffer());
  check(bytes.length === 500000 && bytes.every((value, i) => value === i % 251), 'Attachment bytes changed');
  const url = await attachments.resolveUrl(attachmentId);
  check(url, 'Missing local attachment URL');
  const rendered = new Uint8Array(await (await fetch(url)).arrayBuffer());
  check(rendered.length === bytes.length && rendered.every((value, i) => value === bytes[i]), 'Attachment URL failed');
  check((await SecureStorage.get('harmony-regression') as { token: string })?.token === 'test-only-value',
    'System secure storage did not survive restart');
  await SecureStorage.remove('harmony-regression');
  check(await SecureStorage.get('harmony-regression') === null, 'Secure storage removal failed');
  const other = await openNativeDatabase(account + '-other');
  check((await other.query('SELECT id FROM notes')).length === 0, 'Account database leaked');
  check(!await (await createNativeAttachmentStore(account + '-other')).exists(attachmentId), 'Account attachment leaked');
  await other.close();
  // Reset only this isolated fixture, never the user's account or pending writes.
  await db.run('DELETE FROM notes WHERE id=?', [noteId]);
  await db.run('DELETE FROM sync_profiles WHERE id=?', ['harmony-test-profile']);
  await db.run('DELETE FROM native_runtime_meta WHERE key=?', [`localTreeDraft:personal:${noteId}`]);
  await attachments.remove(attachmentId);
  await db.close();
  console.log('HARMONY_SMOKE_PASS persistence rollback outbox attachments secure-storage account-isolation');
}
run().catch(error => console.error('HARMONY_SMOKE_FAIL', error.message));
