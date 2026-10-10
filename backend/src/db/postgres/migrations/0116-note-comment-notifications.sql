-- 个人笔记评论复用同一通知表，不要求创建虚假的工作区。
ALTER TABLE notifications ALTER COLUMN "workspaceId" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_resource ON notifications("resourceType", "resourceId");
