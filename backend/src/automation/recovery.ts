import { getDb } from "../db/schema.js";

export function quarantineRestoredAutomations(): void {
  const exists = getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_workflows'").get();
  if (!exists) return;
  const now = new Date().toISOString();
  getDb().transaction(() => {
    getDb().prepare("UPDATE automation_workflows SET enabled=0,updatedAt=?").run(now);
    getDb().prepare("UPDATE automation_schedules SET enabled=0,lockedBy=NULL,lockedAt=NULL").run();
    getDb().prepare("UPDATE automation_webhooks SET enabled=0").run();
    getDb().prepare(`UPDATE automation_workflow_runs SET status='interrupted',finishedAt=?,errorCode='RESTORE_INTERRUPTED',errorMessage='备份恢复后自动化需要重新确认',requiresAttention=1,lockedBy=NULL,lockedAt=NULL WHERE status IN ('queued','running','waiting')`).run(now);
  })();
}
