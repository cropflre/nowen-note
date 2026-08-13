ALTER TABLE notebook_share_links
  ADD COLUMN IF NOT EXISTS "maxUses" INTEGER;

ALTER TABLE notebook_share_links
  ADD COLUMN IF NOT EXISTS "useCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notebook_members
  ADD COLUMN IF NOT EXISTS "allowDownload" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE notebook_members
  ADD COLUMN IF NOT EXISTS "allowReshare" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notebook_members
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE notebook_members
  ADD COLUMN IF NOT EXISTS "sourceId" TEXT;

CREATE INDEX IF NOT EXISTS idx_notebook_members_source
  ON notebook_members(source, "sourceId");
