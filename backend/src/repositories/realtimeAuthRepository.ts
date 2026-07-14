import { getDb } from "../db/schema";

export interface RealtimeAuthUserRecord {
  id: string;
  username: string;
  isDisabled: number;
  tokenVersion: number;
}

/** SQLite compatibility boundary for WebSocket upgrade authentication. */
export const realtimeAuthRepository = {
  findById(userId: string): RealtimeAuthUserRecord | undefined {
    return getDb()
      .prepare(
        'SELECT id, username, "isDisabled", "tokenVersion" FROM users WHERE id = ?',
      )
      .get(userId) as RealtimeAuthUserRecord | undefined;
  },
};
