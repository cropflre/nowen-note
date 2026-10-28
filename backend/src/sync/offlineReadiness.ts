import fs from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { getAttachmentStorageInfo, getLocalAttachmentPath } from '../services/attachment-storage';
import { isKnowledgeTreeSyncReady } from './knowledgeTreeReadiness';
import { getProfile, getSyncState } from './profile';
import { getBootstrapProgress } from './bootstrap';

// Bounded disk checks across diagnostics polls; no library-sized file reads.
const scans = new WeakMap<Database.Database, Map<string, { fingerprint: string; checked: number; inFlight: number; available: number; missing: number; started: number }>>();

export async function readOfflineReadiness(db: Database.Database, profileId: string | null, userId: string) {
  const profile = profileId ? getProfile(db, profileId) : null;
  const bootstrap = profileId ? getBootstrapProgress(db, profileId) : null;
  const state = profileId ? getSyncState(db, profileId, 'personal') : null;
  const supported = getAttachmentStorageInfo().driver === 'local'
    && !!profileId && isKnowledgeTreeSyncReady(db, profileId);
  const rows = db.prepare(`SELECT a.id,a.path,a.size,s.remoteOnly,s.status,s.lastError FROM attachments a
    JOIN notes n ON n.id=a.noteId LEFT JOIN attachment_sync_state s ON s.attachmentId=a.id
    WHERE a.userId=? AND n.userId=? AND n.workspaceId IS NULL AND COALESCE(n.isTrashed,0)=0
      AND (s.profileId IS NULL OR s.profileId=?) ORDER BY a.id`).all(userId, userId, profileId) as Array<{
      id: string; path: string; size: number; remoteOnly: number | null; status: string | null; lastError: string | null;
    }>;
  const local = rows.filter(row => row.remoteOnly !== 1);
  const key = `${userId}\n${profileId}`;
  const fingerprint = JSON.stringify(rows);
  let cache = scans.get(db);
  if (!cache) { cache = new Map(); scans.set(db, cache); }
  let scan = cache.get(key);
  if (!scan || scan.fingerprint !== fingerprint || Date.now() - scan.started > 60_000) {
    scan = { fingerprint, checked: 0, inFlight: 0, available: 0, missing: 0, started: Date.now() };
    cache.set(key, scan);
  }
  if (getAttachmentStorageInfo().driver === 'local') {
    const batch = local.slice(scan.checked, scan.checked + 32);
    scan.checked += batch.length;
    scan.inFlight += batch.length;
    for (const row of batch) {
      let valid = false;
      try { const stat = await fs.stat(getLocalAttachmentPath(row.path)); valid = stat.isFile() && stat.size === row.size; } catch { /* retained as a missing local file */ }
      if (valid) scan.available++;
      else {
        scan.missing++;
        // Keep metadata and retry intent, including records created before Sync V2.
        db.prepare(`INSERT INTO attachment_sync_state (attachmentId,profileId,status,remoteOnly,lastError,updatedAt)
          VALUES (?,?,'failed',1,'LOCAL_FILE_MISSING',datetime('now')) ON CONFLICT(attachmentId) DO UPDATE SET
          remoteOnly=1,status='failed',lastError='LOCAL_FILE_MISSING',updatedAt=datetime('now')`).run(row.id, profileId);
      }
      scan.inFlight--;
    }
  }
  const pendingDownloads = rows.filter(row => row.remoteOnly === 1 && row.status !== 'failed').length;
  const failedDownloads = rows.filter(row => row.remoteOnly === 1 && row.status === 'failed').length;
  const verificationPending = scan.checked < local.length || scan.inFlight > 0;
  const contentState = !profile ? 'not_started' : bootstrap?.status === 'ready' ? 'ready'
    : bootstrap?.status === 'failed' ? 'error' : 'downloading';
  return {
    supported, scopeKey: 'personal', contentState,
    verifiedSequence: contentState === 'ready' ? state?.lastSequence ?? bootstrap?.sequence ?? null : null,
    verifiedAt: state?.lastSyncAt ?? null,
    attachments: { total: rows.length, available: scan.available, pendingDownloads, failedDownloads, missingFiles: scan.missing },
    verificationPending,
    fullyAvailable: supported && contentState === 'ready' && !verificationPending
      && pendingDownloads === 0 && failedDownloads === 0 && scan.missing === 0,
  };
}
