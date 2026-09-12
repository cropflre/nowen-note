import type { Migration } from "./migrations.impl.js";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration.js";

export const noteThemeContributionMigration: Migration = {
  version: 102,
  name: "note-theme-contribution",
  up: (db) => {
    const columns = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "themeId")) {
      db.prepare("ALTER TABLE notes ADD COLUMN themeId TEXT").run();
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_notes_theme_id ON notes(themeId)");
    installSyncOutboxCaptureTriggers(db);
  },
};
