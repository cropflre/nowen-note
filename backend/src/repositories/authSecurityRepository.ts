export interface AuthSecurityStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

export interface AuthSecurityDatabase {
  prepare(sql: string): AuthSecurityStatement;
}

export interface AccountLockRecord {
  id: string;
  failedLoginAttempts: number;
  lastFailedLoginAt: string | null;
  lockedUntil: string | null;
}

/**
 * SQLite compatibility boundary for synchronous authentication security flows.
 * Runtime-wide PostgreSQL conversion is handled by #249 after route/service
 * direct access has been removed by #248.
 */
export const authSecurityRepository = {
  getAccountLock(db: AuthSecurityDatabase, userId: string): AccountLockRecord | undefined {
    return db
      .prepare(
        'SELECT id, "failedLoginAttempts", "lastFailedLoginAt", "lockedUntil" FROM users WHERE id = ?',
      )
      .get(userId) as AccountLockRecord | undefined;
  },

  clearExpiredLock(db: AuthSecurityDatabase, userId: string): void {
    db.prepare(
      'UPDATE users SET "lockedUntil" = NULL, "failedLoginAttempts" = 0 WHERE id = ?',
    ).run(userId);
  },

  clearFailedAttempts(db: AuthSecurityDatabase, userId: string): void {
    db.prepare('UPDATE users SET "failedLoginAttempts" = 0 WHERE id = ?').run(userId);
  },

  getFailedLoginAttempts(db: AuthSecurityDatabase, userId: string): number | null {
    const row = db
      .prepare('SELECT "failedLoginAttempts" FROM users WHERE id = ?')
      .get(userId) as { failedLoginAttempts: number } | undefined;
    return row?.failedLoginAttempts ?? null;
  },

  recordLoginFailure(
    db: AuthSecurityDatabase,
    params: {
      userId: string;
      attempts: number;
      failedAt: string;
      lockedUntil: string | null;
    },
  ): void {
    if (params.lockedUntil) {
      db.prepare(
        `UPDATE users
         SET "failedLoginAttempts" = ?, "lastFailedLoginAt" = ?, "lockedUntil" = ?
         WHERE id = ?`,
      ).run(params.attempts, params.failedAt, params.lockedUntil, params.userId);
      return;
    }

    db.prepare(
      `UPDATE users
       SET "failedLoginAttempts" = ?, "lastFailedLoginAt" = ?
       WHERE id = ?`,
    ).run(params.attempts, params.failedAt, params.userId);
  },

  resetLoginFailure(db: AuthSecurityDatabase, userId: string): void {
    db.prepare(
      `UPDATE users
       SET "failedLoginAttempts" = 0, "lastFailedLoginAt" = NULL, "lockedUntil" = NULL
       WHERE id = ?`,
    ).run(userId);
  },

  bumpTokenVersion(db: AuthSecurityDatabase, userId: string): number {
    db.prepare('UPDATE users SET "tokenVersion" = "tokenVersion" + 1 WHERE id = ?').run(userId);
    const row = db
      .prepare('SELECT "tokenVersion" FROM users WHERE id = ?')
      .get(userId) as { tokenVersion: number } | undefined;
    return row?.tokenVersion ?? 0;
  },
};
