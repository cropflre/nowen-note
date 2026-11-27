import fs from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { getAttachmentStorageInfo, getLocalAttachmentPath } from '../services/attachment-storage';
import { isKnowledgeTreeSyncReady } from './knowledgeTreeReadiness';
import { getProfile, getSyncState } from './profile';
import { getBootstrapProgress } from './bootstrap';

// Bounded per-attachment disk verification cache across diagnostics polls;
// avoids resetting verified counts back to 0 when large libraries take >60s or when
// background sync updates individual attachments.
const BATCH_SIZE = 32;
const REVERIFY_TTL_MS = 5 * 60_000;

interface VerifiedEntry {
  sig: string;
  valid: boolean;
  checkedAt: number;
}

const scans = new WeakMap<Database.Database, Map<string, Map<string, VerifiedEntry>>>();

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
  let cache = scans.get(db);
  if (!cache) { cache = new Map(); scans.set(db, cache); }
  let verified = cache.get(key);
  if (!verified) {
    verified = new Map();
    cache.set(key, verified);
  }

  const localIds = new Set(local.map(row => row.id));
  for (const id of verified.keys()) {
    if (!localIds.has(id)) verified.delete(id);
  }

  const now = Date.now();
  const sigOf = (row: { path: string; size: number }) => `${row.path}\0${row.size}`;

  if (getAttachmentStorageInfo().driver === 'local') {
    const unverified: typeof local = [];
    const stale: typeof local = [];
    for (const row of local) {
      const entry = verified.get(row.id);
      const sig = sigOf(row);
      if (!entry || entry.sig !== sig) {
        unverified.push(row);
      } else if (now - entry.checkedAt > REVERIFY_TTL_MS) {
        stale.push(row);
      }
    }
    const batch = (unverified.length > 0 ? unverified : stale).slice(0, BATCH_SIZE);
    for (const row of batch) {
      const sig = sigOf(row);
      let valid = false;
      try {
        const stat = await fs.stat(getLocalAttachmentPath(row.path));
        valid = stat.isFile() && stat.size === row.size;
      } catch { /* retained as a missing local file */ }
      verified.set(row.id, { sig, valid, checkedAt: Date.now() });
      if (!valid) {
        // Keep metadata and retry intent, including records created before Sync V2.
        db.prepare(`INSERT INTO attachment_sync_state (attachmentId,profileId,status,remoteOnly,lastError,updatedAt)
          VALUES (?,?,'failed',1,'LOCAL_FILE_MISSING',datetime('now')) ON CONFLICT(attachmentId) DO UPDATE SET
          remoteOnly=1,status='failed',lastError='LOCAL_FILE_MISSING',updatedAt=datetime('now')`).run(row.id, profileId);
      }
    }
  }

  let available = 0;
  let missing = 0;
  let unchecked = 0;
  for (const row of local) {
    const entry = verified.get(row.id);
    if (!entry || entry.sig !== sigOf(row)) {
      unchecked += 1;
    } else if (entry.valid) {
      available += 1;
    } else {
      missing += 1;
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
