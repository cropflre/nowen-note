import { MIGRATIONS } from "../db/migrations.js";

if (!MIGRATIONS.some((migration) => migration.version === 77)) {
  throw new Error("[task-inbox-bootstrap] missing canonical migration v77");
}
