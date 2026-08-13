import { getDatabaseAdapter } from "../db/runtime";

export interface UserSecurityVersionRecord {
  tokenVersion: number;
}

/** Security-sensitive user metadata shared by sudo/admin route guards. */
export const userSecurityRepository = {
  async getTokenVersionAsync(userId: string): Promise<number> {
    const row = await getDatabaseAdapter().queryOne<UserSecurityVersionRecord>(
      'SELECT "tokenVersion" FROM users WHERE id = ?',
      [userId],
    );
    return row?.tokenVersion ?? 0;
  },
};
