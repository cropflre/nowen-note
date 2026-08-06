import crypto from "crypto";
import { getDb } from "../db/schema";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import { nowExpression } from "../db/dialect";

export const NOWEN_INSTANCE_ID_KEY = "nowen_instance_id";

function asyncNowExpression(): string {
  try {
    return nowExpression(getDatabaseDialect());
  } catch {
    return nowExpression("sqlite");
  }
}

export const nowenInstanceIdentityRepository = {
  /** Legacy SQLite-only path used by module-load compatibility code. */
  getOrCreateSync(): string {
    const db = getDb();
    const existing = db
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get(NOWEN_INSTANCE_ID_KEY) as { value: string } | undefined;
    if (existing?.value) return existing.value;

    const generated = crypto.randomUUID();
    db.prepare(`
      INSERT INTO system_settings (key, value, "updatedAt")
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO NOTHING
    `).run(NOWEN_INSTANCE_ID_KEY, generated);
    const persisted = db
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get(NOWEN_INSTANCE_ID_KEY) as { value: string } | undefined;
    return persisted?.value || generated;
  },

  async getOrCreateAsync(): Promise<string> {
    const adapter = getDatabaseAdapter();
    const existing = await adapter.queryOne<{ value: string }>(
      "SELECT value FROM system_settings WHERE key = ?",
      [NOWEN_INSTANCE_ID_KEY],
    );
    if (existing?.value) return existing.value;

    const generated = crypto.randomUUID();
    await adapter.execute(
      `INSERT INTO system_settings (key, value, "updatedAt")
       VALUES (?, ?, ${asyncNowExpression()})
       ON CONFLICT(key) DO NOTHING`,
      [NOWEN_INSTANCE_ID_KEY, generated],
    );
    const persisted = await adapter.queryOne<{ value: string }>(
      "SELECT value FROM system_settings WHERE key = ?",
      [NOWEN_INSTANCE_ID_KEY],
    );
    return persisted?.value || generated;
  },
};
