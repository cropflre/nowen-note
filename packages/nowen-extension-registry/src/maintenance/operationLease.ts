import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withImmediateTransaction } from "../db/transaction.js";

export type RegistryLeaseKind = "publish" | "artifact_gc";

export interface RegistryOperationLeaseHandle {
  id: string;
  kind: RegistryLeaseKind;
  expiresAt: number;
}

export class RegistryMaintenanceBusyError extends Error {
  constructor(message = "registry maintenance is busy") {
    super(message);
    this.name = "RegistryMaintenanceBusyError";
  }
}

const PUBLISH_TTL_MS = 15 * 60 * 1_000;
const GC_TTL_MS = 30 * 60 * 1_000;

export class RegistryOperationLeaseManager {
  constructor(private readonly db: DatabaseSync) {}

  acquirePublish(holder: string, ttlMs = PUBLISH_TTL_MS): RegistryOperationLeaseHandle {
    return this.acquire("publish", holder, ttlMs, false);
  }

  acquireArtifactGc(holder = `gc-${crypto.randomUUID()}`, ttlMs = GC_TTL_MS): RegistryOperationLeaseHandle {
    return this.acquire("artifact_gc", holder, ttlMs, true);
  }

  renew(handle: RegistryOperationLeaseHandle, ttlMs = handle.kind === "artifact_gc" ? GC_TTL_MS : PUBLISH_TTL_MS): RegistryOperationLeaseHandle {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const changed = this.db.prepare("UPDATE registry_operation_leases SET expiresAt=? WHERE id=? AND kind=? AND expiresAt>?")
      .run(expiresAt, handle.id, handle.kind, now);
    if (changed.changes !== 1) throw new RegistryMaintenanceBusyError("registry operation lease was lost");
    return { ...handle, expiresAt };
  }

  release(handle: RegistryOperationLeaseHandle | undefined): void {
    if (!handle) return;
    this.db.prepare("DELETE FROM registry_operation_leases WHERE id=? AND kind=?").run(handle.id, handle.kind);
  }

  private acquire(kind: RegistryLeaseKind, holder: string, ttlMs: number, exclusive: boolean): RegistryOperationLeaseHandle {
    if (!holder || holder.length > 160) throw new Error("registry operation lease holder is invalid");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60 * 1_000) throw new Error("registry operation lease ttl is invalid");
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + ttlMs;
    return withImmediateTransaction(this.db, () => {
      this.db.prepare("DELETE FROM registry_operation_leases WHERE expiresAt<=?").run(now);
      if (exclusive) {
        const active = this.db.prepare("SELECT kind FROM registry_operation_leases LIMIT 1").get() as { kind: RegistryLeaseKind } | undefined;
        if (active) throw new RegistryMaintenanceBusyError(`registry has an active ${active.kind} operation`);
      } else if (this.db.prepare("SELECT 1 FROM registry_operation_leases WHERE kind='artifact_gc' LIMIT 1").get()) {
        throw new RegistryMaintenanceBusyError("artifact garbage collection is active");
      }
      this.db.prepare("INSERT INTO registry_operation_leases(id,kind,holder,expiresAt,createdAt) VALUES (?,?,?,?,?)")
        .run(id, kind, holder, expiresAt, new Date(now).toISOString());
      return { id, kind, expiresAt };
    });
  }
}
