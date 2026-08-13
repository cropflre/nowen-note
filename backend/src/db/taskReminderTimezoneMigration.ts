import type { Migration } from "./migrations.impl.js";

export const taskReminderTimezoneMigration: Migration = {
  version: 80,
  name: "task-reminder-timezone-offset",
  up: (db) => {
    const columns = db.prepare("PRAGMA table_info(task_reminders)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "timezoneOffsetMinutes")) {
      db.prepare("ALTER TABLE task_reminders ADD COLUMN timezoneOffsetMinutes INTEGER").run();
    }
  },
};
