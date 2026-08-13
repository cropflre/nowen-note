CREATE TABLE IF NOT EXISTS task_reminder_delivery_state (
    "reminderId" TEXT PRIMARY KEY REFERENCES task_reminders(id) ON DELETE CASCADE,
    "taskId" TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "taskTitle" TEXT NOT NULL DEFAULT '',
    "scheduledFor" TIMESTAMPTZ NOT NULL,
    "triggeredAt" TIMESTAMPTZ,
    "ackedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_reminder_delivery_user_pending
    ON task_reminder_delivery_state("userId", "triggeredAt")
    WHERE "ackedAt" IS NULL AND "triggeredAt" IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_reminder_scanner_leases (
    name TEXT PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "leaseUntil" TIMESTAMPTZ NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
