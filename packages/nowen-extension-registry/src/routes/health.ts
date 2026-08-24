import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono, type Context } from "hono";
import type { RegistryConfig } from "../config.js";
import type { ArtifactStore } from "../storage/artifactStore.js";

export function createHealthRoutes(db: DatabaseSync, config: RegistryConfig, artifactStore: ArtifactStore): Hono {
  const app = new Hono();
  const handler = async (c: Context) => {
    const components: Record<"database" | "artifactStore" | "signer", { ok: boolean; detail?: string }> = {
      database: { ok: false, detail: "unavailable" },
      artifactStore: { ok: false, detail: "unavailable" },
      signer: { ok: false, detail: "unavailable" },
    };
    try {
      db.prepare("SELECT 1").get();
      components.database = { ok: true, detail: "ready" };
    } catch {}
    components.artifactStore = await artifactStore.health();
    try {
      const probe = crypto.randomBytes(32);
      const signature = crypto.sign(null, probe, config.signingPrivateKey);
      const derivedPublicKey = crypto.createPublicKey(config.signingPrivateKey);
      if (derivedPublicKey.asymmetricKeyType !== "ed25519" || !crypto.verify(null, probe, derivedPublicKey, signature)) throw new Error("signer probe failed");
      components.signer = { ok: true, detail: "ready" };
    } catch {}
    const ok = components.database.ok && components.artifactStore.ok && components.signer.ok;
    return c.json({ ok, service: "nowen-extension-registry", isolation: "marketplace-only", components }, ok ? 200 : 503);
  };
  app.get("/", handler);
  app.get("", handler);
  return app;
}
