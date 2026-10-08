import { getDb } from "../db/schema.js";

export function quarantineRestoredAutomations(): void {
  const db = getDb();
  const hasAutomation = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_workflows'").get());
  const hasTaskDigest = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_digest_settings'").get());
  if (!hasAutomation && !hasTaskDigest) return;
  const now = new Date().toISOString();
  db.transaction(() => {
    if (hasAutomation) {
      db.prepare("UPDATE automation_workflows SET enabled=0,updatedAt=?").run(now);
      db.prepare("UPDATE automation_schedules SET enabled=0,lockedBy=NULL,lockedAt=NULL").run();
      db.prepare("UPDATE automation_webhooks SET enabled=0").run();
      db.prepare(`UPDATE automation_workflow_runs SET status='interrupted',finishedAt=?,errorCode='RESTORE_INTERRUPTED',errorMessage='备份恢复后自动化需要重新确认',requiresAttention=1,lockedBy=NULL,lockedAt=NULL WHERE status IN ('queued','running','waiting')`).run(now);
    }
    // 备份恢复后禁止原订阅在新环境自动推送用户任务。
    if (hasTaskDigest) {
      db.prepare("UPDATE task_digest_settings SET morningEnabled=0,eveningEnabled=0,dueEnabled=0,updatedAt=datetime('now')").run();
    }
  })();
}
