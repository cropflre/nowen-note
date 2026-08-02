import { taskMetadataMigration } from "../db/taskMetadataMigration.js";
import { MIGRATIONS as BASE_MIGRATIONS } from "../db/migrations.impl.js";

// Register before schema.ts imports migrations.ts. This mirrors the knowledge-tree
// feature bootstrap and avoids editing the historical migration wrapper from a
// feature branch.
if (!BASE_MIGRATIONS.some((migration) => migration.version === taskMetadataMigration.version)) {
  BASE_MIGRATIONS.push(taskMetadataMigration);
  BASE_MIGRATIONS.sort((a, b) => a.version - b.version);
}
