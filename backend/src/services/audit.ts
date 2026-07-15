/**
 * Nowen Note 审计日志系统
 *
 * 记录所有重要操作，用于安全审计和问题追踪。
 *
 * 日志类别：
 *  - auth    — 登录/登出/密码修改
 *  - note    — 笔记 CRUD
 *  - share   — 单篇分享创建/访问
 *  - notebook_publication — 笔记本知识站发布/撤销
 *  - ai      — AI 调用
 *  - plugin  — 插件执行
 *  - system  — 设置修改/备份恢复
 */

import crypto from "crypto";
import { auditRepository } from "../repositories/auditRepository";

// ===== 类型 =====

export type AuditCategory = "auth" | "note" | "notebook" | "notebook_publication" | "tag" | "task" | "share" | "ai" | "plugin" | "system";
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
  auditRepository.init();
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
      const details = typeof params.details === "object"
        ? JSON.stringify(params.details)
        : (params.details || "");

      auditRepository.insert({
        id: crypto.randomUUID(),
        userId: params.userId || "",
        category: params.category,
        action: params.action,
        level: params.level || "info",
        targetType: params.targetType || "",
        targetId: params.targetId || "",
        details: details.slice(0, 5000),
        ip: params.ip || "",
        userAgent: params.userAgent || "",
      });
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
    return auditRepository.query(params) as { logs: AuditEntry[]; total: number };
  }

  /** 清理过期日志（保留指定天数） */
  cleanup(retentionDays: number = 90): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    return auditRepository.cleanupBefore(cutoff);
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
