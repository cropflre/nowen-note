import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Hono, type Context } from "hono";
import type { RegistryConfig } from "../config.js";

export function createHealthRoutes(db: DatabaseSync, config: RegistryConfig): Hono {
  const app = new Hono();
  const handler = (c: Context) => {
    const components = {
      database: { ok: false, detail: "unavailable" },
      artifactStore: { ok: false, detail: "unavailable" },
      signer: { ok: false, detail: "unavailable" },
    };
    try {
      db.prepare("SELECT 1").get();
      components.database = { ok: true, detail: "ready" };
    } catch {}
    try {
      const artifactRoot = path.join(config.dataRoot, "artifacts");
      fs.accessSync(artifactRoot, fs.constants.R_OK | fs.constants.W_OK);
      components.artifactStore = { ok: true, detail: "ready" };
    } catch {}
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
