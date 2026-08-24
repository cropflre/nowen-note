import { getDb } from "../db/schema.js";
import type { PluginManifest, PluginRegistryRecord, PluginSource, PluginStatus, PluginTrustLevel, PluginVersionRecord } from "./types.js";

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
    manifest: PluginManifest;
    source: PluginSource;
    trustLevel: PluginTrustLevel;
    status: PluginStatus;
    checksum: string;
    installedPath: string;
    installedBy: string | null;
    publisherKeyId?: string | null;
    signature?: string | null;
    signatureState?: string;
    artifactUrl?: string | null;
    nodeRuntimeConfirmedBy?: string | null;
  }): PluginRegistryRecord {
    const timestamp = now();
    const confirmedAt = input.nodeRuntimeConfirmedBy ? timestamp : null;
    const db = getDb();
    db.transaction(() => {
    db.prepare(`
      INSERT INTO plugin_registry (
        id, name, version, apiVersion, runtime, main, source, trustLevel, status,
        checksum, manifestJson, installedPath, installedBy, installedAt, updatedAt, lastError,
        publisher, signatureState, updatePolicy, lifecycleState, stateUpdatedAt,
        nodeRuntimeConfirmedAt, nodeRuntimeConfirmedBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'installed', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        previousVersion=CASE WHEN plugin_registry.version<>excluded.version THEN plugin_registry.version ELSE plugin_registry.previousVersion END,
        nodeRuntimeConfirmedAt=CASE
          WHEN excluded.nodeRuntimeConfirmedAt IS NOT NULL THEN excluded.nodeRuntimeConfirmedAt
          WHEN plugin_registry.apiVersion=excluded.apiVersion
            AND plugin_registry.runtime=excluded.runtime
            AND COALESCE(plugin_registry.publisher,'')=COALESCE(excluded.publisher,'')
            AND plugin_registry.trustLevel=excluded.trustLevel
          THEN plugin_registry.nodeRuntimeConfirmedAt
          ELSE NULL
        END,
        nodeRuntimeConfirmedBy=CASE
          WHEN excluded.nodeRuntimeConfirmedBy IS NOT NULL THEN excluded.nodeRuntimeConfirmedBy
          WHEN plugin_registry.apiVersion=excluded.apiVersion
            AND plugin_registry.runtime=excluded.runtime
            AND COALESCE(plugin_registry.publisher,'')=COALESCE(excluded.publisher,'')
            AND plugin_registry.trustLevel=excluded.trustLevel
          THEN plugin_registry.nodeRuntimeConfirmedBy
          ELSE NULL
        END,
        name=excluded.name, version=excluded.version, apiVersion=excluded.apiVersion,
        runtime=excluded.runtime, main=excluded.main, source=excluded.source,
        trustLevel=excluded.trustLevel, status=excluded.status, checksum=excluded.checksum,
        manifestJson=excluded.manifestJson, installedPath=excluded.installedPath,
        installedBy=excluded.installedBy, updatedAt=excluded.updatedAt, lastError=NULL,
        publisher=excluded.publisher,signatureState=excluded.signatureState,
        lifecycleState='installed',activeOperationId=NULL,stateUpdatedAt=excluded.stateUpdatedAt
    `).run(
      input.manifest.id, input.manifest.name, input.manifest.version,
      input.manifest.apiVersion, input.manifest.runtime, input.manifest.main,
      input.source, input.trustLevel, input.status, input.checksum,
      JSON.stringify(input.manifest), input.installedPath, input.installedBy,
      timestamp, timestamp, input.manifest.apiVersion === 2 ? input.manifest.publisher : null, input.signatureState || "unsigned",
      input.manifest.runtime === "sandbox-js" && input.trustLevel === "official" ? "automatic" : "manual",
      timestamp, confirmedAt, input.nodeRuntimeConfirmedBy || null,
    );
    getDb().prepare(`INSERT INTO plugin_versions
      (pluginId,version,manifestJson,checksum,installedPath,source,trustLevel,status,installedAt,verifiedAt,publisherKeyId,signature,signatureState,artifactUrl)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)
      ON CONFLICT(pluginId,version) DO UPDATE SET
        manifestJson=excluded.manifestJson,checksum=excluded.checksum,installedPath=excluded.installedPath,
        source=excluded.source,trustLevel=excluded.trustLevel,status=excluded.status,
        publisherKeyId=excluded.publisherKeyId,signature=excluded.signature,signatureState=excluded.signatureState,artifactUrl=excluded.artifactUrl`)
      .run(input.manifest.id, input.manifest.version, JSON.stringify(input.manifest), input.checksum,
        input.installedPath, input.source, input.trustLevel, input.status, timestamp,
        input.publisherKeyId || null, input.signature || null, input.signatureState || "unsigned", input.artifactUrl || null);
    })();
    return this.get(input.manifest.id)!;
  }

  registerVersion(input: {
    manifest: PluginManifest;
    checksum: string;
    installedPath: string;
    source: PluginSource;
    trustLevel: PluginTrustLevel;
    status: string;
    publisherKeyId?: string | null;
    signature?: string | null;
    signatureState?: string;
    artifactUrl?: string | null;
  }): PluginVersionRecord {
    const existing = this.getVersion(input.manifest.id, input.manifest.version);
    if (existing && existing.checksum !== input.checksum) {
      throw Object.assign(new Error("相同插件坐标对应不同内容"), { code: "PLUGIN_VERSION_COORDINATE_CONFLICT" });
    }
    getDb().prepare(`INSERT INTO plugin_versions
      (pluginId,version,manifestJson,checksum,installedPath,source,trustLevel,status,installedAt,verifiedAt,publisherKeyId,signature,signatureState,artifactUrl)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)
      ON CONFLICT(pluginId,version) DO UPDATE SET
        manifestJson=excluded.manifestJson,installedPath=excluded.installedPath,source=excluded.source,
        trustLevel=excluded.trustLevel,status=excluded.status,publisherKeyId=excluded.publisherKeyId,
        signature=excluded.signature,signatureState=excluded.signatureState,artifactUrl=excluded.artifactUrl`)
      .run(
        input.manifest.id,
        input.manifest.version,
        JSON.stringify(input.manifest),
        input.checksum,
        input.installedPath,
        input.source,
        input.trustLevel,
        input.status,
        now(),
        input.publisherKeyId || null,
        input.signature || null,
        input.signatureState || "unsigned",
        input.artifactUrl || null,
      );
    return this.getVersion(input.manifest.id, input.manifest.version)!;
  }

  recordForVersion(
    id: string,
    version: string,
    options: { nodeRuntimeConfirmedBy?: string | null } = {},
  ): PluginRegistryRecord {
    const current = this.get(id);
    const target = this.getVersion(id, version);
    if (!current || !target) throw Object.assign(new Error("插件版本不存在"), { code: "PLUGIN_VERSION_NOT_FOUND" });
    const manifest = JSON.parse(target.manifestJson) as PluginManifest;
    const sameRuntimeBoundary = current.apiVersion === manifest.apiVersion
      && current.runtime === manifest.runtime
      && (current.apiVersion === 2 ? current.publisher : null) === (manifest.apiVersion === 2 ? manifest.publisher : null)
      && current.trustLevel === target.trustLevel;
    return {
      ...current,
      name: manifest.name,
      version: target.version,
      apiVersion: manifest.apiVersion,
      runtime: manifest.runtime,
      main: manifest.main,
      source: target.source,
      trustLevel: target.trustLevel,
      checksum: target.checksum,
      manifestJson: target.manifestJson,
      installedPath: target.installedPath,
      publisher: manifest.apiVersion === 2 ? manifest.publisher : null,
      signatureState: target.signatureState || "unsigned",
      nodeRuntimeConfirmedAt: options.nodeRuntimeConfirmedBy ? now() : sameRuntimeBoundary ? current.nodeRuntimeConfirmedAt : null,
      nodeRuntimeConfirmedBy: options.nodeRuntimeConfirmedBy || (sameRuntimeBoundary ? current.nodeRuntimeConfirmedBy : null),
    };
  }

  setStatus(id: string, status: PluginStatus, lastError: string | null = null): void {
    getDb().prepare("UPDATE plugin_registry SET status=?, lastError=?, updatedAt=? WHERE id=?")
      .run(status, lastError, now(), id);
  }

  setPath(id: string, installedPath: string): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare("UPDATE plugin_registry SET installedPath=?, updatedAt=? WHERE id=?")
        .run(installedPath, now(), id);
      db.prepare("UPDATE plugin_versions SET installedPath=? WHERE pluginId=? AND version=(SELECT version FROM plugin_registry WHERE id=?)")
        .run(installedPath, id, id);
    })();
  }

  listVersions(id: string): PluginVersionRecord[] {
    return getDb().prepare("SELECT * FROM plugin_versions WHERE pluginId=? ORDER BY installedAt DESC")
      .all(id) as PluginVersionRecord[];
  }

  getVersion(id: string, version: string): PluginVersionRecord | undefined {
    return getDb().prepare("SELECT * FROM plugin_versions WHERE pluginId=? AND version=?")
      .get(id, version) as PluginVersionRecord | undefined;
  }

  markCurrentVersion(id: string, status: string, verified: boolean): void {
    getDb().prepare(`UPDATE plugin_versions SET status=?,verifiedAt=?
      WHERE pluginId=? AND version=(SELECT version FROM plugin_registry WHERE id=?)`)
      .run(status, verified ? now() : null, id, id);
  }

  switchVersion(id: string, version: string): PluginRegistryRecord {
    const target = this.getVersion(id, version);
    const current = this.get(id);
    if (!target || !current) throw Object.assign(new Error("插件版本不存在"), { code: "PLUGIN_VERSION_NOT_FOUND" });
    const manifest = JSON.parse(target.manifestJson) as PluginManifest;
    const currentManifest = JSON.parse(current.manifestJson) as PluginManifest;
    const sameRuntimeBoundary = currentManifest.apiVersion === manifest.apiVersion
      && currentManifest.runtime === manifest.runtime
      && (currentManifest.apiVersion === 2 ? currentManifest.publisher : null) === (manifest.apiVersion === 2 ? manifest.publisher : null)
      && current.trustLevel === target.trustLevel;
    getDb().prepare(`UPDATE plugin_registry SET
      name=?,version=?,apiVersion=?,runtime=?,main=?,source=?,trustLevel=?,status='quarantined',
      checksum=?,manifestJson=?,installedPath=?,previousVersion=?,publisher=?,signatureState=?,advisoryState='unknown',
      nodeRuntimeConfirmedAt=?,nodeRuntimeConfirmedBy=?,updatedAt=?,lastError=NULL
      WHERE id=?`).run(
        manifest.name, manifest.version, manifest.apiVersion, manifest.runtime, manifest.main,
        target.source, target.trustLevel, target.checksum, target.manifestJson, target.installedPath,
        current.version, manifest.apiVersion === 2 ? manifest.publisher : null, target.signatureState || "unsigned",
        sameRuntimeBoundary ? current.nodeRuntimeConfirmedAt : null,
        sameRuntimeBoundary ? current.nodeRuntimeConfirmedBy : null,
        now(), id,
      );
    return this.get(id)!;
  }

  remove(id: string): void {
    getDb().prepare("DELETE FROM plugin_registry WHERE id = ?").run(id);
  }
}
