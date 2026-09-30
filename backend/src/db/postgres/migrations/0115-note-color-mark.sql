ALTER TABLE notes ADD COLUMN IF NOT EXISTS "colorMark" TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_color_mark ON notes("colorMark");
