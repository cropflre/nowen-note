import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";
import { excelDocumentsMigration } from "./excelDocumentsMigration.js";

/**
 * fork 专属迁移登记处。
 *
 * 官方迁移用「版本号」作为唯一身份（见 migrations.ts 的 getAppliedMigrationVersions），
 * 所以 fork 专属迁移一旦占用某个版本号，而官方日后又启用了同一个号（name 不同），
 * 旧库 ledger 里的历史行就会把官方迁移判成“已应用”而跳过，进而引发连锁缺表报错。
 *
 * 规避方式：
 *   1) fork 专属迁移放在保留版本段（>= 900000），官方顺序号永远不会到达；
 *   2) 每次启动按 name 对账历史 ledger，把老部署遗留的同款记录改写到当前版本，
 *      并清理同名重复行——这样现存 NAS 库无需手动 DELETE 即可自愈，将来再改名也不会复发。
 *
 * 新增 fork 专属迁移时，只需把它加入 FORK_MIGRATIONS 并给它一个保留段版本号。
 */
export const FORK_MIGRATIONS: readonly Migration[] = [
  excelDocumentsMigration,
];

function ensureMigrationsTable(db: Database.Database): void {
  // 与 migrations.ts 的 ensureMigrationsTable 保持一致；此处重复是为了让对账逻辑可独立调用（例如测试）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * 启动前置对账：把 fork 专属迁移在 schema_migrations 中的记录规范到当前注册版本。
 *
 * - 已是当前版本且唯一：不动（避免每次启动都写库）。
 * - 存在于旧版本（历史占号）或出现同名重复行：删除后按当前版本重新登记。
 *   fork 迁移均为幂等迁移，重新登记只影响 ledger，不会重复执行破坏性 DDL。
 */
export function reconcileForkMigrationLedger(db: Database.Database): void {
  ensureMigrationsTable(db);
  const select = db.prepare("SELECT version FROM schema_migrations WHERE name = ?");
  const remove = db.prepare("DELETE FROM schema_migrations WHERE name = ?");
  const insert = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");

  const normalize = db.transaction(() => {
    for (const migration of FORK_MIGRATIONS) {
      const rows = select.all(migration.name) as Array<{ version: number }>;
      // 从未登记过：说明还没跑过，交给正常迁移流程去应用，不能在这里预登记成已应用。
      if (rows.length === 0) continue;
      const alreadyCurrent = rows.length === 1 && rows[0].version === migration.version;
      if (alreadyCurrent) continue;
      remove.run(migration.name);
      insert.run(migration.version, migration.name);
      console.log(
        `[migrations] reconciled fork ledger: ${migration.name} -> v${migration.version}`,
      );
    }
  });
  normalize();
}

/**
 * 现网旧库的 excel_documents 由 fork 迁移 v900001 创建，不含官方 v148 引入的 revision
 * 乐观锁列；而官方 v148 的 CREATE TABLE IF NOT EXISTS 会因表已存在而跳过建表，
 * 后端读写 revision 时会直接报错。这里在迁移流程结束后做一次幂等列对齐。
 */
export function ensureForkExcelDocumentSchema(db: Database.Database): void {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'excel_documents'")
    .get();
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info(excel_documents)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "revision")) return;
  db.exec("ALTER TABLE excel_documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  console.log("[migrations] reconciled fork schema: excel_documents.revision added");
}
