import type { Migration } from "./migrations.impl.js";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration.js";
export const NOTE_COLOR_MARK_SCHEMA_VERSION = 115;
export const noteColorMarkMigration: Migration = {
  version: NOTE_COLOR_MARK_SCHEMA_VERSION,
  name: "note-color-mark",
  up: (db) => {
    const columns = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "colorMark")) db.prepare("ALTER TABLE notes ADD COLUMN colorMark TEXT").run();
    db.exec("CREATE INDEX IF NOT EXISTS idx_notes_color_mark ON notes(colorMark)");
    installSyncOutboxCaptureTriggers(db);
  },
};
