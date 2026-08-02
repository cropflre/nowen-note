import { MIGRATIONS as BASE_MIGRATIONS } from "../db/migrations.impl.js";
import { taskInboxMigration } from "../db/taskInboxMigration.js";

if (!BASE_MIGRATIONS.some((migration) => migration.version === taskInboxMigration.version)) {
  BASE_MIGRATIONS.push(taskInboxMigration);
  BASE_MIGRATIONS.sort((a, b) => a.version - b.version);
}
