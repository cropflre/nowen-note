import assert from "node:assert/strict";
import test from "node:test";

import { MIGRATIONS } from "../src/db/migrations";
import { extensionAdvisorySchemaRepairMigration } from "../src/db/extensionAdvisorySchemaRepairMigration";

test("registers a newer migration that repairs a missing advisoryAutoDisabled column", () => {
  assert.equal(extensionAdvisorySchemaRepairMigration.version, 100);
  assert.equal(
    MIGRATIONS.some((migration) => migration.version === extensionAdvisorySchemaRepairMigration.version),
    true,
  );

  const pluginColumns = new Set(["id", "advisoryState"]);
  const executed: string[] = [];
  const db = {
    prepare(sql: string) {
      assert.equal(sql, "PRAGMA table_info(plugin_registry)");
      return {
        all: () => [...pluginColumns].map((name) => ({ name })),
      };
    },
    exec(sql: string) {
      executed.push(sql);
      if (sql.includes("ADD COLUMN advisoryAutoDisabled")) {
        pluginColumns.add("advisoryAutoDisabled");
      }
    },
  };

  extensionAdvisorySchemaRepairMigration.up(db as never);
  extensionAdvisorySchemaRepairMigration.up(db as never);

  assert.equal(executed.length, 1);
  assert.match(executed[0], /ADD COLUMN advisoryAutoDisabled/);
});
