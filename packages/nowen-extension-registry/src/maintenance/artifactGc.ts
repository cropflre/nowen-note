import type { DatabaseSync } from "node:sqlite";
import type { ArtifactStore, ArtifactStoreEntry } from "../storage/artifactStore.js";
import { assertArtifactKey, assertStagedKey } from "../storage/artifactStore.js";
import { RegistryOperationLeaseManager } from "./operationLease.js";

interface ArtifactObjectRow {
  sha256: string;
  storageKey: string;
  sizeBytes: number;
  state: string;
  createdAt: string;
}

export interface ArtifactGcCandidate {
  key: string;
  kind: "staging" | "committed" | "metadata";
  reason: "stale_staging" | "unreferenced_object" | "orphan_storage_object" | "orphan_metadata";
  sizeBytes: number;
  ageSource: string | null;
}

export interface ArtifactGcResult {
  dryRun: boolean;
  cutoff: string;
  scanned: { staging: number; committed: number; metadataRows: number };
  candidates: ArtifactGcCandidate[];
  deleted: ArtifactGcCandidate[];
  skippedInvalidKeys: string[];
  truncated: boolean;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function oldEnough(entry: ArtifactStoreEntry, fallback: string | undefined, cutoffMs: number): { eligible: boolean; ageSource: string | null } {
  const source = entry.lastModifiedAt || fallback;
  const timestamp = parseTimestamp(source);
  return { eligible: timestamp !== null && timestamp <= cutoffMs, ageSource: source || null };
}

export async function collectArtifactGarbage(options: {
  db: DatabaseSync;
  artifactStore: ArtifactStore;
  graceMs: number;
  apply?: boolean;
  maxDeletes?: number;
}): Promise<ArtifactGcResult> {
  const { db, artifactStore } = options;
  if (!Number.isSafeInteger(options.graceMs) || options.graceMs < 0) throw new Error("artifact GC graceMs is invalid");
  const maxDeletes = options.maxDeletes ?? 1_000;
  if (!Number.isSafeInteger(maxDeletes) || maxDeletes <= 0 || maxDeletes > 100_000) throw new Error("artifact GC maxDeletes is invalid");
  const dryRun = !options.apply;
  const cutoffMs = Date.now() - options.graceMs;
  const cutoff = new Date(cutoffMs).toISOString();
  const leases = new RegistryOperationLeaseManager(db);
  let gcLease = options.apply ? leases.acquireArtifactGc() : undefined;
  const result: ArtifactGcResult = {
    dryRun,
    cutoff,
    scanned: { staging: 0, committed: 0, metadataRows: 0 },
    candidates: [],
    deleted: [],
    skippedInvalidKeys: [],
    truncated: false,
  };

  try {
    const referenced = new Set((db.prepare("SELECT DISTINCT artifactKey FROM extension_versions").all() as Array<{ artifactKey: string }>).map((row) => row.artifactKey));
    const metadataRows = db.prepare("SELECT sha256,storageKey,sizeBytes,state,createdAt FROM artifact_objects").all() as ArtifactObjectRow[];
    result.scanned.metadataRows = metadataRows.length;
    const metadataByKey = new Map(metadataRows.map((row) => [row.storageKey, row]));
    const seenCommitted = new Set<string>();

    let processedSinceRenew = 0;
    const maybeRenew = () => {
      if (!gcLease) return;
      processedSinceRenew += 1;
      if (processedSinceRenew >= 250) {
        gcLease = leases.renew(gcLease);
        processedSinceRenew = 0;
      }
    };

    for await (const entry of artifactStore.list("staging/")) {
      result.scanned.staging += 1;
      maybeRenew();
      try { assertStagedKey(entry.key); }
      catch { result.skippedInvalidKeys.push(entry.key); continue; }
      const age = oldEnough(entry, undefined, cutoffMs);
      if (!age.eligible) continue;
      result.candidates.push({ key: entry.key, kind: "staging", reason: "stale_staging", sizeBytes: entry.sizeBytes, ageSource: age.ageSource });
    }

    for await (const entry of artifactStore.list("sha256/")) {
      result.scanned.committed += 1;
      maybeRenew();
      try { assertArtifactKey(entry.key); }
      catch { result.skippedInvalidKeys.push(entry.key); continue; }
      seenCommitted.add(entry.key);
      if (referenced.has(entry.key)) continue;
      const metadata = metadataByKey.get(entry.key);
      const age = oldEnough(entry, metadata?.createdAt, cutoffMs);
      if (!age.eligible) continue;
      result.candidates.push({
        key: entry.key,
        kind: "committed",
        reason: metadata ? "unreferenced_object" : "orphan_storage_object",
        sizeBytes: entry.sizeBytes,
        ageSource: age.ageSource,
      });
    }

    for (const metadata of metadataRows) {
      if (referenced.has(metadata.storageKey) || seenCommitted.has(metadata.storageKey)) continue;
      const createdAt = parseTimestamp(metadata.createdAt);
      if (createdAt === null || createdAt > cutoffMs) continue;
      result.candidates.push({
        key: metadata.storageKey,
        kind: "metadata",
        reason: "orphan_metadata",
        sizeBytes: metadata.sizeBytes,
        ageSource: metadata.createdAt,
      });
    }

    result.candidates.sort((left, right) => left.key.localeCompare(right.key) || left.kind.localeCompare(right.kind));
    if (dryRun) return result;

    const deleteCandidates = result.candidates.slice(0, maxDeletes);
    result.truncated = result.candidates.length > deleteCandidates.length;
    for (const candidate of deleteCandidates) {
      gcLease = leases.renew(gcLease!);
      const currentlyReferenced = candidate.kind === "staging"
        ? false
        : Boolean(db.prepare("SELECT 1 FROM extension_versions WHERE artifactKey=? LIMIT 1").get(candidate.key));
      if (currentlyReferenced) continue;
      if (candidate.kind !== "metadata") await artifactStore.remove(candidate.key);
      if (candidate.kind !== "staging") {
        db.prepare(`DELETE FROM artifact_objects WHERE storageKey=?
          AND NOT EXISTS (SELECT 1 FROM extension_versions WHERE extension_versions.artifactKey=artifact_objects.storageKey)`).run(candidate.key);
      }
      result.deleted.push(candidate);
    }
    db.prepare(`INSERT INTO audit_log(actorType,actorId,action,targetType,targetId,metadataJson,ipAddress,createdAt)
      VALUES ('system',NULL,'maintenance.artifact_gc','artifact_store',NULL,?,NULL,?)`).run(
      JSON.stringify({ dryRun: false, cutoff, candidates: result.candidates.length, deleted: result.deleted.length, truncated: result.truncated }),
      new Date().toISOString(),
    );
    return result;
  } finally {
    leases.release(gcLease);
  }
}
