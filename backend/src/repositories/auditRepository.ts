import { getDb } from "../db/schema";

export interface AuditLogRecord {
  id: string;
  userId: string;
  category: string;
  action: string;
  level: string;
  targetType: string;
  targetId: string;
  details: string;
  ip: string;
  userAgent: string;
  createdAt: string;
}

export interface AuditLogInsert {
  id: string;
  userId: string;
  category: string;
  action: string;
  level: string;
  targetType: string;
  targetId: string;
  details: string;
  ip: string;
  userAgent: string;
}

export interface AuditLogQuery {
  userId?: string;
  category?: string;
  level?: string;
  targetType?: string;
  targetId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export const auditRepository = {
  init(): void {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        targetType TEXT DEFAULT '',
        targetId TEXT DEFAULT '',
        details TEXT DEFAULT '',
        ip TEXT DEFAULT '',
        userAgent TEXT DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(userId);
      CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_logs(category);
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(targetType, targetId);
    `);
  },

  insert(entry: AuditLogInsert): void {
    getDb()
      .prepare(`
        INSERT INTO audit_logs (
          id, userId, category, action, level, targetType, targetId, details, ip, userAgent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.id,
        entry.userId,
        entry.category,
        entry.action,
        entry.level,
        entry.targetType,
        entry.targetId,
        entry.details,
        entry.ip,
        entry.userAgent,
      );
  },

  query(params: AuditLogQuery): { logs: AuditLogRecord[]; total: number } {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.userId) {
      conditions.push("userId = ?");
      values.push(params.userId);
    }
    if (params.category) {
      conditions.push("category = ?");
      values.push(params.category);
    }
    if (params.level) {
      conditions.push("level = ?");
      values.push(params.level);
    }
    if (params.targetType) {
      conditions.push("targetType = ?");
      values.push(params.targetType);
    }
    if (params.targetId) {
      conditions.push("targetId = ?");
      values.push(params.targetId);
    }
    if (params.dateFrom) {
      conditions.push("createdAt >= ?");
      values.push(params.dateFrom);
    }
    if (params.dateTo) {
      conditions.push("createdAt <= ?");
      values.push(params.dateTo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(params.limit || 50, 200);
    const offset = params.offset || 0;
    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`)
      .get(...values) as { count: number };
    const logs = db
      .prepare(`SELECT * FROM audit_logs ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as AuditLogRecord[];

    return { logs, total: totalRow.count };
  },

  cleanupBefore(cutoff: string): number {
    return getDb()
      .prepare("DELETE FROM audit_logs WHERE createdAt < ?")
      .run(cutoff).changes;
  },
};
