import type { NativeDatabase } from './nativeDatabase';
import type { NativeAttachmentStore } from './nativeAttachmentStore';
import type { OfflineReadiness } from './syncLocalApi';
import { nativeTreeSubscriptionKey, NATIVE_TREE_ENTITY_SET } from './nativeKnowledgeTreeSync';

export const offlineBaselineKey = (profileId: string, scopeKey = 'personal') => `offlineBaseline:${profileId}:${scopeKey}`;
const scans = new WeakMap<NativeDatabase, { fingerprint: string; checked: number; inFlight: number; available: number; missing: number; started: number }>();

export async function readMobileOfflineReadiness(db: NativeDatabase, store: NativeAttachmentStore, profileId: string, userId: string): Promise<OfflineReadiness> {
  const meta = await db.query<{key: string; value: string}>('SELECT key,value FROM native_runtime_meta WHERE key IN (?,?)', [offlineBaselineKey(profileId), nativeTreeSubscriptionKey(profileId)]);
  const baseline = meta.find(row => row.key === offlineBaselineKey(profileId));
  const supported = meta.some(row => row.key === nativeTreeSubscriptionKey(profileId) && row.value === NATIVE_TREE_ENTITY_SET);
  const state = (await db.query<{lastSequence: number; lastSyncAt: string | null}>("SELECT lastSequence,lastSyncAt FROM sync_state WHERE profileId=? AND scopeKey='personal'", [profileId]))[0];
  const rows = await db.query<{id: string; size: number; hash: string | null; available: number; transferStatus: string; localPath: string | null}>(`SELECT a.id,a.size,a.hash,a.available,a.transferStatus,a.localPath FROM attachments a JOIN notes n ON n.scopeKey=a.scopeKey AND n.id=a.noteId
    WHERE a.scopeKey='personal' AND a.userId=? AND n.isTrashed=0 ORDER BY a.id`, [userId]);
  const fingerprint = `${profileId}\n${JSON.stringify(rows)}`;
  let scan = scans.get(db);
  if (!scan || scan.fingerprint !== fingerprint || Date.now() - scan.started > 60_000) {
    scan = { fingerprint, checked: 0, inFlight: 0, available: 0, missing: 0, started: Date.now() }; scans.set(db, scan);
  }
  const local = rows.filter(row => row.available === 1);
  const batch = local.slice(scan.checked, scan.checked + 16);
  scan.checked += batch.length;
  scan.inFlight += batch.length;
  for (const row of batch) {
    let file = null;
    try { file = await store.stat(row.id); } catch { /* file I/O failures are unavailable, never successful verification */ }
    if (file && file.size === row.size && (!row.hash || file.sha256 === row.hash.replace(/^sha256:/, ''))) scan.available++;
    else {
      scan.missing++;
      await db.run("UPDATE attachments SET available=0,transferStatus='pending_download',transferError='LOCAL_FILE_MISSING' WHERE scopeKey='personal' AND id=?", [row.id]);
    }
    scan.inFlight--;
  }
  const failedDownloads = rows.filter(row => !row.available && row.transferStatus === 'failed').length;
  const pendingDownloads = rows.filter(row => !row.available && row.transferStatus !== 'failed').length;
  const verificationPending = scan.checked < local.length || scan.inFlight > 0;
  return {
    supported, scopeKey: 'personal', contentState: baseline ? 'ready' : 'downloading',
    verifiedSequence: baseline ? state?.lastSequence ?? Number(baseline.value) : null,
    verifiedAt: state?.lastSyncAt ?? null,
    attachments: { total: rows.length, available: scan.available, pendingDownloads, failedDownloads, missingFiles: scan.missing },
    verificationPending,
    fullyAvailable: supported && !!baseline && !verificationPending && pendingDownloads === 0 && failedDownloads === 0 && scan.missing === 0,
  };
}
