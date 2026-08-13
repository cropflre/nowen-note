ALTER TABLE task_reminders
  ADD COLUMN IF NOT EXISTS "timezoneOffsetMinutes" INTEGER;
