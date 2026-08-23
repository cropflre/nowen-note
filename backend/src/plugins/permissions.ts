import { getDb } from "../db/schema.js";
import { PLUGIN_PERMISSIONS, type PluginManifestV1, type PluginPermission } from "./types.js";

const knownPermissions = new Set<string>(PLUGIN_PERMISSIONS);

export interface PermissionRow {
  pluginId: string;
  permission: PluginPermission;
  configJson: string;
  granted: number;
  grantedBy: string | null;
  grantedAt: string | null;
}

export class PluginPermissions {
  initialize(manifest: PluginManifestV1): void {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO plugin_permissions (pluginId, permission, configJson, granted)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(pluginId, permission) DO UPDATE SET configJson=excluded.configJson, granted=0, grantedBy=NULL, grantedAt=NULL
    `);
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM plugin_permissions WHERE pluginId=?").run(manifest.id);
      for (const permission of manifest.permissions) {
        const config = permission === "external:fetch"
          ? { hosts: manifest.permissionConfig?.externalFetchHosts || [] }
          : {};
        insert.run(manifest.id, permission, JSON.stringify(config));
      }
    });
    transaction();
  }

  list(pluginId: string): PermissionRow[] {
    return getDb().prepare("SELECT * FROM plugin_permissions WHERE pluginId=? ORDER BY permission")
      .all(pluginId) as PermissionRow[];
  }

  replaceGrants(pluginId: string, requested: string[], grantedBy: string): PermissionRow[] {
    if (requested.some((permission) => !knownPermissions.has(permission))) {
      throw new Error("包含未知插件权限");
    }
    const declared = new Set(this.list(pluginId).map((row) => row.permission));
    if (requested.some((permission) => !declared.has(permission as PluginPermission))) {
      throw new Error("不能授予 Manifest 未声明的权限");
    }
    const db = getDb();
    const granted = new Set(requested);
    const update = db.prepare(`
      UPDATE plugin_permissions
      SET granted=?, grantedBy=?, grantedAt=?
      WHERE pluginId=? AND permission=?
    `);
    db.transaction(() => {
      for (const row of this.list(pluginId)) {
        const enabled = granted.has(row.permission);
        update.run(enabled ? 1 : 0, enabled ? grantedBy : null, enabled ? new Date().toISOString() : null, pluginId, row.permission);
      }
    })();
    return this.list(pluginId);
  }

  require(pluginId: string, permission: PluginPermission): PermissionRow {
    const row = getDb().prepare(
      "SELECT * FROM plugin_permissions WHERE pluginId=? AND permission=? AND granted=1",
    ).get(pluginId, permission) as PermissionRow | undefined;
    if (!row) {
      const error = new Error(`插件未获权限: ${permission}`) as Error & { code?: string };
      error.code = "PLUGIN_PERMISSION_DENIED";
      throw error;
    }
    return row;
  }

  allDeclaredGranted(pluginId: string): boolean {
    const row = getDb().prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN granted=1 THEN 1 ELSE 0 END) AS granted FROM plugin_permissions WHERE pluginId=?",
    ).get(pluginId) as { total: number; granted: number | null };
    return row.total === (row.granted || 0);
  }

  resetAll(): void {
    getDb().prepare("UPDATE plugin_permissions SET granted=0, grantedBy=NULL, grantedAt=NULL").run();
  }
}
