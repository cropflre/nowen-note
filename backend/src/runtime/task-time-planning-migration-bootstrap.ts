import { MIGRATIONS } from "../db/migrations.js";

if (!MIGRATIONS.some((migration) => migration.version === 76)) {
  throw new Error("[task-time-planning-bootstrap] missing canonical migration v76");
}
