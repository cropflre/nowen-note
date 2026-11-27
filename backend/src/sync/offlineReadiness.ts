import fs from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { getAttachmentStorageInfo, getLocalAttachmentPath } from '../services/attachment-storage';
import { isKnowledgeTreeSyncReady } from './knowledgeTreeReadiness';
import { getProfile, getSyncState } from './profile';
import { getBootstrapProgress } from './bootstrap';

// Persistent per-attachment disk verification cache in SQLite;
// avoids resetting verified counts back to 0 across restarts/upgrades or when
// background sync updates individual attachments.
const DEFAULT_BATCH_SIZE = 32;
const STALE_BATCH_SIZE = 32;
const STAT_CONCURRENCY = 16;
const REVERIFY_TTL_MS = 5 * 60_000;

export interface OfflineReadinessOptions {
  batchSize?: number;
}

interface AttachmentReadinessRow {
  id: string;
  path: string;
  size: number;
  remoteOnly: number | null;
  status: string | null;
  lastError: string | null;
  verifiedPath: string | null;
  verifiedSize: number | null;
  verifiedValid: number | null;
  verifiedAt: number | null;
}

const ensuredTables = new WeakSet<Database.Database>();

function ensureVerificationTable(db: Database.Database): void {
  if (ensuredTables.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS offline_attachment_verifications (
      attachmentId TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      valid INTEGER NOT NULL,
      checkedAt INTEGER NOT NULL,
      FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE
    );
  `);
  ensuredTables.add(db);
}

function hasMatchingValidVerification(row: AttachmentReadinessRow): boolean {
  return row.verifiedValid === 1 && row.verifiedPath === row.path && row.verifiedSize === row.size;
}

async function verifyBatchOnDisk(batch: AttachmentReadinessRow[]): Promise<Array<{ row: AttachmentReadinessRow; valid: boolean; checkedAt: number }>> {
  const results = new Array<{ row: AttachmentReadinessRow; valid: boolean; checkedAt: number }>(batch.length);
  let cursor = 0;
  const workerCount = Math.min(STAT_CONCURRENCY, batch.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= batch.length) return;
      const row = batch[index];
      let valid = false;
      try {
        const stat = await fs.stat(getLocalAttachmentPath(row.path));
        valid = stat.isFile() && stat.size === row.size;
      } catch { /* retained as a missing local file */ }
      results[index] = { row, valid, checkedAt: Date.now() };
    }
  });
  await Promise.all(workers);
  return results;
}

export async function readOfflineReadiness(
  db: Database.Database,
  profileId: string | null,
  userId: string,
  options?: OfflineReadinessOptions,
) {
  ensureVerificationTable(db);
  const profile = profileId ? getProfile(db, profileId) : null;
  const bootstrap = profileId ? getBootstrapProgress(db, profileId) : null;
  const state = profileId ? getSyncState(db, profileId, 'personal') : null;
  const supported = getAttachmentStorageInfo().driver === 'local'
    && !!profileId && isKnowledgeTreeSyncReady(db, profileId);
  const rows = db.prepare(`SELECT a.id,a.path,a.size,s.remoteOnly,s.status,s.lastError,
      v.path AS verifiedPath,v.size AS verifiedSize,v.valid AS verifiedValid,v.checkedAt AS verifiedAt
    FROM attachments a
    JOIN notes n ON n.id=a.noteId
    LEFT JOIN attachment_sync_state s ON s.attachmentId=a.id
    LEFT JOIN offline_attachment_verifications v ON v.attachmentId=a.id
    WHERE a.userId=? AND n.userId=? AND n.workspaceId IS NULL AND COALESCE(n.isTrashed,0)=0
      AND (s.profileId IS NULL OR s.profileId=?) ORDER BY a.id`).all(userId, userId, profileId) as AttachmentReadinessRow[];
  const local = rows.filter(row => row.remoteOnly !== 1);
  const now = Date.now();
  const checkedThisCall = new Map<string, boolean>();

  if (getAttachmentStorageInfo().driver === 'local') {
    const unverified: AttachmentReadinessRow[] = [];
    const stale: AttachmentReadinessRow[] = [];
    for (const row of local) {
      if (!hasMatchingValidVerification(row)) {
        unverified.push(row);
      } else if (now - (row.verifiedAt ?? 0) > REVERIFY_TTL_MS) {
        stale.push(row);
      }
    }
    const unverifiedBatchSize = Math.max(1, Math.floor(options?.batchSize ?? DEFAULT_BATCH_SIZE));
    const batch = unverified.length > 0
      ? unverified.slice(0, unverifiedBatchSize)
      : stale.slice(0, STALE_BATCH_SIZE);
    if (batch.length > 0) {
      const results = await verifyBatchOnDisk(batch);
      const upsertVerification = db.prepare(`INSERT INTO offline_attachment_verifications
        (attachmentId,path,size,valid,checkedAt) VALUES (?,?,?,?,?)
        ON CONFLICT(attachmentId) DO UPDATE SET
          path=excluded.path,size=excluded.size,valid=excluded.valid,checkedAt=excluded.checkedAt`);
      const markMissing = db.prepare(`INSERT INTO attachment_sync_state (attachmentId,profileId,status,remoteOnly,lastError,updatedAt)
        VALUES (?,?,'failed',1,'LOCAL_FILE_MISSING',datetime('now')) ON CONFLICT(attachmentId) DO UPDATE SET
        remoteOnly=1,status='failed',lastError='LOCAL_FILE_MISSING',updatedAt=datetime('now')`);
      db.transaction(() => {
        for (const { row, valid, checkedAt } of results) {
          upsertVerification.run(row.id, row.path, row.size, valid ? 1 : 0, checkedAt);
          if (!valid) {
            // Keep metadata and retry intent, including records created before Sync V2.
            markMissing.run(row.id, profileId);
          }
          checkedThisCall.set(row.id, valid);
        }
      })();
    }
  }

  let available = 0;
  let missing = 0;
  let unchecked = 0;
  for (const row of local) {
    const fresh = checkedThisCall.get(row.id);
    if (fresh !== undefined) {
      if (fresh) available += 1;
      else missing += 1;
    } else if (hasMatchingValidVerification(row)) {
      available += 1;
    } else {
      unchecked += 1;
    }
  }

  const pendingDownloads = rows.filter(row => row.remoteOnly === 1 && row.status !== 'failed').length;
  const failedDownloads = rows.filter(row => row.remoteOnly === 1 && row.status === 'failed').length;
  const verificationPending = getAttachmentStorageInfo().driver === 'local' && unchecked > 0;
  const contentState = !profile ? 'not_started' : bootstrap?.status === 'ready' ? 'ready'
    : bootstrap?.status === 'failed' ? 'error' : 'downloading';
  return {
    supported, scopeKey: 'personal', contentState,
    verifiedSequence: contentState === 'ready' ? state?.lastSequence ?? bootstrap?.sequence ?? null : null,
    verifiedAt: state?.lastSyncAt ?? null,
    attachments: { total: rows.length, available, pendingDownloads, failedDownloads, missingFiles: missing },
    verificationPending,
    fullyAvailable: supported && contentState === 'ready' && !verificationPending
      && pendingDownloads === 0 && failedDownloads === 0 && missing === 0,
  };
}
