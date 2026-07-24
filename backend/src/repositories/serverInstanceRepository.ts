import { getDatabaseAdapter } from "../db/runtime";

const SERVER_INSTANCE_KEY = "server_instance_id";

/**
 * Stable server identity stored in system_settings.
 *
 * `createIfAbsentAsync` deliberately uses DO NOTHING rather than an upsert so
 * concurrent processes cannot replace an already-issued instance id.
 */
export const serverInstanceRepository = {
  async getAsync(): Promise<string | undefined> {
    const row = await getDatabaseAdapter().queryOne<{ value: string }>(
      "SELECT value FROM system_settings WHERE key = ?",
      [SERVER_INSTANCE_KEY],
    );
    return row?.value || undefined;
  },

  async createIfAbsentAsync(instanceId: string): Promise<void> {
    await getDatabaseAdapter().execute(
      `INSERT INTO system_settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`,
      [SERVER_INSTANCE_KEY, instanceId],
    );
  },
};
