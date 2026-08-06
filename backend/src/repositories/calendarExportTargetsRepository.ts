/**
 * Calendar Export Targets Repository
 *
 * 同步方法保留给现有 SQLite 调用链；async 方法通过数据库运行时 Provider
 * 在 SQLite / PostgreSQL 下共用同一业务接口。
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";
import type {
  CalendarExportTargetRecord,
  CalendarExportTargetRecordBoolean,
  CreateCalendarExportTargetInput,
  UpdateCalendarExportTargetInput,
  UpdateCalendarExportTargetStatusInput,
} from "./types";

function getAdapter() {
  return getDatabaseAdapter();
}

function toBoolean(row: CalendarExportTargetRecord): CalendarExportTargetRecordBoolean {
  return {
    ...row,
    enabled: !!row.enabled,
  };
}

export const calendarExportTargetsRepository = {
  listByUser(userId: string): CalendarExportTargetRecordBoolean[] {
    const rows = getDb()
      .prepare('SELECT * FROM calendar_export_targets WHERE "userId" = ? ORDER BY "createdAt" DESC')
      .all(userId) as CalendarExportTargetRecord[];
    return rows.map(toBoolean);
  },

  getByIdAndUser(id: string, userId: string): CalendarExportTargetRecordBoolean | undefined {
    const row = getDb()
      .prepare('SELECT * FROM calendar_export_targets WHERE id = ? AND "userId" = ?')
      .get(id, userId) as CalendarExportTargetRecord | undefined;
    return row ? toBoolean(row) : undefined;
  },

  listEnabled(): CalendarExportTargetRecordBoolean[] {
    const rows = getDb()
      .prepare("SELECT * FROM calendar_export_targets WHERE enabled = 1")
      .all() as CalendarExportTargetRecord[];
    return rows.map(toBoolean);
  },

  create(input: CreateCalendarExportTargetInput): void {
    getDb().prepare(
      `INSERT INTO calendar_export_targets (id, "userId", "feedId", type, enabled, name, "configJson")
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

  updateByIdAndUser(id: string, userId: string, patch: UpdateCalendarExportTargetInput): void {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      updates.push("name = ?");
      params.push(patch.name);
    }
    if (patch.enabled !== undefined) {
      updates.push("enabled = ?");
      params.push(patch.enabled);
    }
    if (patch.configJson !== undefined) {
      updates.push('"configJson" = ?');
      params.push(patch.configJson);
    }
    if (updates.length === 0) return;

    updates.push('"updatedAt" = datetime(\'now\')');
    params.push(id, userId);
    getDb().prepare(
      `UPDATE calendar_export_targets SET ${updates.join(", ")} WHERE id = ? AND userId = ?`,
    ).run(...params);
  },

  updateStatusById(id: string, patch: UpdateCalendarExportTargetStatusInput): void {
    const updates: string[] = ['"lastExportAt" = datetime(\'now\')', "updatedAt = datetime('now')"];
    const params: unknown[] = [];

    if (patch.lastStatus !== undefined) {
      updates.push('"lastStatus" = ?');
      params.push(patch.lastStatus);
    }
    if (patch.lastStatus === "success" && patch.publicUrl) {
      updates.push('"publicUrl" = ?');
      params.push(patch.publicUrl);
      updates.push('"lastError" = NULL');
    } else if (patch.lastStatus === "error" && patch.lastError) {
      updates.push('"lastError" = ?');
      params.push(patch.lastError);
    }

    params.push(id);
    getDb().prepare(
      `UPDATE calendar_export_targets SET ${updates.join(", ")} WHERE id = ?`,
    ).run(...params);
  },

  deleteByIdAndUser(id: string, userId: string): boolean {
    return getDb().prepare(
      "DELETE FROM calendar_export_targets WHERE id = ? AND userId = ?",
    ).run(id, userId).changes > 0;
  },

  async listByUserAsync(userId: string): Promise<CalendarExportTargetRecordBoolean[]> {
    const rows = await getAdapter().queryMany<CalendarExportTargetRecord>(
      'SELECT * FROM calendar_export_targets WHERE "userId" = ? ORDER BY "createdAt" DESC',
      [userId],
    );
    return rows.map(toBoolean);
  },

  async getByIdAndUserAsync(id: string, userId: string): Promise<CalendarExportTargetRecordBoolean | undefined> {
    const row = await getAdapter().queryOne<CalendarExportTargetRecord>(
      'SELECT * FROM calendar_export_targets WHERE id = ? AND "userId" = ?',
      [id, userId],
    );
    return row ? toBoolean(row) : undefined;
  },

  async listEnabledAsync(): Promise<CalendarExportTargetRecordBoolean[]> {
    const rows = await getAdapter().queryMany<CalendarExportTargetRecord>(
      "SELECT * FROM calendar_export_targets WHERE enabled = 1",
    );
    return rows.map(toBoolean);
  },

  async createAsync(input: CreateCalendarExportTargetInput): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO calendar_export_targets (id, "userId", "feedId", type, enabled, name, "configJson")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.userId, input.feedId, input.type, input.enabled, input.name, input.configJson],
    );
  },

  async updateByIdAndUserAsync(id: string, userId: string, patch: UpdateCalendarExportTargetInput): Promise<void> {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      updates.push("name = ?");
      params.push(patch.name);
    }
    if (patch.enabled !== undefined) {
      updates.push("enabled = ?");
      params.push(patch.enabled);
    }
    if (patch.configJson !== undefined) {
      updates.push('"configJson" = ?');
      params.push(patch.configJson);
    }
    if (updates.length === 0) return;

    updates.push('"updatedAt" = datetime(\'now\')');
    params.push(id, userId);
    await getAdapter().execute(
      `UPDATE calendar_export_targets SET ${updates.join(", ")} WHERE id = ? AND userId = ?`,
      params,
    );
  },

  async updateStatusByIdAsync(id: string, patch: UpdateCalendarExportTargetStatusInput): Promise<void> {
    const updates: string[] = ['"lastExportAt" = datetime(\'now\')', "updatedAt = datetime('now')"];
    const params: unknown[] = [];

    if (patch.lastStatus !== undefined) {
      updates.push('"lastStatus" = ?');
      params.push(patch.lastStatus);
    }
    if (patch.lastStatus === "success" && patch.publicUrl) {
      updates.push('"publicUrl" = ?');
      params.push(patch.publicUrl);
      updates.push('"lastError" = NULL');
    } else if (patch.lastStatus === "error" && patch.lastError) {
      updates.push('"lastError" = ?');
      params.push(patch.lastError);
    }

    params.push(id);
    await getAdapter().execute(
      `UPDATE calendar_export_targets SET ${updates.join(", ")} WHERE id = ?`,
      params,
    );
  },

  async deleteByIdAndUserAsync(id: string, userId: string): Promise<boolean> {
    const result = await getAdapter().execute(
      "DELETE FROM calendar_export_targets WHERE id = ? AND userId = ?",
      [id, userId],
    );
    return result.changes > 0;
  },
};
