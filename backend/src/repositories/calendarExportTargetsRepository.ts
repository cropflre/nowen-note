/**
 * Calendar Export Targets Repository
 *
 * 职责：
 * - 封装 calendar_export_targets 表的所有数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import type {
  CalendarExportTargetRecord,
  CalendarExportTargetRecordBoolean,
  CreateCalendarExportTargetInput,
  UpdateCalendarExportTargetInput,
  UpdateCalendarExportTargetStatusInput,
} from "./types";

/** 将 SQLite 0/1 转换为 boolean */
function toBoolean(row: CalendarExportTargetRecord): CalendarExportTargetRecordBoolean {
  return {
    ...row,
    enabled: !!row.enabled,
  };
}

export const calendarExportTargetsRepository = {
  /**
   * 列出用户的所有 export targets
   */
  listByUser(userId: string): CalendarExportTargetRecordBoolean[] {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM calendar_export_targets WHERE userId = ? ORDER BY createdAt DESC",
      )
      .all(userId) as CalendarExportTargetRecord[];
    return rows.map(toBoolean);
  },

  /**
   * 获取单个 export target（含 userId 校验）
   */
  getByIdAndUser(id: string, userId: string): CalendarExportTargetRecordBoolean | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM calendar_export_targets WHERE id = ? AND userId = ?")
      .get(id, userId) as CalendarExportTargetRecord | undefined;
    return row ? toBoolean(row) : undefined;
  },

  /**
   * 列出所有启用的 export targets
   */
  listEnabled(): CalendarExportTargetRecordBoolean[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM calendar_export_targets WHERE enabled = 1")
      .all() as CalendarExportTargetRecord[];
    return rows.map(toBoolean);
  },

  /**
   * 创建 export target
   */
  create(input: CreateCalendarExportTargetInput): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO calendar_export_targets (id, userId, feedId, type, enabled, name, configJson)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.userId,
      input.feedId,
      input.type,
      input.enabled,
      input.name,
      input.configJson,
    );
  },

  /**
   * 更新 export target（按 id + userId）
   */
  updateByIdAndUser(id: string, userId: string, patch: UpdateCalendarExportTargetInput): void {
    const db = getDb();
    const updates: string[] = [];
    const params: any[] = [];

    if (patch.name !== undefined) {
      updates.push("name = ?");
      params.push(patch.name);
    }
    if (patch.enabled !== undefined) {
      updates.push("enabled = ?");
      params.push(patch.enabled);
    }
    if (patch.configJson !== undefined) {
      updates.push("configJson = ?");
      params.push(patch.configJson);
    }

    if (updates.length === 0) return;

    updates.push("updatedAt = datetime('now')");
    params.push(id, userId);

    db.prepare(
      `UPDATE calendar_export_targets SET ${updates.join(", ")} WHERE id = ? AND userId = ?`,
    ).run(...params);
  },

  /**
   * 更新 export target 状态（按 id，不含 userId 校验）
   *
   * 注意：此方法用于更新导出状态，由内部调度器调用，不做 userId 校验。
   */
  updateStatusById(id: string, patch: UpdateCalendarExportTargetStatusInput): void {
    const db = getDb();
    const updates: string[] = ["lastExportAt = datetime('now')", "updatedAt = datetime('now')"];
    const params: any[] = [];

    if (patch.lastStatus !== undefined) {
      updates.push("lastStatus = ?");
      params.push(patch.lastStatus);
    }

    if (patch.lastStatus === "success" && patch.publicUrl) {
      updates.push("publicUrl = ?");
      params.push(patch.publicUrl);
      updates.push("lastError = NULL");
    } else if (patch.lastStatus === "error" && patch.lastError) {
      updates.push("lastError = ?");
      params.push(patch.lastError);
    }

    params.push(id);

    db.prepare(
      `UPDATE calendar_export_targets SET ${updates.join(", ")} WHERE id = ?`,
    ).run(...params);
  },

  /**
   * 删除 export target（按 id + userId）
   */
  deleteByIdAndUser(id: string, userId: string): boolean {
    const db = getDb();
    const result = db
      .prepare("DELETE FROM calendar_export_targets WHERE id = ? AND userId = ?")
      .run(id, userId);
    return result.changes > 0;
  },
};
