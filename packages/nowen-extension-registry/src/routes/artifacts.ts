import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { RegistryConfig } from "../config.js";
import type { ArtifactStore } from "../storage/artifactStore.js";

interface ArtifactRow {
  artifactKey: string;
  sha256: string;
  sizeBytes: number;
}

export function storageObjectUrl(baseUrl: URL, artifactKey: string): string {
  const encodedKey = artifactKey.split("/").map(encodeURIComponent).join("/");
  return new URL(encodedKey, baseUrl).toString();
}

export function artifactDownloadUrl(config: RegistryConfig, extensionId: string, version: string, artifactKey: string): string {
  if (config.artifactCdnBaseUrl) return storageObjectUrl(config.artifactCdnBaseUrl, artifactKey);
  return new URL(`/v2/artifacts/${encodeURIComponent(extensionId)}/${encodeURIComponent(version)}`, config.publicUrl).toString();
}

export function createArtifactRoutes(db: DatabaseSync, config: RegistryConfig, artifactStore: ArtifactStore): Hono {
  const app = new Hono();
  app.get("/:id/:version", async (c) => {
    const row = db.prepare("SELECT artifactKey,sha256,sizeBytes FROM extension_versions WHERE extensionId=? AND version=?")
      .get(c.req.param("id"), c.req.param("version")) as ArtifactRow | undefined;
    if (!row) return c.json({ error: "not found" }, 404);
    if (config.artifactCdnBaseUrl) return c.redirect(storageObjectUrl(config.artifactCdnBaseUrl, row.artifactKey), 302);
    if (!await artifactStore.exists(row.artifactKey)) return c.json({ error: "artifact temporarily unavailable" }, 503);
    const source = await artifactStore.read(row.artifactKey);
    const body = source instanceof Readable ? Readable.toWeb(source) : source;
    const headers = new Headers({
      "Content-Type": "application/zip",
      "Cache-Control": "public,max-age=31536000,immutable",
      "ETag": `"sha256-${row.sha256}"`,
      "X-Content-Type-Options": "nosniff",
    });
    if (row.sizeBytes > 0) headers.set("Content-Length", String(row.sizeBytes));
    return new Response(body as BodyInit, { headers });
  });
  return app;
}
