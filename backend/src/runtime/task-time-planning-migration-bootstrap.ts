import { MIGRATIONS as BASE_MIGRATIONS } from "../db/migrations.impl.js";
import { taskTimePlanningMigration } from "../db/taskTimePlanningMigration.js";

if (!BASE_MIGRATIONS.some((migration) => migration.version === taskTimePlanningMigration.version)) {
  BASE_MIGRATIONS.push(taskTimePlanningMigration);
  BASE_MIGRATIONS.sort((a, b) => a.version - b.version);
}
