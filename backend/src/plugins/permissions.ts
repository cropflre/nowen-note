import { getDb } from "../db/schema.js";
import { isV2SupportedPluginPermission } from "./hostApiContract.js";
import { PLUGIN_PERMISSIONS, type PluginManifest, type PluginPermission } from "./types.js";

const legacyPermissions = new Set<string>(PLUGIN_PERMISSIONS);

export interface PermissionRow {
  pluginId: string;
  permission: PluginPermission;
  configJson: string;
  granted: number;
  grantedBy: string | null;
  grantedAt: string | null;
}

export class PluginPermissions {
  initialize(manifest: PluginManifest, options: { preserveExistingGrants?: boolean } = {}): void {
    if (manifest.apiVersion === 2 && manifest.permissions.some((permission) => !isV2SupportedPluginPermission(permission))) {
      throw new Error("Plugin API V2 Manifest 包含合同未支持的权限");
    }
    const db = getDb();
    const resetInsert = db.prepare(`
      INSERT INTO plugin_permissions (pluginId, permission, configJson, granted)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(pluginId, permission) DO UPDATE SET configJson=excluded.configJson, granted=0, grantedBy=NULL, grantedAt=NULL
    `);
    const preservingInsert = db.prepare(`
      INSERT INTO plugin_permissions (pluginId, permission, configJson, granted)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(pluginId, permission) DO UPDATE SET configJson=excluded.configJson
    `);
    const transaction = db.transaction(() => {
      if (!options.preserveExistingGrants) {
        db.prepare("DELETE FROM plugin_permissions WHERE pluginId=?").run(manifest.id);
      } else if (manifest.permissions.length === 0) {
        db.prepare("DELETE FROM plugin_permissions WHERE pluginId=?").run(manifest.id);
      } else {
        const placeholders = manifest.permissions.map(() => "?").join(",");
        db.prepare(`DELETE FROM plugin_permissions WHERE pluginId=? AND permission NOT IN (${placeholders})`)
          .run(manifest.id, ...manifest.permissions);
      }
      for (const permission of manifest.permissions) {
        const config = permission === "external:fetch"
          ? { hosts: manifest.permissionConfig?.externalFetchHosts || [] }
          : {};
        (options.preserveExistingGrants ? preservingInsert : resetInsert)
          .run(manifest.id, permission, JSON.stringify(config));
      }
    });
    transaction();
  }

  list(pluginId: string): PermissionRow[] {
    return getDb().prepare("SELECT * FROM plugin_permissions WHERE pluginId=? ORDER BY permission")
      .all(pluginId) as PermissionRow[];
  }

  replaceGrants(pluginId: string, requested: string[], grantedBy: string): PermissionRow[] {
    const record = getDb().prepare("SELECT apiVersion FROM plugin_registry WHERE id=?")
      .get(pluginId) as { apiVersion: number } | undefined;
    const permissionSupported = record?.apiVersion === 2
      ? isV2SupportedPluginPermission
      : (permission: string): permission is PluginPermission => legacyPermissions.has(permission);
    if (requested.some((permission) => !permissionSupported(permission))) {
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
