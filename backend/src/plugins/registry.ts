import { getDb } from "../db/schema.js";
import type { PluginManifestV1, PluginRegistryRecord, PluginSource, PluginStatus, PluginTrustLevel } from "./types.js";

function now(): string {
  return new Date().toISOString();
}

export class PluginRegistry {
  list(): PluginRegistryRecord[] {
    return getDb().prepare("SELECT * FROM plugin_registry ORDER BY name COLLATE NOCASE").all() as PluginRegistryRecord[];
  }

  get(id: string): PluginRegistryRecord | undefined {
    return getDb().prepare("SELECT * FROM plugin_registry WHERE id = ?").get(id) as PluginRegistryRecord | undefined;
  }

  upsert(input: {
    manifest: PluginManifestV1;
    source: PluginSource;
    trustLevel: PluginTrustLevel;
    status: PluginStatus;
    checksum: string;
    installedPath: string;
    installedBy: string | null;
  }): PluginRegistryRecord {
    const timestamp = now();
    getDb().prepare(`
      INSERT INTO plugin_registry (
        id, name, version, apiVersion, runtime, main, source, trustLevel, status,
        checksum, manifestJson, installedPath, installedBy, installedAt, updatedAt, lastError
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, version=excluded.version, apiVersion=excluded.apiVersion,
        runtime=excluded.runtime, main=excluded.main, source=excluded.source,
        trustLevel=excluded.trustLevel, status=excluded.status, checksum=excluded.checksum,
        manifestJson=excluded.manifestJson, installedPath=excluded.installedPath,
        installedBy=excluded.installedBy, updatedAt=excluded.updatedAt, lastError=NULL
    `).run(
      input.manifest.id, input.manifest.name, input.manifest.version,
      input.manifest.apiVersion, input.manifest.runtime, input.manifest.main,
      input.source, input.trustLevel, input.status, input.checksum,
      JSON.stringify(input.manifest), input.installedPath, input.installedBy,
      timestamp, timestamp,
    );
    return this.get(input.manifest.id)!;
  }

  setStatus(id: string, status: PluginStatus, lastError: string | null = null): void {
    getDb().prepare("UPDATE plugin_registry SET status=?, lastError=?, updatedAt=? WHERE id=?")
      .run(status, lastError, now(), id);
  }

  setPath(id: string, installedPath: string): void {
    getDb().prepare("UPDATE plugin_registry SET installedPath=?, updatedAt=? WHERE id=?")
      .run(installedPath, now(), id);
  }

  remove(id: string): void {
    getDb().prepare("DELETE FROM plugin_registry WHERE id = ?").run(id);
  }
}
