import { MIGRATIONS } from "../db/migrations.js";

if (!MIGRATIONS.some((migration) => migration.version === 75)) {
  throw new Error("[task-metadata-bootstrap] missing canonical migration v75");
}
