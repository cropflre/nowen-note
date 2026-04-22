/**
 * Nowen Note 审计日志系统
 *
 * 记录所有重要操作，用于安全审计和问题追踪。
 *
 * 日志类别：
 *  - auth    — 登录/登出/密码修改
 *  - note    — 笔记 CRUD
 *  - share   — 分享创建/访问
 *  - ai      — AI 调用
 *  - plugin  — 插件执行
 *  - system  — 设置修改/备份恢复
 */

import { getDb } from "../db/schema.js";
import crypto from "crypto";

// ===== 类型 =====

export type AuditCategory = "auth" | "note" | "notebook" | "tag" | "task" | "share" | "ai" | "plugin" | "system";
export type AuditLevel = "info" | "warn" | "error";

export interface AuditEntry {
  id: string;
  userId: string;
  category: AuditCategory;
  action: string;
  level: AuditLevel;
  targetType: string;
  targetId: string;
  details: string;
  ip: string;
  userAgent: string;
  createdAt: string;
}

// ===== 数据库迁移 =====

export function initAuditTables(): void {
  const db = getDb();

  db.exec(`
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
}

// ===== 审计日志记录器 =====

class AuditLogger {
  private static instance: AuditLogger;

  static getInstance(): AuditLogger {
    if (!this.instance) {
      this.instance = new AuditLogger();
    }
    return this.instance;
  }

  /** 记录审计日志 */
  log(params: {
    userId: string;
    category: AuditCategory;
    action: string;
    level?: AuditLevel;
    targetType?: string;
    targetId?: string;
    details?: string | Record<string, any>;
    ip?: string;
    userAgent?: string;
  }): void {
    try {
      const db = getDb();
      const id = crypto.randomUUID();
      const details = typeof params.details === "object"
        ? JSON.stringify(params.details)
        : (params.details || "");

      db.prepare(`
        INSERT INTO audit_logs (id, userId, category, action, level, targetType, targetId, details, ip, userAgent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        params.userId || "",
        params.category,
        params.action,
        params.level || "info",
        params.targetType || "",
        params.targetId || "",
        details.slice(0, 5000), // 限制大小
        params.ip || "",
        params.userAgent || "",
      );
    } catch (err: any) {
      console.error("[Audit] 日志记录失败:", err.message);
    }
  }

  /** 查询审计日志 */
  query(params: {
    userId?: string;
    category?: AuditCategory;
    level?: AuditLevel;
    targetType?: string;
    targetId?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  }): { logs: AuditEntry[]; total: number } {
    const db = getDb();
    const conditions: string[] = [];
    const values: any[] = [];

    if (params.userId) { conditions.push("userId = ?"); values.push(params.userId); }
    if (params.category) { conditions.push("category = ?"); values.push(params.category); }
    if (params.level) { conditions.push("level = ?"); values.push(params.level); }
    if (params.targetType) { conditions.push("targetType = ?"); values.push(params.targetType); }
    if (params.targetId) { conditions.push("targetId = ?"); values.push(params.targetId); }
    if (params.dateFrom) { conditions.push("createdAt >= ?"); values.push(params.dateFrom); }
    if (params.dateTo) { conditions.push("createdAt <= ?"); values.push(params.dateTo); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(params.limit || 50, 200);
    const offset = params.offset || 0;

    const total = (db.prepare(`SELECT COUNT(*) as count FROM audit_logs ${where}`).get(...values) as any).count;
    const logs = db.prepare(
      `SELECT * FROM audit_logs ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`
    ).all(...values, limit, offset) as AuditEntry[];

    return { logs, total };
  }

  /** 清理过期日志（保留指定天数） */
  cleanup(retentionDays: number = 90): number {
    const db = getDb();
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const result = db.prepare("DELETE FROM audit_logs WHERE createdAt < ?").run(cutoff);
    return result.changes;
  }
}

// ===== 导出 =====

export const auditLogger = AuditLogger.getInstance();

/** 便捷方法：记录审计日志 */
export function logAudit(
  userId: string,
  category: AuditCategory,
  action: string,
  details?: string | Record<string, any>,
  extra?: { targetType?: string; targetId?: string; ip?: string; userAgent?: string; level?: AuditLevel }
): void {
  auditLogger.log({
    userId,
    category,
    action,
    details,
    ...(extra || {}),
  });
}
