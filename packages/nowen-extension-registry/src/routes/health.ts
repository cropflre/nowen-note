import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono, type Context } from "hono";
import type { RegistryConfig } from "../config.js";
import { registryRuntimeMetrics } from "../observability/metrics.js";
import type { ArtifactStore } from "../storage/artifactStore.js";

interface ComponentState {
  ok: boolean;
}

function scalarCount(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { count: number } | undefined;
  return Number(row?.count || 0);
}

function indexSequence(db: DatabaseSync): number {
  const row = db.prepare("SELECT sequence FROM registry_metadata_sequence WHERE documentType='index'").get() as { sequence: number } | undefined;
  return Number(row?.sequence || 0);
}

function databaseReady(db: DatabaseSync): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

function signerReady(config: RegistryConfig): boolean {
  try {
    const probe = crypto.randomBytes(32);
    const signature = crypto.sign(null, probe, config.signingPrivateKey);
    const derivedPublicKey = crypto.createPublicKey(config.signingPrivateKey);
    return derivedPublicKey.asymmetricKeyType === "ed25519" && crypto.verify(null, probe, derivedPublicKey, signature);
  } catch {
    return false;
  }
}

export function createHealthRoutes(db: DatabaseSync, config: RegistryConfig, artifactStore: ArtifactStore): Hono {
  const app = new Hono();

  const live = (c: Context) => c.json({
    ok: true,
    service: "nowen-extension-registry",
    probe: "liveness",
    uptimeSeconds: registryRuntimeMetrics.snapshot().uptimeSeconds,
  });

  const ready = async (c: Context) => {
    const components: Record<"database" | "artifactStore" | "signer", ComponentState> = {
      database: { ok: databaseReady(db) },
      artifactStore: { ok: false },
      signer: { ok: signerReady(config) },
    };
    try {
      components.artifactStore = { ok: Boolean((await artifactStore.health()).ok) };
    } catch {
      components.artifactStore = { ok: false };
    }
    const ok = components.database.ok && components.artifactStore.ok && components.signer.ok;
    return c.json({ ok, service: "nowen-extension-registry", probe: "readiness", components }, ok ? 200 : 503);
  };

  app.get("/live", live);
  app.get("/ready", ready);
  app.get("/status", (c) => {
    const dbOk = databaseReady(db);
    let catalog = { publishers: 0, listedExtensions: 0, versions: 0, pendingReports: 0, indexSequence: 0 };
    if (dbOk) {
      try {
        catalog = {
          publishers: scalarCount(db, "SELECT COUNT(*) AS count FROM publishers"),
          listedExtensions: scalarCount(db, "SELECT COUNT(*) AS count FROM extensions WHERE listed=1"),
          versions: scalarCount(db, "SELECT COUNT(*) AS count FROM extension_versions"),
          pendingReports: scalarCount(db, "SELECT COUNT(*) AS count FROM extension_reports WHERE status='pending'"),
          indexSequence: indexSequence(db),
        };
      } catch {
        // Status is intentionally best-effort and never exposes database/storage error details.
      }
    }
    const runtime = registryRuntimeMetrics.snapshot();
    return c.json({
      ok: dbOk,
      service: "nowen-extension-registry",
      probe: "status",
      environment: config.environment,
      storage: { driver: config.artifactStorage.driver, cdnConfigured: Boolean(config.artifactCdnBaseUrl) },
      catalog,
      runtime,
    }, dbOk ? 200 : 503);
  });

  // Backward-compatible /health readiness endpoint.
  app.get("/", ready);
  app.get("", ready);
  return app;
}
