-- Issue #928: diary posts carry arbitrary file attachments separately from images/videos.
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS attachments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE diary_attachments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'media';
ALTER TABLE diary_attachments ADD COLUMN IF NOT EXISTS filename TEXT;
