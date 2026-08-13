-- Durable task automation deliveries are keyed for idempotent restart-safe notification.
CREATE TABLE IF NOT EXISTS task_automation_delivery_state (
    "deliveryId" TEXT PRIMARY KEY,
    "taskId" TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "taskTitle" TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (type IN ('dependency_ready', 'overdue_daily')),
    "scheduledFor" TIMESTAMPTZ NOT NULL,
    "triggeredAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "ackedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_automation_delivery_user_pending
    ON task_automation_delivery_state("userId", "triggeredAt")
    WHERE "ackedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_automation_delivery_task_type
    ON task_automation_delivery_state("taskId", type);
