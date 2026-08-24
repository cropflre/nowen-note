import { DatabaseSync } from "node:sqlite";
import { runRegistryMigrations } from "./db/migrations.js";
import { runRegistryOperationLeaseMigration } from "./db/operationLeaseMigration.js";

export function openRegistry(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
  runRegistryMigrations(db);
  runRegistryOperationLeaseMigration(db);
  return db;
}
