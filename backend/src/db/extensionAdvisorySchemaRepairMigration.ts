import type { Migration } from "./migrations.impl.js";

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (item) => item.name === column,
  );
}

/** 修复恢复旧表结构后，迁移账本已记录 v99 但安全公告列实际缺失的数据库。 */
export const extensionAdvisorySchemaRepairMigration: Migration = {
  version: 100,
  name: "repair-extension-advisory-schema",
  up: (db) => {
    if (!hasColumn(db, "plugin_registry", "advisoryAutoDisabled")) {
      db.exec(
        "ALTER TABLE plugin_registry ADD COLUMN advisoryAutoDisabled INTEGER NOT NULL DEFAULT 0 CHECK (advisoryAutoDisabled IN (0, 1))",
      );
    }
  },
};
